"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createEngine } = require("../Runtime/engine.cjs");
const { createStore } = require("../Runtime/store.cjs");
const { createRenderer } = require("../Runtime/render.cjs");
const sourceRoot = path.resolve(__dirname, "../upstream/MotionBoardStudio-0.3.2");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lNcAAAAASUVORK5CYII=", "base64");
const SPEC = { title: "Offline fixture", concept: "A local test response", yaml: "project:\n  title: Offline fixture", image_prompt: "A fixture board", notes: [] };
const response = () => ({ content: JSON.stringify(SPEC), model: "offline-test", reasoningEffort: "fixture" });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

async function setup(t, custom = {}, initialState = null) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "mbs-engine-test-"));
  if (initialState) await createStore(userData).writeState(initialState);
  const events = [], nativeCalls = [];
  const controls = {
    chat: async () => response(),
    image: async () => ({ buffer: PNG, model: "offline-image" }),
    video: async ({ workDir, llm, signal }) => {
      assert.equal(signal.aborted, false);
      const reply = await llm({ instructions: "Fixture direction", userText: "Fixture timeline", images: [] });
      assert.equal(reply.model, "offline-test");
      await fs.mkdir(workDir, { recursive: true });
      const videoPath = path.join(workDir, "video.mp4"), posterPath = path.join(workDir, "poster.png"), compositionPath = path.join(workDir, "composition.html");
      await fs.writeFile(videoPath, "fixture-video-not-a-real-mp4");
      await fs.writeFile(posterPath, PNG); await fs.writeFile(compositionPath, "<!doctype html><title>fixture</title>");
      return { videoPath, posterPath, compositionPath, model: "offline-test", meta: { T: 8, frames: 240, fps: 30 } };
    },
    native: async method => { throw new Error("Unexpected native request: " + method); }
  };
  const authServices = {
    chatgpt: { status: async () => ({ loggedIn: true, source: "test" }), getAuth: async () => ({ accessToken: "offline-fixture-only", accountId: "fixture" }), cancelLogin: async () => {} },
    claude: { status: async () => ({ loggedIn: true, source: "test" }), getAuth: async () => ({ token: "offline-fixture-only" }), cancelLogin: async () => {} }
  };
  const engine = await createEngine({ sourceRoot, userData, authServices,
    nativeCall: async (method, params) => { nativeCalls.push({ method, params }); return controls.native(method, params); },
    emit: (event, payload) => events.push({ event, payload }),
    testProviders: { codex: { chat: args => controls.chat(args), generateImage: args => controls.image(args) },
      claude: { chat: args => controls.chat(args) }, pipeline: { runVideo: args => controls.video(args) },
      ffmpeg: { locate: () => ({ ffmpeg: "/offline/ffmpeg", version: "test" }) },
      renderer: { shutdown: async () => {} }, fetchImpl: async () => { throw new Error("Network access is forbidden in engine fixtures."); }, ...custom }
  });
  t.after(async () => { await engine.shutdown(); await fs.rm(userData, { recursive: true, force: true }); });
  return { engine, controls, events, nativeCalls, userData, store: createStore(userData) };
}

async function createEntry(engine) {
  const result = await engine.invoke("studio:spec", { topic: "Local fixture", provider: "chatgpt", mode: "full", aspectRatio: "16:9", durationSeconds: 8 });
  assert.equal(result.ok, true, result.error);
  return result.entry;
}

test("packaged FFmpeg takes priority while source runs retain a saved external installation", async t => {
  const prior = process.env.MOTION_BOARD_FFMPEG;
  t.after(() => { if (prior === undefined) delete process.env.MOTION_BOARD_FFMPEG; else process.env.MOTION_BOARD_FFMPEG = prior; });
  const saved = "/previous-installation/ffmpeg", bundled = "/Applications/Fixture.app/Contents/MacOS/ffmpeg";
  for (const packaged of [true, false]) {
    await t.test(packaged ? "bundled runtime" : "source runtime", async t => {
      if (packaged) process.env.MOTION_BOARD_FFMPEG = bundled;
      else delete process.env.MOTION_BOARD_FFMPEG;
      const { engine, store } = await setup(t, {
        ffmpeg: { locate: () => ({ ffmpeg: process.env.MOTION_BOARD_FFMPEG, version: "fixture" }) }
      }, { ffmpegPath: saved });
      const result = await engine.invoke("studio:env");
      assert.equal(result.ok, true);
      assert.equal(result.ffmpeg.ffmpeg, packaged ? bundled : saved);
      assert.equal((await store.readState()).ffmpegPath, saved);
    });
  }
});

