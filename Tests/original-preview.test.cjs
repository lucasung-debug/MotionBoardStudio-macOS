"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createPreviewServer, previewHTML, BANNER } = require("../scripts/preview-original.cjs");
const createBridge = require("../preview/original-bridge.js");

function request(port, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, ...options }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}

test("original UI is preserved with only explicit preview injections", () => {
  const original = fs.readFileSync(path.join(__dirname, "../upstream/MotionBoardStudio-0.3.2/renderer/index.html"), "utf8");
  const html = previewHTML();
  assert.ok(html.includes(BANNER));
  assert.ok(html.indexOf('/original-bridge.js') < html.indexOf('src="app.js"'));
  const restored = html.replace('<link rel="stylesheet" href="/original.css">\n', "")
    .replace('\n<aside id="original-preview-banner" role="status">' + BANNER + "</aside>", "")
    .replace('<script src="/original-bridge.js"></script>\n  ', "");
  assert.equal(restored, original);
});

test("preview adapter refuses authentication, generation, filesystem changes, and installation", async () => {
  const api = createBridge(null);
  for (const call of [api.auth.login, api.auth.logout, api.claude.loginStart, api.claude.loginComplete, api.claude.loginCancel, api.claude.logout, ...["guide", "spec", "board", "video", "pickMusic", "installFfmpeg", "videoSaveAs", "videoReveal", "cancel", "historyGet", "historyRemove", "imageSaveAs", "imageImport", "reveal", "openDataDir", "openExternal"].map(name => api[name])]) {
    assert.equal(typeof call, "function");
    const response = await call("test input");
    assert.equal(response.ok, false); assert.equal(response.code, "PREVIEW_UNAVAILABLE");
  }
  assert.equal((await api.auth.status()).status.loggedIn, false);
  assert.equal((await api.claude.status()).status.loggedIn, false);
  assert.deepEqual((await api.history()).entries, []);
  const env = await api.env();
  assert.equal(env.ffmpeg, null); assert.equal(env.capabilities.authentication, false);
  for (const event of [api.onProgress, api.onAuth, api.onClaudeAuth]) assert.equal(typeof event(() => {}), "function");
});

test("server serves exact assets and refuses unlisted paths, writes, and foreign hosts", async t => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  for (const file of ["app.js", "styles.css"]) {
    const response = await request(port, "/" + file);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, fs.readFileSync(path.join(__dirname, "../upstream/MotionBoardStudio-0.3.2/renderer", file)));
  }
  for (const route of ["/", "/index.html", "/original.css", "/original-bridge.js"]) assert.equal((await request(port, route)).status, 200);
  for (const route of ["/package.json", "/.git/config", "/../README.md", "/%2e%2e/README.md", "/upstream/", "/app.js/other"]) assert.equal((await request(port, route)).status, 404);
  assert.equal((await request(port, "/", { method: "POST" })).status, 405);
  assert.equal((await request(port, "/", { headers: { Host: "example.invalid" } })).status, 403);
  assert.match((await request(port, "/")).headers["content-security-policy"], /connect-src 'none'/);
});
