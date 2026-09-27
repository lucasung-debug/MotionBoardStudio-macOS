"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { randomUUID } = require("node:crypto");
const { CATALOG, prepareGrokHome, inspectGrokSubscription, createGrokSubscriptionProvider } = require("../Runtime/grok-subscription.cjs");

const SESSION = "12345678-1234-4234-8234-123456789012";
const EXE = "/fixture/grok";
const TOOL = "reference_to_video";
const OFFICIAL_MARKETPLACE = '[marketplace]\ndefault_skills_installs_purged = true\nofficial_marketplace_auto_installed = true\n\n[[marketplace.sources]]\nname = "xAI Official"\ngit = "https://github.com/xai-org/plugin-marketplace.git"\n';
const versionRun = async (_executable, args) => ({ exitCode: 0, stderr: "", stdout: args[0] === "--version" ? "grok 1.0.41 (fixture)" : "stdio --no-leader" });
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)]);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motionboard-grok-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "profile"), workDir = path.join(root, "shot"), imagePath = path.join(root, "board.png");
  await fs.writeFile(imagePath, png);
  return { root, home, workDir, input: { imagePath, prompt: "A ball moves from left to right.", duration: 5, resolution: "720p", aspectRatio: "1:1", externalTaskId: randomUUID() } };
}

function fakeSpawn({ loggedIn = true, apiKey = false, tools = [TOOL], onPrompt } = {}) {
  const requests = [], permissions = [], launches = [];
  const spawnImpl = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let incoming = "", rpcId = 1000;
    const waiting = new Map();
    const send = message => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    const response = (request, result) => send({ id: request.id, result });
    const update = value => send({ method: "session/update", params: { sessionId: SESSION, update: value } });
    const permission = (callId, rawInput, name = TOOL) => new Promise(resolve => {
      const id = rpcId++; waiting.set(id, resolve);
      send({ id, method: "session/request_permission", params: {
        sessionId: SESSION, toolCall: { toolCallId: callId, rawInput, _meta: { "x.ai/tool": { name } } },
        options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "no", kind: "reject_once", name: "Reject" }]
      } });
    });
    async function handle(message) {
      if (!message.method) { permissions.push(message); waiting.get(message.id)?.(message.result); waiting.delete(message.id); return; }
      requests.push(message);
      if (message.method === "initialize") response(message, { protocolVersion: 1, authMethods: [
        ...(loggedIn ? [{ id: "cached_token", name: "cached_token" }] : []),
        ...(apiKey ? [{ id: "xai.api_key", name: "xai.api_key" }] : []), { id: "grok.com", name: "Grok" }
      ] });
      else if (message.method === "authenticate") response(message, {});
      else if (message.method === "session/new") {
        update({ sessionUpdate: "available_commands_update", availableCommands: [], _meta: { tools } });
        response(message, { sessionId: SESSION });
      } else if (message.method === "session/prompt") {
        try { await onPrompt?.({ message, update, permission, options, child, response }); }
        catch (error) { send({ id: message.id, error: { code: -32000, message: error.message } }); return; }
        response(message, { stopReason: "end_turn" });
      }
    }
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      incoming += chunk.toString();
      let index;
      while ((index = incoming.indexOf("\n")) >= 0) {
        const line = incoming.slice(0, index); incoming = incoming.slice(index + 1);
        queueMicrotask(() => handle(JSON.parse(line)));
      }
      callback();
    } });
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
    return child;
  };
  return { spawnImpl, requests, permissions, launches };
}

function argsFromPrompt(message) { return JSON.parse(message.params.prompt[0].text.split("\n").at(-1)); }
async function complete({ message, update, permission, options }, overrides = {}) {
  const args = argsFromPrompt(message);
  const decision = await permission("video-1", { variant: "ReferenceToVideo", ...args });
  assert.equal(decision.outcome.optionId, "once");
  const file = path.join(options.env.GROK_HOME, "sessions", "scope", SESSION, "videos", "1.mp4");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, mp4);
  update({ sessionUpdate: "tool_call_update", toolCallId: "video-1", status: "completed", rawOutput: {
    type: "ReferenceToVideo", path: file, filename: "1.mp4", session_folder: "videos", ...overrides
  } });
}