test("all original IPC methods and spec → board → video → history work through injected providers", async t => {
  const { engine, events, store } = await setup(t);
  const main = await fs.readFile(path.join(sourceRoot, "main.cjs"), "utf8");
  const originalMethods = Array.from(main.matchAll(/ipcMain\.handle\('([^']+)'/g), match => match[1]);
  assert.equal(originalMethods.length, 26);
  assert.deepEqual([...engine.methods].sort(), [...originalMethods,
    ...["Providers", "Configure", "Disconnect", "Prepare", "SavePlan", "Generate", "Refresh", "Recover", "ImportClip", "Export"].map(name => "studio:imageVideo" + name)
  ].sort());
  const entry = await createEntry(engine);
  const image = await engine.invoke("studio:board", { id: entry.id });
  assert.equal(image.ok, true, image.error); assert.equal(image.entry.hasImage, true);
  assert.match(image.entry.imageUrl, /^studio-image:\/\/local\//);
  const firstImagePath = (await store.readHistory())[0].imagePath;
  const regenerated = await engine.invoke("studio:board", { id: entry.id });
  assert.equal(regenerated.ok, true, regenerated.error);
  assert.notEqual(regenerated.entry.imageUrl, image.entry.imageUrl);
  assert.deepEqual(await fs.readFile(firstImagePath), PNG);
  const video = await engine.invoke("studio:video", { id: entry.id, options: { musicSource: "none", review: false } });
  assert.equal(video.ok, true, video.error); assert.equal(video.entry.hasVideo, true);
  const history = await engine.invoke("studio:history");
  assert.equal(history.entries.length, 1); assert.equal(history.entries[0].id, entry.id);
  const raw = (await store.readHistory())[0];
  assert.deepEqual(await fs.readFile(raw.imagePath), PNG);
  assert.equal(engine.resolveMedia(video.entry.videoUrl), await fs.realpath(raw.videoPath));
  assert.equal(engine.resolveMedia("studio-video://local/%2e%2e/history.json"), null);
  assert.ok(events.some(event => event.event === "studio:progress" && event.payload.phase === "spec_done"));
  assert.ok(events.some(event => event.payload.phase === "image_done"));
  assert.ok(events.some(event => event.payload.phase === "video_done"));
  assert.equal((await engine.invoke("unknown:method")).code, "UNKNOWN_METHOD");
});

test("failed image and video regeneration retain prior assets and expose the failure", async t => {
  const { engine, controls, store } = await setup(t);
  const entry = await createEntry(engine);
  assert.equal((await engine.invoke("studio:board", { id: entry.id })).ok, true);
  assert.equal((await engine.invoke("studio:video", { id: entry.id })).ok, true);
  const before = (await store.readHistory())[0];
  controls.image = async () => { throw new Error("Fixture image failure"); };
  controls.video = async () => { throw new Error("Fixture video failure"); };
  assert.equal((await engine.invoke("studio:board", { id: entry.id })).ok, false);
  assert.equal((await engine.invoke("studio:video", { id: entry.id })).ok, false);
  const after = (await store.readHistory())[0];
  assert.equal(after.imagePath, before.imagePath); assert.equal(after.videoPath, before.videoPath);
  assert.equal(after.posterPath, before.posterPath); assert.equal(after.compositionPath, before.compositionPath);
  assert.deepEqual(await fs.readFile(before.imagePath), PNG);
  assert.equal(await fs.readFile(before.videoPath, "utf8"), "fixture-video-not-a-real-mp4");
  assert.match(after.imageError, /Fixture image failure/); assert.match(after.videoError, /Fixture video failure/);
  controls.video = async () => { throw Object.assign(new Error("Use PowerShell: winget install ffmpeg.exe"), { code: "FFMPEG_MISSING" }); };
  const missingFFmpeg = await engine.invoke("studio:video", { id: entry.id });
  assert.equal(missingFFmpeg.code, "FFMPEG_MISSING");
  assert.match(missingFFmpeg.error, /ffmpeg 연결 \/ 설치 안내/);
  assert.match(missingFFmpeg.error, /brew install ffmpeg/);
  assert.doesNotMatch(missingFFmpeg.error, /PowerShell|winget|\.exe/);
});

test("cancellation wins over a provider that returns late and concurrent generation is refused", async t => {
  const { engine, controls, store } = await setup(t);
  const entry = await createEntry(engine);
  await engine.invoke("studio:board", { id: entry.id });
  const original = (await store.readHistory())[0];
  const started = deferred(), finish = deferred();
  controls.image = async ({ signal }) => { started.resolve(signal); await finish.promise; return { buffer: Buffer.from("late response"), model: "offline-image" }; };
  const pending = engine.invoke("studio:board", { id: entry.id });
  const signal = await started.promise;
  assert.equal((await engine.invoke("studio:spec", { topic: "Concurrent" })).ok, false);
  assert.equal((await engine.invoke("studio:historyRemove", { id: entry.id })).ok, false);
  assert.equal((await engine.invoke("studio:cancel")).ok, true); assert.equal(signal.aborted, true);
  finish.resolve(); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.code, "CANCELLED");
  assert.equal((await store.readHistory())[0].imagePath, original.imagePath);
  assert.deepEqual(await fs.readFile(original.imagePath), PNG);
});

test("cancelled spec creates no entry and malformed stored history is never overwritten", async t => {
  const { engine, controls, store } = await setup(t);
  const started = deferred(), finish = deferred();
  controls.chat = async () => { started.resolve(); await finish.promise; return response(); };
  const pending = engine.invoke("studio:spec", { topic: "Cancel fixture" });
  await started.promise; await engine.invoke("studio:cancel"); finish.resolve();
  assert.equal((await pending).code, "CANCELLED"); assert.equal((await store.readHistory()).length, 0);
  await fs.writeFile(store.historyFile, "{malformed history"); controls.chat = async () => response();
  assert.equal((await engine.invoke("studio:spec", { topic: "Preserve history" })).ok, false);
  assert.equal(await fs.readFile(store.historyFile, "utf8"), "{malformed history");
});

test("image import failure preserves the board; history removal keeps all assets in app Trash", async t => {
  const { engine, controls, store, userData } = await setup(t);
  const entry = await createEntry(engine);
  await engine.invoke("studio:board", { id: entry.id }); await engine.invoke("studio:video", { id: entry.id });
  const original = (await store.readHistory())[0];
  controls.native = async method => {
    if (method === "dialog.open") return { canceled: false, filePaths: [path.join(userData, "invalid.png")] };
    if (method === "image.loadForModel") throw new Error("Invalid test image");
    throw new Error("Unexpected callback");
  };
  assert.equal((await engine.invoke("studio:imageImport", { id: entry.id })).ok, false);
  assert.equal((await store.readHistory())[0].imagePath, original.imagePath);
  const removed = await engine.invoke("studio:historyRemove", { id: entry.id });
  assert.equal(removed.ok, true, removed.error);
  assert.ok(removed.trashPath.startsWith(store.trashDir + path.sep));
  assert.equal((await store.readHistory()).length, 0);
  const archived = JSON.parse(await fs.readFile(path.join(removed.trashPath, "entry.json"), "utf8"));
  assert.equal(archived.id, entry.id);
  assert.deepEqual(await fs.readFile(path.join(removed.trashPath, path.basename(original.imagePath))), PNG);
  assert.equal(await fs.readFile(path.join(removed.trashPath, entry.id, path.basename(path.dirname(original.videoPath)), "video.mp4"), "utf8"), "fixture-video-not-a-real-mp4");
});

test("atomic history transactions retain concurrent additions and patches", async t => {
  const { store } = await setup(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.addEntry({ id: "entry-" + index, title: "Fixture " + index })));
  assert.equal((await store.readHistory()).length, 12);
  await Promise.all([store.updateEntry("entry-0", { imagePath: "fixture.png" }), store.updateEntry("entry-0", { videoPath: "fixture.mp4" })]);
  const entry = (await store.readHistory()).find(item => item.id === "entry-0");
  assert.equal(entry.imagePath, "fixture.png"); assert.equal(entry.videoPath, "fixture.mp4");
});

