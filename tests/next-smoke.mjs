import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 3197;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "merchant-studio-smoke-"));
const collectorPort = 3198;
const collectorBaseUrl = `http://127.0.0.1:${collectorPort}`;
const collector = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.url === "/open/v1/access_token") {
    response.end(JSON.stringify({ code: 0, data: { access_token: "smoke_chanjing_token" } }));
    return;
  }
  if (request.url === "/open/v1/user_duration") {
    response.end(JSON.stringify({ code: 0, data: { resi_total_bean: 100000 } }));
    return;
  }
  if (request.url?.startsWith("/open/v1/list_common_audio")) {
    const page = Number(new URL(request.url, collectorBaseUrl).searchParams.get("page") || 1);
    const voiceCount = page === 1 ? 50 : page === 2 ? 41 : 0;
    response.end(JSON.stringify({
      code: 0,
      data: {
        total: 91,
        list: Array.from({ length: voiceCount }, (_, index) => ({
          id: `smoke_voice_${page}_${index}`,
          name: page === 1 && index === 0 ? "中年专家" : `开放声音 ${page}-${index + 1}`,
          audition: `https://example.com/voice-${page}-${index + 1}.mp3`,
          gender: index % 2 ? "女" : "男",
        })),
      },
    }));
    return;
  }
  if (request.url === "/open/v1/create_audio_task") {
    response.end(JSON.stringify({ code: 0, data: { task_id: "smoke_speech_task" } }));
    return;
  }
  if (request.url === "/open/v1/audio_task_state") {
    response.end(JSON.stringify({
      code: 0,
      data: {
        status: 9,
        full: { url: "https://example.com/speech.mp3", duration: 3.2 },
        subtitles: [
          { start_time: 0, end_time: 1400, subtitle: "欢迎来到" },
          { start_time: 1400, end_time: 3200, subtitle: "素材智能成片" },
        ],
      },
    }));
    return;
  }
  if (request.url?.startsWith("/web/api/v2/user/info/")) {
    response.end(JSON.stringify({
      status_code: 0,
      user_info: {
        nickname: "冒烟测试账号",
        unique_id: "smoke_test",
        signature: "用于验证市场动态同步",
        follower_count: 128,
        following_count: 16,
        total_favorited: 256,
        aweme_count: 1,
        avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] },
      },
    }));
    return;
  }
  if (request.url?.startsWith("/api/douyin/web/fetch_user_post_videos")) {
    response.end(JSON.stringify({
      data: {
        aweme_list: [{
          aweme_id: "smoke_aweme_1",
          desc: "市场动态冒烟测试作品",
          duration: 12_000,
          create_time: 1_725_000_000,
          video: { cover: { url_list: ["https://example.com/cover.jpg"] } },
          share_info: { share_url: "https://www.douyin.com/video/smoke_aweme_1" },
          statistics: { digg_count: 88, comment_count: 6, share_count: 3, collect_count: 9 },
        }],
      },
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => collector.listen(collectorPort, "127.0.0.1", resolve));
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
    DOUYIN_PROFILE_API_BASE_URL: collectorBaseUrl,
    DOUYIN_COLLECTOR_BASE_URL: collectorBaseUrl,
    CHANJING_BASE_URL: collectorBaseUrl,
    CHANJING_APP_ID: "smoke-app-id",
    CHANJING_SECRET_KEY: "smoke-secret-key",
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

  const [wallet, tasks, photoVideoMps] = await Promise.all([
    fetch(`${baseUrl}/api/member/wallet`, { headers: { cookie } }),
    fetch(`${baseUrl}/api/member/tasks`, { headers: { cookie } }),
    fetch(`${baseUrl}/api/ai/photo-video/mps`, { headers: { cookie } }),
  ]);
  assert.equal(wallet.status, 200);
  assert.equal(tasks.status, 200);
  assert.equal(photoVideoMps.status, 200);
  assert.equal(typeof (await photoVideoMps.json()).configured, "boolean");

  const commonVoices = await fetch(`${baseUrl}/api/ai/common-voices`, { headers: { cookie } });
  assert.equal(commonVoices.status, 200);
  const commonVoiceItems = (await commonVoices.json()).voices;
  assert.equal(commonVoiceItems.length, 91);
  assert.equal(commonVoiceItems[0].name, "中年专家");

  const speechCreate = await fetch(`${baseUrl}/api/ai/speech`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      voiceId: commonVoiceItems[0].voiceId,
      text: "欢迎使用素材智能成片",
      speed: 1,
      requestId: "smoke_photo_speech",
    }),
  });
  assert.equal(speechCreate.status, 200);
  const speechTask = await speechCreate.json();
  const speechStatus = await fetch(`${baseUrl}/api/ai/speech?task_id=${speechTask.taskId}&request_id=${speechTask.requestId}&estimated_points=${speechTask.estimatedPoints}`, { headers: { cookie } });
  assert.equal(speechStatus.status, 200);
  const speechResult = await speechStatus.json();
  assert.equal(speechResult.state, "success");
  assert.equal(speechResult.captions.length, 2);
  assert.equal(speechResult.captions[1].end, 3.2);

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
  assert.equal(marketAccount.status, "ready");
  assert.equal(marketAccount.nickname, "冒烟测试账号");
  assert.equal(marketAccount.videos.length, 1);
  assert.ok(marketAccount.id);

  const marketSync = await fetch(`${baseUrl}/api/member/market/accounts/${encodeURIComponent(marketAccount.id)}`, {
    method: "PATCH",
    headers: { cookie },
  });
  assert.equal(marketSync.status, 200);
  const syncedAccount = (await marketSync.json()).item;
  assert.equal(syncedAccount.status, "ready");
  assert.equal(syncedAccount.videos[0].likeCount, 88);
  console.log("本地冒烟测试通过：首页、登录、工作台、积分、任务、开放声音、字幕时间轴、素材成片转码与市场动态接口均正常。");
} finally {
  child.kill("SIGTERM");
  collector.close();
  rmSync(dataDir, { recursive: true, force: true });
}
