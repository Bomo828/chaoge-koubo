import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 3197;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "merchant-studio-smoke-"));
const child = spawn(process.execPath, [".next/standalone/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    APP_DATA_DIR: dataDir,
    ENABLE_DEMO_ACCOUNT: "true",
    DEMO_USERNAME: "demo",
    DEMO_PASSWORD: "123456",
    BOOTSTRAP_ADMIN_USERNAME: "admin",
    BOOTSTRAP_ADMIN_PASSWORD: "Admin123456!",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

async function waitUntilReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`本地服务没有按时启动。\n${logs}`);
}

try {
  await waitUntilReady();
  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /爆点实验室/);

  const login = await fetch(`${baseUrl}/api/auth/account`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "demo", password: "123456", returnTo: "/studio" }),
  });
  assert.equal(login.status, 303);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.includes("merchant_studio_session="));

  const studio = await fetch(`${baseUrl}/studio`, { headers: { cookie } });
  assert.equal(studio.status, 200);
  assert.match(await studio.text(), /把灵感/);

  const [wallet, tasks] = await Promise.all([
    fetch(`${baseUrl}/api/member/wallet`, { headers: { cookie } }),
    fetch(`${baseUrl}/api/member/tasks`, { headers: { cookie } }),
  ]);
  assert.equal(wallet.status, 200);
  assert.equal(tasks.status, 200);

  const marketList = await fetch(`${baseUrl}/api/member/market/accounts`, { headers: { cookie } });
  assert.equal(marketList.status, 200);
  assert.deepEqual((await marketList.json()).items, []);

  const marketAdd = await fetch(`${baseUrl}/api/member/market/accounts`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ sourceUrl: "https://www.douyin.com/user/MS4wLjABAAAA_smoke_test" }),
  });
  assert.equal(marketAdd.status, 201);
  const marketAccount = (await marketAdd.json()).item;
  assert.equal(marketAccount.status, "pending");
  assert.ok(marketAccount.id);

  const marketSync = await fetch(`${baseUrl}/api/member/market/accounts/${encodeURIComponent(marketAccount.id)}`, {
    method: "PATCH",
    headers: { cookie },
  });
  assert.equal(marketSync.status, 200);
  assert.equal((await marketSync.json()).item.status, "syncing");
  console.log("本地冒烟测试通过：首页、登录、工作台、积分、任务与市场动态接口均正常。");
} finally {
  child.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}