test("Claude specification literal YAML newlines recover locally without a second provider call", async t => {
  const { engine, controls, events } = await setup(t);
  let calls = 0;
  controls.chat = async args => {
    calls++;
    assert.equal(args.token, "offline-fixture-only");
    assert.match(args.finalDirective, /\\n/);
    assert.doesNotMatch(args.instructions, /실제 줄바꿈이 있는 문자열/);
    return { ...response(), content: JSON.stringify(SPEC).replace(/\\n/g, "\n"), stopReason: "end_turn" };
  };
  const result = await engine.invoke("studio:spec", { provider: "claude", topic: "Local YAML recovery fixture", mode: "full" });
  assert.equal(result.ok, true, result.error); assert.equal(calls, 1);
  assert.equal(result.entry.yaml, SPEC.yaml);
  assert.ok(events.some(event => event.payload.phase === "spec_repaired"));
  assert.ok(!events.some(event => event.payload.phase === "spec_repair"));
});

test("Claude specification uses the selected effort and records it without changing the model", async t => {
  const { engine, controls } = await setup(t);
  const requests = [];
  controls.chat = async args => { requests.push({ model: args.model, effort: args.effort }); return { ...response(), effort: args.effort }; };
  const balanced = await engine.invoke("studio:spec", { provider: "claude", topic: "Local balanced fixture" });
  const maximum = await engine.invoke("studio:spec", { provider: "claude", topic: "Local maximum fixture", claudeEffort: "max" });
  assert.equal(balanced.ok, true, balanced.error); assert.equal(maximum.ok, true, maximum.error);
  assert.deepEqual(requests.map(request => request.effort), ["medium", "max"]);
  assert.equal(requests[0].model, requests[1].model);
  assert.equal(balanced.entry.reasoningEffort, "medium"); assert.equal(balanced.entry.input.claudeEffort, "medium");
  assert.equal(maximum.entry.reasoningEffort, "max"); assert.equal(maximum.entry.input.claudeEffort, "max");
});

