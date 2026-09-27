"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createEngine } = require("../Runtime/engine.cjs");
const { createStore } = require("../Runtime/store.cjs");
const { isPublicAddress } = require("../Runtime/image-video.cjs");
const sourceRoot = path.resolve(__dirname, "../upstream/MotionBoardStudio-0.3.2");
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };

async function setup(t) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "mbs-image-flow-")), store = createStore(userData);
  await store.ensureDirs();
  const id = "local-fixture", imagePath = store.imagePathFor(id), legacy = path.join(store.videoDirFor(id), "motion.mp4");
  await store.atomicWrite(imagePath, "synthetic board"); await store.atomicWrite(legacy, "existing motion video");
  await store.addEntry({ id, title: "Local fixture", createdAt: 1, imagePath, videoPath: legacy,
    input: { topic: "Synthetic local test", aspectRatio: "16:9" } });
  const calls = [], events = [], credentials = { apiKey: "synthetic-secret-never-public" };
  const controls = {
    approval: 1, crops: 0, submitted: [], polls: [], selectedFile: null, exports: 0,
    submit: async input => { controls.submitted.push(input); return { jobId: "remote-" + controls.submitted.length, metadata: { provider: "grok" } }; },
    poll: async jobId => { controls.polls.push(jobId); return { status: "pending" }; },
    probe: async () => ({ width: 512, height: 512, duration: 5, fps: 24, hasAudio: false }),
    vault: JSON.stringify(credentials)
  };
  const makeEngine = () => createEngine({ sourceRoot, userData,
    emit: (event, data) => events.push({ event, data }),
    nativeCall: async (method, params) => {
      calls.push({ method, params });
      if (method === "vault.read") return { value: controls.vault };
      if (method === "vault.delete") { controls.vault = null; return {}; }
      if (method === "videoCredentials.status") return { configured: Boolean(controls.vault) };
      if (method === "dialog.message") return { response: controls.approval };
      if (method === "dialog.open") return { canceled: !controls.selectedFile, filePaths: controls.selectedFile ? [controls.selectedFile] : [] };
      if (method === "shell.reveal") return {};
      throw new Error("Unexpected native callback: " + method);
    },
    authServices: { chatgpt: {}, claude: {} },
    testProviders: {
      renderer: { shutdown: async () => {} },
      fetchImpl: async () => { throw new Error("Network is forbidden in service fixtures."); },
      createVideoProvider: () => ({ submit: (...args) => controls.submit(...args), poll: (...args) => controls.poll(...args) }),
      downloadImageVideo: async (url, file, { atomicWrite, signal }) => atomicWrite(file, "downloaded synthetic clip", { signal }),
      imageVideoMedia: {
        prepareBoard: async ({ entryId }) => {
          controls.crops++;
          const shots = [];
          for (let index = 0; index < 16; index++) {
            const file = store.imagePathFor(entryId); await store.atomicWrite(file, "synthetic cell " + index);
            shots.push({ index, imagePath: file, width: 512, height: 512, originalWidth: 64, originalHeight: 64 });
          }
          return { width: 256, height: 256, shots };
        },
        probeClip: (...args) => controls.probe(...args),
        assemble: async ({ workDir, clips }) => {
          controls.exports++;
          const videoPath = path.join(workDir, "video.mp4"), posterPath = path.join(workDir, "poster.png");
          await store.atomicWrite(videoPath, "assembled " + clips.map(clip => clip.path).join(" "));
          await store.atomicWrite(posterPath, "poster");
          return { videoPath, posterPath, meta: { T: clips.reduce((sum, clip) => sum + clip.duration, 0), fps: 60 } };
        }
      }
    }
  });
  let engine = await makeEngine();
  t.after(async () => { await engine.shutdown(); await fs.rm(userData, { recursive: true, force: true }); });
  const invoke = (name, input = {}) => engine.invoke("studio:" + name, { id, ...input });
  const state = async () => (await store.readHistory())[0];
  const restart = async () => { await engine.shutdown(); engine = await makeEngine(); };
  const prepare = async () => { const result = await invoke("imageVideoPrepare"); assert.equal(result.ok, true, result.error); return result.entry; };
  return { id, userData, store, controls, calls, events, credentials, invoke, state, restart, prepare };
}

