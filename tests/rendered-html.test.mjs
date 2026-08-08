import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/", authenticated = false) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: {
        accept: "text/html",
        ...(authenticated ? { cookie: "merchant_studio_member=demo-member-001" } : {}),
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("keeps the homepage public before member login", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /会员登录/);
  assert.match(html, /进入工作台/);
});

test("renders the dynamic merchant homepage for a member", async () => {
  const response = await render("/", true);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /商装工坊/);
  assert.match(html, /AI 商家创作工作台/);
  assert.doesNotMatch(html, /店铺装修/);
  assert.match(html, /图片设计/);
  assert.match(html, /短视频/);
});

test("opens login on the homepage and protects the studio route", async () => {
  const [login, studioRedirect, studio] = await Promise.all([
    render("/login"),
    render("/studio"),
    render("/studio", true),
  ]);
  assert.equal(login.status, 307);
  assert.match(login.headers.get("location") ?? "", /auth=login/);
  assert.equal(studioRedirect.status, 307);
  assert.equal(studio.status, 200);
  assert.match(await studio.text(), /今天想创作点什么/);
});