test("Claude response timeout is not mislabeled as cancellation or retried, and history survives", async t => {
  const { engine, controls, store } = await setup(t, { specificationTimeoutMs: 15 });
  const existing = await createEntry(engine); let calls = 0;
  controls.chat = async ({ signal }) => {
    calls++;
    // Upstream maps its aborted request to CANCELLED; the engine must retain
    // its own timed-out cause without treating a user cancellation this way.
    await new Promise(resolve => {
      const guard = setTimeout(resolve, 2000);
      signal.addEventListener("abort", () => { clearTimeout(guard); resolve(); }, { once: true });
    });
    throw Object.assign(new Error("Provider abort fixture"), { code: "CANCELLED" });
  };
  const result = await engine.invoke("studio:spec", { provider: "claude", topic: "Local deadline fixture" });
  assert.equal(result.ok, false); assert.equal(result.code, "SPEC_RESPONSE_TIMEOUT"); assert.equal(calls, 1);
  assert.deepEqual((await store.readHistory()).map(entry => entry.id), [existing.id]);
});

test("a malformed completed Claude response receives one format repair on the same provider and model", async t => {
  const { engine, controls, events, store } = await setup(t);
  const requests = [], original = "```yaml\nproject:\n  title: Offline fixture\n```";
  controls.chat = async args => {
    requests.push(args);
    return requests.length === 1 ? { content: original, model: "offline-test", stopReason: "end_turn" } : { ...response(), stopReason: "end_turn" };
  };
  const result = await engine.invoke("studio:spec", { provider: "claude", topic: "Local repair fixture", mode: "full" });
  assert.equal(result.ok, true, result.error); assert.equal(requests.length, 2);
  assert.equal(requests[0].model, requests[1].model);
  assert.ok(requests.every(request => request.token === "offline-fixture-only" && !request.accessToken));
  assert.match(requests[1].userText, /previous_response/);
  assert.match(requests[1].userText, /사실의 불확실성과 검증 한계를 유지/);
  assert.ok(events.some(event => event.payload.phase === "spec_repair"));
  assert.equal((await store.readHistory()).length, 1);
  assert.equal(result.entry.yaml, SPEC.yaml);
});

test("failed format recovery stops after two calls, preserves history and stores only safe diagnostics", async t => {
  const { engine, controls, store } = await setup(t);
  const existing = await createEntry(engine); let calls = 0;
  controls.chat = async () => {
    calls++;
    return { content: "PRIVATE_RESPONSE_FOR_TEST "+"offline-fixture-only", model: "offline-test", stopReason: "end_turn" };
  };
  const result = await engine.invoke("studio:spec", { provider: "claude", topic: "Local malformed fixture" });
  assert.equal(result.ok, false); assert.equal(result.code, "SPEC_FORMAT_INVALID");
  assert.match(result.error, /한 번 보정/); assert.equal(calls, 2);
  assert.deepEqual((await store.readHistory()).map(entry => entry.id), [existing.id]);
  const files = (await fs.readdir(store.baseDir)).filter(file => file.startsWith("failed-response-"));
  assert.equal(files.length, 2);
  for (const name of files) {
    const data = await fs.readFile(path.join(store.baseDir, name), "utf8");
    assert.doesNotMatch(data, /PRIVATE_RESPONSE_FOR_TEST|offline-fixture-only/);
    assert.equal(JSON.parse(data).stopReason, "end_turn"); assert.ok(JSON.parse(data).responseCharacters > 0);
  }
});