test("isolated OAuth profile accepts CLI metadata and formatting without overwriting config or credentials", async t => {
  const f = await fixture(t);
  const profile = await prepareGrokHome(f.home);
  const auth = path.join(profile, "auth.json");
  await fs.writeFile(auth, "opaque-private-fixture");
  await prepareGrokHome(f.home);
  assert.equal(await fs.readFile(auth, "utf8"), "opaque-private-fixture");
  const config = await fs.readFile(path.join(profile, "config.toml"), "utf8");
  assert.match(config, /disable_api_key_auth = true/); assert.match(config, /preferred_method = "oidc"/);
  const saved = config.replace('preferred_method = "oidc"', "preferred_method = 'oidc' # OAuth")
    .replace("enabled = false", "enabled=false # keep disabled")
    + "\n# Saved by Grok CLI after login\n[marketplace]\ndefault_skills_installs_purged = true\n";
  await fs.writeFile(path.join(profile, "config.toml"), saved);
  await prepareGrokHome(f.home);
  assert.equal(await fs.readFile(path.join(profile, "config.toml"), "utf8"), saved);
  assert.equal(await fs.readFile(auth, "utf8"), "opaque-private-fixture");
  const stub = fakeSpawn();
  const status = await inspectGrokSubscription({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  assert.equal(status.configured, true);
  assert.deepEqual(stub.requests.map(r => r.method), ["initialize", "authenticate"]);
});

test("isolated profile still rejects changed, missing, duplicate, or unknown settings before starting a CLI", async t => {
  const f = await fixture(t), profile = await prepareGrokHome(f.home);
  const configPath = path.join(profile, "config.toml"), config = await fs.readFile(configPath, "utf8");
  const unsafe = [
    config.replace("disable_api_key_auth = true", "disable_api_key_auth = false"),
    config.replace('preferred_method = "oidc"', 'preferred_method = "api_key"'),
    config.replace("[managed_mcps]\nenabled = false", "[managed_mcps]\nenabled = true"),
    config.replace("use_leader = false\n", ""),
    config.replace("use_leader = false", "use_leader = false\nuse_leader = true"),
    config + "\n[cli]\nuse_leader = false\n",
    config + "\n[hooks]\nenabled = true\n",
    config + "\n[hooks]\n",
    config + "\n[managed_mcps.custom_server]\n",
    config + '\n[marketplace]\ndefault_skills_installs_purged = "true"\n'
  ];
  for (const saved of unsafe) {
    await fs.writeFile(configPath, saved);
    await assert.rejects(inspectGrokSubscription({ ...f, executable: EXE, run: () => assert.fail("CLI must not start") }), { code: "CLI_PROFILE_INVALID" });
    assert.equal(await fs.readFile(configPath, "utf8"), saved);
  }
});

test("connection survives the CLI adding its official marketplace after the first successful check", async t => {
  const f = await fixture(t), profile = await prepareGrokHome(f.home), stub = fakeSpawn();
  const configFile = path.join(profile, "config.toml"), initial = await fs.readFile(configFile, "utf8");
  const credentialFile = path.join(profile, "auth.json");
  await fs.writeFile(credentialFile, "opaque-private-fixture");
  const inspect = () => inspectGrokSubscription({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  assert.equal((await inspect()).configured, true);
  // The CLI may register it on a later process start when its rollout changes.
  // This is the serialized public metadata, never an actual user's auth store.
  const saved = initial + '\n' + OFFICIAL_MARKETPLACE;
  await fs.writeFile(configFile, saved);
  assert.equal((await inspect()).configured, true);
  await prepareGrokHome(f.home);
  assert.equal((await inspect()).configured, true);
  assert.equal(await fs.readFile(configFile, "utf8"), saved);
  assert.equal(await fs.readFile(credentialFile, "utf8"), "opaque-private-fixture");
  assert.deepEqual(stub.requests.map(r => r.method), ["initialize", "authenticate", "initialize", "authenticate", "initialize", "authenticate"]);
});

test("official marketplace compatibility does not permit extra sources or settings", async t => {
  const f = await fixture(t), profile = await prepareGrokHome(f.home);
  const configFile = path.join(profile, "config.toml"), initial = await fs.readFile(configFile, "utf8");
  const unsafe = [
    OFFICIAL_MARKETPLACE.replace('name = "xAI Official"', 'name = "Other"'),
    OFFICIAL_MARKETPLACE.replace('git = "https://github.com/xai-org/plugin-marketplace.git"', 'git = "https://example.invalid/other.git"'),
    OFFICIAL_MARKETPLACE.replace('git = "https://github.com/xai-org/plugin-marketplace.git"', 'path = "/fixture/plugins"'),
    OFFICIAL_MARKETPLACE.replace('name = "xAI Official"\n', ''),
    OFFICIAL_MARKETPLACE.replace('official_marketplace_auto_installed = true', 'official_marketplace_auto_installed = "true"'),
    OFFICIAL_MARKETPLACE + 'branch = "unapproved"\n',
    OFFICIAL_MARKETPLACE + 'git = "https://example.invalid/other.git"\n',
    OFFICIAL_MARKETPLACE + '\n[[marketplace.sources]]\nname = "xAI Official"\ngit = "https://github.com/xai-org/plugin-marketplace.git"\n',
    '[marketplace]\n[[marketplace.sources]]\n',
    OFFICIAL_MARKETPLACE + '\n[hooks]\nenabled = true\n'
  ];
  for (const metadata of unsafe) {
    const saved = initial + '\n' + metadata;
    await fs.writeFile(configFile, saved);
    await assert.rejects(inspectGrokSubscription({ ...f, executable: EXE, run: () => assert.fail("CLI must not start") }), { code: "CLI_PROFILE_INVALID" });
    assert.equal(await fs.readFile(configFile, "utf8"), saved);
  }
});

test("isolated profile rejects symlinked config without modifying its target", async t => {
  const f = await fixture(t), target = path.join(f.root, "external.toml");
  await fs.mkdir(f.home);
  await fs.writeFile(target, "external-fixture");
  await fs.symlink(target, path.join(f.home, "config.toml"));
  await assert.rejects(prepareGrokHome(f.home), { code: "CLI_PROFILE_INVALID" });
  assert.equal(await fs.readFile(target, "utf8"), "external-fixture");
});

test("connection status authenticates only the advertised cached OAuth method without prompting", async t => {
  const f = await fixture(t), stub = fakeSpawn();
  const status = await inspectGrokSubscription({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  assert.equal(status.configured, true); assert.equal(status.authMode, "oauth");
  assert.deepEqual(stub.requests.map(r => r.method), ["initialize", "authenticate"]);
  const env = stub.launches[0].options.env;
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, "1"); assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
  assert.equal(env.GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER, "0");
  assert.equal(env.XAI_API_KEY, undefined); assert.equal(env.GROK_CODE_XAI_API_KEY, undefined);
  assert.deepEqual(stub.launches[0].args, ["agent", "--no-leader", "stdio"]);
});

test("missing OAuth login is disconnected and an API-key auth advertisement fails closed", async t => {
  const f = await fixture(t);
  const missing = fakeSpawn({ loggedIn: false });
  const status = await inspectGrokSubscription({ ...f, executable: EXE, run: versionRun, spawnImpl: missing.spawnImpl });
  assert.equal(status.configured, false); assert.equal(status.authenticated, false);
  assert.deepEqual(missing.requests.map(r => r.method), ["initialize"]);
  const wrong = fakeSpawn({ apiKey: true });
  await assert.rejects(inspectGrokSubscription({ ...f, executable: EXE, run: versionRun, spawnImpl: wrong.spawnImpl }), { code: "CLI_SUBSCRIPTION_REQUIRED" });
  assert.equal(wrong.requests.some(r => r.method === "authenticate"), false);
});

test("one exact tool invocation is approved and its verified output is recoverable without any remote call", async t => {
  const f = await fixture(t);
  const stub = fakeSpawn({ onPrompt: async data => {
    const args = argsFromPrompt(data.message);
    const wrong = await data.permission("wrong", { ...args, prompt: "Modified instruction" });
    assert.equal(wrong.outcome.optionId, "no");
    const unrelated = await data.permission("shell", { ...args }, "run_terminal_cmd");
    assert.equal(unrelated.outcome.optionId, "no");
    await complete(data);
    const duplicate = await data.permission("video-2", { ...args });
    assert.equal(duplicate.outcome.optionId, "no");
  } });
  const provider = createGrokSubscriptionProvider({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  const submitted = await provider.submit(f.input);
  assert.equal(submitted.jobId, f.input.externalTaskId);
  assert.equal(submitted.metadata.transport, "grok-cli");
  const receipt = JSON.parse(await fs.readFile(path.join(f.workDir, "receipt.json"), "utf8"));
  assert.equal(receipt.approved, true); assert.equal(receipt.status, "succeeded");
  assert.equal(stub.permissions.filter(p => p.result.outcome.optionId === "once").length, 1);
  const requestCount = stub.requests.length;
  const restored = createGrokSubscriptionProvider({ ...f, executable: EXE, run: () => { throw Error("Must stay offline"); }, spawnImpl: () => { throw Error("Must stay offline"); } });
  assert.deepEqual(await restored.poll(submitted.jobId), { status: "succeeded", videoPath: await fs.realpath(path.join(f.workDir, "result.mp4")) });
  assert.deepEqual(await fs.readFile(path.join(f.workDir, "result.mp4")), mp4);
  assert.equal(stub.requests.length, requestCount);
  await assert.rejects(provider.submit(f.input), { code: "SUBMISSION_UNCONFIRMED" });
});

test("unbounded runtime tool catalogs stop before any model prompt", async t => {
  const f = await fixture(t), stub = fakeSpawn({ tools: [TOOL, "use_tool"] });
  const provider = createGrokSubscriptionProvider({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  await assert.rejects(provider.submit(f.input), { code: "CLI_UNSUPPORTED" });
  assert.equal(stub.requests.some(r => r.method === "session/prompt"), false);
});

test("cancel after approval preserves an uncertain durable job and never resubmits", async t => {
  const f = await fixture(t), controller = new AbortController();
  const stub = fakeSpawn({ onPrompt: async data => {
    const decision = await data.permission("video-1", argsFromPrompt(data.message));
    assert.equal(decision.outcome.optionId, "once"); controller.abort();
  } });
  const provider = createGrokSubscriptionProvider({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  await assert.rejects(provider.submit(f.input, { signal: controller.signal }), error => error.code === "SUBMISSION_UNCONFIRMED" && error.jobId === f.input.externalTaskId);
  const receipt = JSON.parse(await fs.readFile(path.join(f.workDir, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "unconfirmed"); assert.equal(receipt.approved, true);
  await assert.rejects(provider.poll(f.input.externalTaskId), { code: "SUBMISSION_UNCONFIRMED" });
  assert.equal(stub.requests.filter(r => r.method === "session/prompt").length, 1);
});

test("untrusted or out-of-session output paths are never imported", async t => {
  const f = await fixture(t), unrelated = path.join(f.root, "private.mp4"); await fs.writeFile(unrelated, mp4);
  const stub = fakeSpawn({ onPrompt: data => complete(data, { path: unrelated }) });
  const provider = createGrokSubscriptionProvider({ ...f, executable: EXE, run: versionRun, spawnImpl: stub.spawnImpl });
  await assert.rejects(provider.submit(f.input), { code: "SUBMISSION_UNCONFIRMED" });
  await assert.rejects(fs.access(path.join(f.workDir, "result.mp4")), { code: "ENOENT" });
});

test("unknown and mismatched local job IDs cannot fetch or restart jobs", async t => {
  const f = await fixture(t);
  const provider = createGrokSubscriptionProvider({ ...f, executable: EXE, run: () => assert.fail("No remote calls"), spawnImpl: () => assert.fail("No remote calls") });
  await assert.rejects(provider.poll(f.input.externalTaskId), { code: "SUBMISSION_UNCONFIRMED" });
  await fs.mkdir(f.workDir);
  await assert.rejects(provider.poll(f.input.externalTaskId), { code: "SUBMISSION_UNCONFIRMED" });
  await assert.rejects(provider.poll("../../auth.json"), { code: "INVALID_VIDEO_JOB" });
});

test("CLI media catalog cannot silently upgrade to API-only resolution", () => {
  assert.deepEqual(CATALOG.resolutions, ["480p", "720p"]);
  assert.equal(CATALOG.transport, "grok-cli");
});