test("preparation uses the real board references once, selects 12 cells, never submits, and protects stale edits", async t => {
  const f = await setup(t), entry = await f.prepare();
  assert.equal(entry.imageVideo.shots.length, 16);
  assert.equal(entry.imageVideo.shots.filter(shot => shot.enabled).length, 12);
  assert.ok(entry.imageVideo.shots.every(shot => shot.imageUrl.startsWith("studio-image://local/")));
  assert.equal(f.controls.submitted.length, 0);
  await f.prepare(); assert.equal(f.controls.crops, 1);
  const plan = entry.imageVideo;
  const edited = await f.invoke("imageVideoSavePlan", { ...plan, shots: plan.shots.map((shot, index) => ({ ...shot, enabled: index === 0 })) });
  assert.equal(edited.ok, true, edited.error);
  assert.equal((await f.invoke("imageVideoSavePlan", plan)).code, "STALE_REVISION");
  assert.equal((await f.state()).videoPath.endsWith("motion.mp4"), true);
});

test("native confirmation is required and cancelled requests create no remote or pending job", async t => {
  const f = await setup(t); await f.prepare();
  const result = await f.invoke("imageVideoGenerate", { shotIds: ["scene-1", "scene-2"] });
  assert.equal(result.ok, true); assert.equal(f.controls.submitted.length, 0);
  assert.equal(result.canceled, true);
  assert.equal(result.entry.imageVideo.shots[0].status, "draft");
  const dialog = f.calls.find(call => call.method === "dialog.message").params.options;
  assert.match(dialog.message, /2개 장면 · 총 10초/); assert.equal(dialog.defaultId, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});

test("accepted jobs survive restart, block duplicate submission, and keep the first download if the next lookup fails", async t => {
  const f = await setup(t); await f.prepare(); f.controls.approval = 0;
  const submitted = await f.invoke("imageVideoGenerate", { shotIds: ["scene-1", "scene-2"] });
  assert.equal(submitted.ok, true, submitted.error);
  assert.equal(f.controls.submitted.length, 2);
  await f.restart();
  assert.equal((await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] })).ok, false);
  f.controls.poll = async jobId => {
    if (jobId === "remote-2") throw Object.assign(new Error("Fixture service offline"), { code: "VIDEO_PROVIDER_UNAVAILABLE" });
    return { status: "succeeded", videoUrl: "https://cdn.example.test/video.mp4" };
  };
  const interrupted = await f.invoke("imageVideoRefresh");
  assert.equal(interrupted.code, "VIDEO_PROVIDER_UNAVAILABLE");
  assert.equal(interrupted.entry.imageVideo.shots[0].status, "succeeded");
  let plan = (await f.state()).imageVideo;
  assert.equal(plan.shots[0].status, "succeeded"); assert.equal(plan.shots[1].status, "pending");
  const firstPath = plan.shots[0].clipPath;
  f.controls.poll = async () => ({ status: "succeeded", videoUrl: "https://cdn.example.test/video.mp4" });
  assert.equal((await f.invoke("imageVideoRefresh")).ok, true);
  plan = (await f.state()).imageVideo;
  assert.equal(plan.shots[0].clipPath, firstPath); assert.equal(plan.shots[1].status, "succeeded");
  assert.equal(f.controls.submitted.length, 2);
});

test("an uncertain submission cannot silently retry or be edited; reset requires explicit confirmation", async t => {
  const f = await setup(t); await f.prepare(); f.controls.approval = 0;
  f.controls.submit = async () => { throw Object.assign(new Error("Uncertain response"), { code: "SUBMISSION_UNCONFIRMED" }); };
  assert.equal((await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] })).code, "SUBMISSION_UNCONFIRMED");
  await f.restart();
  assert.equal((await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] })).ok, false);
  const plan = (await f.state()).imageVideo;
  assert.equal(plan.shots[0].status, "uncertain");
  assert.equal((await f.invoke("imageVideoSavePlan", { ...plan, provider: "kling", resolution: "720p" })).ok, false);
  f.controls.approval = 1;
  await f.invoke("imageVideoRecover", { shotId: "scene-1" });
  assert.equal((await f.state()).imageVideo.shots[0].status, "uncertain");
  f.controls.approval = 0;
  assert.equal((await f.invoke("imageVideoRecover", { shotId: "scene-1" })).ok, true);
  const recovered = (await f.state()).imageVideo.shots[0];
  assert.equal(recovered.status, "draft"); assert.ok(recovered.previousJobs[0].recoveryConfirmedAt);
});

test("pre-submit cancellation stays retryable and cancellation after acceptance persists the remote ID", async t => {
  const f = await setup(t); await f.prepare(); f.controls.approval = 0;
  f.controls.submit = async () => { throw Object.assign(new Error("Cancelled before POST"), { code: "CANCELLED" }); };
  assert.equal((await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] })).code, "CANCELLED");
  assert.equal((await f.state()).imageVideo.shots[0].status, "draft");
  const started = deferred(), finish = deferred();
  f.controls.submit = async () => { started.resolve(); await finish.promise; return { jobId: "accepted-after-cancel" }; };
  const request = f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] });
  await started.promise; await f.invoke("cancel"); finish.resolve();
  assert.equal((await request).code, "CANCELLED");
  const shot = (await f.state()).imageVideo.shots[0];
  assert.equal(shot.status, "pending"); assert.equal(shot.job.jobId, "accepted-after-cancel");
});

