"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../Runtime/store.cjs");
const { createSubscriptionConnections } = require("../Runtime/subscription-video-providers.cjs");

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mbs-subscriptions-"));
  const store = createStore(directory); await store.ensureDirs();
  await store.writeState({ unrelatedForm: "preserve" });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], native = [], controls = { loggedIn: true, installed: true, choice: 1 };
  const who = { authMode: "oauth", availableModels: { image_to_video: { models: [{ model: "kling-video-v2_6",
    arguments: [{ name: "prompt" }, { name: "duration", allowedValues: ["5", "10"] },
      { name: "resolution", allowedValues: ["720p", "1080p"] }, { name: "imageCount", allowedValues: ["1"] },
      { name: "enable_audio", allowedValues: ["false"] }], inputs: [{ name: "first_image", required: true }] }] } } };
  const executable = path.join(directory, "Kling's CLI $literal");
  const connections = createSubscriptionConnections({ store,
    locate: async provider => controls.installed && provider === "kling" ? executable : null,
    run: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "--version") return { exitCode: 0, stdout: "kling-cli 0.2.0", stderr: "" };
      const body = args[0] === "who_am_i" ? who : { membershipType: "SVIP", availableRemainCredits: 1453, privateToken: "synthetic-private" };
      return { exitCode: controls.loggedIn ? 0 : 1, stdout: JSON.stringify(controls.loggedIn
        ? { ok: true, status: 200, body } : { ok: false, status: 401, body: {} }), stderr: "" };
    },
    nativeCall: async (method, params) => {
      native.push({ method, params });
      if (method === "dialog.message") return { response: controls.choice };
      if (method === "shell.openExternal" || method === "shell.openPath") return {};
      throw new Error("Unexpected native action: " + method);
    }
  });
  return { store, connections, calls, native, controls, executable };
}

test("subscription status exposes only membership and credits without generating", async t => {
  const f = await setup(t), result = await f.connections.providers();
  assert.equal(result.providers[0].configured, false);
  const kling = result.providers.find(provider => provider.id === "kling");
  assert.equal(kling.configured, true); assert.equal(kling.credits, 1453);
  assert.deepEqual(f.calls.map(call => call.args[0]), ["who_am_i", "account"]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});

test("app disconnect preserves CLI login and unrelated app state", async t => {
  const f = await setup(t);
  await f.connections.disconnect({ provider: "kling" });
  const result = await f.connections.providers();
  assert.equal(result.providers.find(provider => provider.id === "kling").configured, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.store.readState(), { unrelatedForm: "preserve" });
  await assert.rejects(f.connections.client("kling"), /먼저 연결/);
  await f.connections.client("kling", { polling: true });
  assert.equal(f.calls.length, 0);
});

test("failed account lookup keeps offline duration and resolution choices available", async t => {
  const f = await setup(t); f.controls.loggedIn = false;
  const kling = (await f.connections.providers()).providers.find(provider => provider.id === "kling");
  assert.equal(kling.configured, false);
  assert.deepEqual(kling.durations, [5, 10]); assert.deepEqual(kling.resolutions, ["720p", "1080p"]);
});

test("a configured CLI connection is confirmed without asking for API keys or logging in again", async t => {
  const f = await setup(t);
  const result = await f.connections.configure({ provider: "kling" });
  assert.equal(result.configured, true);
  assert.equal(f.native.length, 0);
  assert.ok(f.calls.every(call => ["who_am_i", "account"].includes(call.args[0])));
});

test("CLI login opens only the explicitly chosen provider with safely quoted executable", async t => {
  const f = await setup(t); f.controls.loggedIn = false; f.controls.choice = 0;
  const result = await f.connections.configure({ provider: "kling" });
  assert.equal(result.configured, false);
  assert.match(result.message, /터미널/);
  const opened = f.native.find(call => call.method === "shell.openPath").params.path;
  const script = await fs.readFile(opened, "utf8");
  assert.match(script, /'\\''s CLI \$literal' login/);
  assert.match(script, /unset XAI_API_KEY/);
  assert.equal((await fs.stat(opened)).mode & 0o777, 0o700);
  assert.ok(f.calls.every(call => call.args[0] === "who_am_i"));
});