test("truncation, tool turns and authentication errors never launch a format retry", async t => {
  for (const code of ["max_tokens", "model_context_window_exceeded", "pause_turn", "tool_use", "refusal", "LLM_AUTH_REQUIRED"]) {
    await t.test(code, async t => {
      const { engine, controls, store } = await setup(t); let calls = 0;
      controls.chat = async () => {
        calls++;
        if (code === "LLM_AUTH_REQUIRED") throw Object.assign(new Error("Fixture authentication rejected"), { code });
        return { ...response(), stopReason: code };
      };
      const result = await engine.invoke("studio:spec", { provider: "claude", topic: "Local terminal-state fixture" });
      assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal((await store.readHistory()).length, 0);
      assert.ok(["SPEC_OUTPUT_TRUNCATED", "SPEC_RESPONSE_INCOMPLETE", "LLM_AUTH_REQUIRED"].includes(result.code));
    });
  }
});

test("cancellation while a format repair is pending rejects its late response and creates no entry", async t => {
  const { engine, controls, store } = await setup(t), started = deferred(), finish = deferred();
  let calls = 0;
  controls.chat = async () => {
    if (++calls === 1) return { content: "Fixture response with no JSON", stopReason: "end_turn" };
    started.resolve(); await finish.promise; return response();
  };
  const pending = engine.invoke("studio:spec", { provider: "claude", topic: "Local cancellation fixture" });
  await started.promise; await engine.invoke("studio:cancel"); finish.resolve();
  assert.equal((await pending).code, "CANCELLED"); assert.equal(calls, 2); assert.equal((await store.readHistory()).length, 0);
});

test("image-only Claude specifications receive a mode-specific final directive", async t => {
  const { engine, controls } = await setup(t);
  controls.chat = async args => {
    assert.match(args.finalDirective, /yaml은 생략/);
    assert.doesNotMatch(args.finalDirective, /YAML과 이미지 지시문 전체/);
    return { content: JSON.stringify({ title: "Image fixture", concept: "Unverified facts remain unverified.", image_prompt: "Complete fixture image instruction" }), stopReason: "end_turn" };
  };
  const result = await engine.invoke("studio:spec", { provider: "claude", topic: "Local image fixture", mode: "image_only" });
  assert.equal(result.ok, true, result.error); assert.equal(result.entry.yaml, "");
});

test("provider diagnostics and progress never expose tokens or raw HTTP response bodies", async t => {
  const { engine, controls, events } = await setup(t);
  controls.chat = async ({ accessToken, onDelta }) => {
    onDelta({ kind: "status", text: "Failure diagnostic: " + accessToken + " Bearer synthetic-token-value" });
    throw new Error("Provider failure: " + accessToken + " eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.signature");
  };
  const result = await engine.invoke("studio:spec", { topic: "Redaction fixture" });
  assert.equal(result.ok, false);
  const publicOutput = JSON.stringify({ result, events });
  assert.doesNotMatch(publicOutput, /offline-fixture-only|synthetic-token-value|eyJhbGci/);
  assert.match(publicOutput, /redacted/);
  controls.chat = async () => { throw new Error('ChatGPT 요청 실패 (500): {"private_response":"fixture-private-payload"}'); };
  const httpError = await engine.invoke("studio:spec", { topic: "HTTP fixture" });
  assert.match(httpError.error, /HTTP 500/);
  assert.doesNotMatch(httpError.error, /fixture-private-payload|private_response/);
});