test("retrying a confirmed failed remote job preserves its prior ID", async t => {
  const f = await setup(t); await f.prepare(); f.controls.approval = 0;
  await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] });
  f.controls.poll = async () => ({ status: "failed", error: "Fixture generation rejected" });
  await f.invoke("imageVideoRefresh");
  assert.equal((await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] })).ok, true);
  const shot = (await f.state()).imageVideo.shots[0];
  assert.equal(shot.job.jobId, "remote-2"); assert.equal(shot.previousJobs[0].jobId, "remote-1");
});

test("an invalid completed clip becomes an actionable failure instead of polling forever", async t => {
  const f = await setup(t); await f.prepare(); f.controls.approval = 0;
  await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] });
  f.controls.poll = async () => ({ status: "succeeded", videoUrl: "https://cdn.example.test/short.mp4" });
  f.controls.probe = async () => ({ duration: 1, width: 512, height: 512 });
  const refreshed = await f.invoke("imageVideoRefresh");
  assert.equal(refreshed.ok, true); assert.equal(refreshed.entry.imageVideo.shots[0].status, "failed");
  assert.match(refreshed.entry.imageVideo.shots[0].error, /짧습니다/);
  assert.equal(f.controls.submitted.length, 1);
});

test("stranded submission becomes uncertain on refresh without replaying POST", async t => {
  const f = await setup(t); await f.prepare();
  const plan = (await f.state()).imageVideo;
  plan.shots[0].status = "submitting"; plan.shots[0].job = { provider: "grok", externalTaskId: "stranded" };
  await f.store.updateEntry(f.id, { imageVideo: plan }); await f.restart();
  assert.equal((await f.invoke("imageVideoRefresh")).ok, true);
  assert.equal((await f.state()).imageVideo.shots[0].status, "uncertain");
  assert.equal(f.controls.submitted.length, 0);
});

test("offline clip import and export work without credentials and retain separate motion/image outputs", async t => {
  const f = await setup(t); await f.prepare(); f.controls.vault = null;
  const source = path.join(f.userData, "imported.mp4"); await fs.writeFile(source, "synthetic imported clip");
  f.controls.selectedFile = source; f.controls.probe = async () => ({ width: 512, height: 512, duration: 2.75, fps: 24 });
  const imported = await f.invoke("imageVideoImportClip", { shotId: "scene-1" });
  assert.equal(imported.ok, true, imported.error);
  const plan = imported.entry.imageVideo;
  const saved = await f.invoke("imageVideoSavePlan", { ...plan, provider: "kling", resolution: "720p", shots: plan.shots.map((shot, index) => ({ ...shot, enabled: index === 0 })) });
  assert.equal(saved.ok, true, saved.error); assert.equal(saved.entry.imageVideo.shots[0].status, "succeeded");
  assert.equal(saved.entry.imageVideo.shots[0].duration, 2.75);
  const exported = await f.invoke("imageVideoExport", { options: { musicSource: "none", quality: "draft" } });
  assert.equal(exported.ok, true, exported.error); assert.equal(exported.entry.hasImageVideo, true);
  assert.notEqual(exported.entry.videoUrl, exported.entry.imageVideo.output.videoUrl);
  await f.invoke("videoReveal", { kind: "image_video" });
  const raw = await f.state();
  assert.equal(f.calls.find(call => call.method === "shell.reveal").params.path, raw.imageVideo.output.videoPath);
  assert.equal(await fs.readFile(raw.videoPath, "utf8"), "existing motion video");
  assert.equal(await fs.readFile(source, "utf8"), "synthetic imported clip");
  assert.equal(f.controls.submitted.length, 0);
});

test("provider credentials stay out of public results and progress even in a thrown error", async t => {
  const f = await setup(t); await f.prepare(); f.controls.approval = 0;
  const providers = await f.invoke("imageVideoProviders");
  assert.equal(providers.providers[0].configured, true);
  f.controls.submit = async () => { throw new Error("fixture failure " + f.credentials.apiKey); };
  const failed = await f.invoke("imageVideoGenerate", { shotIds: ["scene-1"] });
  const history = await f.invoke("historyGet");
  assert.doesNotMatch(JSON.stringify([providers, failed, history, f.events]), /synthetic-secret-never-public/);
  assert.doesNotMatch(await fs.readFile(f.store.historyFile, "utf8"), /synthetic-secret-never-public/);
  assert.match(failed.error, /redacted/);
});

test("download destination validation rejects private IPv4 and non-global IPv6", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});