test("native rendering awaits pixel analysis, closes pages, and caps final rendering at two workers", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mbs-render-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], pipelines = [], commands = []; let nextID = 0, live = 0, maximum = 0;
  const nativeCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "render.open") { live += 1; maximum = Math.max(maximum, live); return { pageId: String(++nextID), ready: true, errors: [] }; }
    if (method === "render.close") { live -= 1; return {}; }
    if (method === "render.eval") return { bad: [], slow: 1, errors: [], sfx: [[0, "click", 0.5]] };
    if (method === "render.capture") return { data: PNG.toString("base64") };
    if (method === "image.spread") return { spread: 12 };
    throw new Error("Unexpected native call");
  };
  const ffmpeg = {
    pipe: args => { const item = { args, frames: 0 }; pipelines.push(item); return { write: async () => { item.frames += 1; }, end: async () => {}, kill() {} }; },
    run: async args => { commands.push(args); await fs.writeFile(args[args.length - 1], "fixture output"); }
  };
  const renderer = createRenderer({ sourceRoot, nativeCall, ffmpeg });
  const timing = { W: 320, H: 180, T: 0.1, fps: 60, beat: 0.5 };
  const result = await renderer.validate("fixture.html", timing);
  assert.equal(result.ok, true); assert.deepEqual(result.spreads, [12, 12, 12]); assert.equal(live, 0);
  const outFile = path.join(directory, "video.mp4"), posterFile = path.join(directory, "poster.png");
  await fs.writeFile(outFile, "previous movie"); await fs.writeFile(posterFile, "previous poster");
  const rendered = await renderer.renderVideo("fixture.html", timing, { outFile, posterFile, workers: 8 });
  assert.deepEqual(rendered, { frames: 6, fps: 60, subframes: 4, workers: 2 });
  assert.equal(pipelines.reduce((sum, pipeline) => sum + pipeline.frames, 0), 24);
  assert.ok(pipelines.every(pipeline => pipeline.args.some(arg => String(arg).includes("tmix=frames=4"))));
  assert.ok(commands[0].includes("libx264")); assert.ok(commands[0].includes("bt709"));
  assert.ok(maximum <= 2); assert.equal(live, 0);
  assert.equal(await fs.readFile(outFile, "utf8"), "fixture output");
  assert.deepEqual(await fs.readFile(posterFile), PNG);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["poster.png", "video.mp4"]);
  await renderer.shutdown();
});

test("cancelling an opening native render releases its late page", async () => {
  const opened = deferred(), calls = [], controller = new AbortController();
  const renderer = createRenderer({ sourceRoot, ffmpeg: {}, nativeCall: async (method, params) => {
    calls.push({ method, params }); if (method === "render.open") return opened.promise; return {};
  } });
  const pending = renderer.openPage("fixture.html", { W: 320, H: 180, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error.code === "CANCELLED");
  opened.resolve({ pageId: "late", ready: true, errors: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call.method === "render.close" && call.params.pageId === "late"));
});

test("cancellation during final mux preserves the existing movie and poster even if FFmpeg returns late success", async t => {
  for (const lateSuccess of [false, true]) {
    await t.test(lateSuccess ? "late FFmpeg success" : "FFmpeg abort rejection", async t => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mbs-mux-cancel-test-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const outFile = path.join(directory, "video.mp4"), posterFile = path.join(directory, "poster.png");
      await fs.writeFile(outFile, "previous completed movie"); await fs.writeFile(posterFile, "previous poster");
      const controller = new AbortController(); let opened = 0, closed = 0;
      const renderer = createRenderer({ sourceRoot,
        nativeCall: async method => {
          if (method === "render.open") return { pageId: String(++opened), ready: true, errors: [] };
          if (method === "render.capture") return { data: PNG.toString("base64") };
          if (method === "render.close") { closed += 1; return {}; }
          throw new Error("Unexpected native call: " + method);
        },
        ffmpeg: {
          pipe: () => ({ write: async () => {}, end: async () => {}, kill() {} }),
          run: async args => {
            const temporary = args[args.length - 1];
            assert.notEqual(temporary, outFile);
            assert.equal(path.dirname(temporary), directory);
            assert.equal(path.extname(temporary), ".mp4");
            await fs.writeFile(temporary, "unfinished mux output");
            assert.equal(await fs.readFile(outFile, "utf8"), "previous completed movie");
            assert.equal(await fs.readFile(posterFile, "utf8"), "previous poster");
            controller.abort();
            if (!lateSuccess) throw Object.assign(new Error("Fixture mux cancellation"), { code: "CANCELLED" });
          }
        }
      });
      await assert.rejects(renderer.renderVideo("fixture.html", { W: 320, H: 180, T: 0.1, fps: 60 },
        { outFile, posterFile, quality: "draft", signal: controller.signal }), error => error.code === "CANCELLED");
      assert.equal(await fs.readFile(outFile, "utf8"), "previous completed movie");
      assert.equal(await fs.readFile(posterFile, "utf8"), "previous poster");
      assert.deepEqual((await fs.readdir(directory)).sort(), ["poster.png", "video.mp4"]);
      assert.equal(opened, closed);
      await renderer.shutdown();
    });
  }
});
