"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const net = require("node:net");
const { createVideoProvider } = require("./video-providers.cjs");
const { PROVIDERS, createSubscriptionConnections } = require("./subscription-video-providers.cjs");
const { createImageVideoMedia } = require("./image-video-media.cjs");

const abort = signal => { if (signal?.aborted) throw Object.assign(new Error("작업을 취소했습니다. 이미 요청한 외부 영상은 장면 상태 확인으로 다시 불러올 수 있습니다."), { code: "CANCELLED" }); };
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const pending = shot => ["submitting", "pending", "uncertain"].includes(shot.status);
const fail = (message, code = "IMAGE_VIDEO_INVALID") => Object.assign(new Error(message), { code });

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b));
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    // Require ordinary global unicast; exclude IPv4-mapped and local ranges.
    return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith("2001:db8:");
  }
  return false;
}

async function downloadVideo(url, target, { signal, atomicWrite, fetchImpl = fetch }) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443") throw fail("영상 서비스가 허용되지 않은 다운로드 주소를 반환했습니다.");
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw fail("영상 서비스가 비공개 네트워크 주소를 반환했습니다.");
  const timeout = AbortSignal.timeout(120000);
  const response = await fetchImpl(parsed.href, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) throw fail(`생성 영상 다운로드에 실패했습니다 (HTTP ${response.status}).`);
  const maximum = 256 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) throw fail("장면 영상이 다운로드 크기 제한을 넘었습니다.");
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    abort(signal); size += chunk.length;
    if (size > maximum) throw fail("장면 영상이 다운로드 크기 제한을 넘었습니다.");
    chunks.push(chunk);
  }
  if (!size) throw fail("생성 영상이 비어 있습니다.");
  await atomicWrite(target, Buffer.concat(chunks), { signal });
}

function createImageVideoService({ sourceRoot, store, nativeCall, getEntry, rememberAuth, errorMessage = error => error.message, testProviders = {} }) {
  const media = testProviders.imageVideoMedia || createImageVideoMedia({ sourceRoot });
  const makeProvider = testProviders.createVideoProvider || createVideoProvider;
  const connections = testProviders.subscriptionConnections || createSubscriptionConnections({ store, nativeCall });
  const musicPipeline = require(path.join(sourceRoot, "lib/video/pipeline.cjs"));
  const providerInfo = provider => {
    const info = PROVIDERS[provider];
    if (!info) throw fail("지원하는 영상 서비스를 선택해 주세요.");
    return info;
  };
  const getPlan = entry => {
    if (!entry.imageVideo?.shots?.length) throw fail("먼저 보드에서 영상 장면을 준비해 주세요.");
    return entry.imageVideo;
  };
  const writePlan = async (id, plan, options) => store.updateEntry(id, { imageVideo: { ...plan, revision: (plan.revision || 0) + 1, updatedAt: Date.now() } }, options);
  async function credentials(provider) {
    providerInfo(provider);
    const result = await nativeCall("vault.read", { account: provider + "-video" });
    if (!result.value) throw fail("이 작업은 이전 API 연결로 요청되었습니다. 서비스에서 결과를 내려받아 클립 가져오기로 연결해 주세요.", "VIDEO_PROVIDER_UNCONFIGURED");
    let value;
    try { value = JSON.parse(result.value); } catch { throw fail("저장한 영상 API 정보를 다시 입력해 주세요.", "VIDEO_PROVIDER_UNCONFIGURED"); }
    rememberAuth(value);
    return value;
  }
  const cliWorkDir = (id, localId) => {
    if (typeof localId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(localId)) throw fail("저장된 영상 작업 경로를 확인할 수 없습니다.");
    return path.join(store.videoDirFor(id), "image-video", "jobs", localId, "grok");
  };
  async function client(provider, { id, job, polling = false } = {}) {
    // Jobs created before the subscription adapters retain their original API
    // route. New submissions never fall back to that route or request API keys.
    if (polling && !job?.transport) return makeProvider({ provider, credentials: await credentials(provider), fetchImpl: testProviders.fetchImpl || fetch });
    if (job?.transport && job.transport !== providerInfo(provider).transport) throw fail("저장된 작업의 연결 방식이 지원되지 않습니다.");
    return connections.client(provider, { workDir: cliWorkDir(id, job.localId), polling });
  }
  const providers = () => connections.providers();
  const configure = input => connections.configure(input);
  const disconnect = input => connections.disconnect(input);
  function publicPlan(plan) {
    if (!plan) return null;
    return { revision: plan.revision, boardFingerprint: plan.boardFingerprint, provider: plan.provider,
      resolution: plan.resolution, sourceWidth: plan.sourceWidth, sourceHeight: plan.sourceHeight,
      error: plan.error || "", shots: plan.shots.map(shot => ({
        id: shot.id, index: shot.index, enabled: shot.enabled, title: shot.title, prompt: shot.prompt,
        duration: shot.duration, status: shot.status, error: shot.error || "",
        imageUrl: store.imageUrlForPath(shot.imagePath), videoUrl: store.videoUrlFor(shot.clipPath),
        sourceWidth: shot.sourceWidth, sourceHeight: shot.sourceHeight, imported: Boolean(shot.imported),
        jobId: shot.job?.jobId || "", jobProvider: shot.job?.provider || "", jobTransport: shot.job?.transport || "",
        creditsConsumed: Number.isFinite(shot.job?.metadata?.creditsConsumed) ? shot.job.metadata.creditsConsumed : null
      })), output: plan.output ? { videoUrl: store.videoUrlFor(plan.output.videoPath),
        posterUrl: store.videoUrlFor(plan.output.posterPath), videoMeta: plan.output.videoMeta } : null };
  }

  async function prepare({ id }, { signal, report }) {
    const entry = await getEntry(id);
    if (!entry.imagePath) throw fail("먼저 디자인 보드를 생성하거나 가져와 주세요.");
    const boardFingerprint = sha256(await fs.readFile(entry.imagePath));
    if (entry.imageVideo?.boardFingerprint === boardFingerprint) return entry;
    if (entry.imageVideo?.shots.some(pending)) throw fail("이전 보드로 요청한 장면이 남아 있습니다. 상태를 확인한 뒤 새 보드를 준비해 주세요.");
    report({ phase: "image_video_prepare", message: "원본 보드를 16개 장면으로 나누는 중…" });
    const board = await media.prepareBoard({ boardPath: entry.imagePath, imagesDir: store.imagesDir, entryId: id, signal });
    abort(signal);
    if (entry.imageVideo) await store.atomicWrite(path.join(store.videoDirFor(id), "image-video", "plan-" + crypto.randomUUID() + ".json"), JSON.stringify(entry.imageVideo, null, 2), { signal });
    const provider = entry.imageVideo?.provider || "grok", info = providerInfo(provider);
    const duration = info.durations.includes(5) ? 5 : info.durations[0];
    const plan = { revision: entry.imageVideo?.revision || 0, boardFingerprint, provider, resolution: info.resolutions[0],
      sourceWidth: board.width, sourceHeight: board.height, shots: board.shots.map(shot => ({
        id: "scene-" + (shot.index + 1), index: shot.index, enabled: shot.index < 12,
        title: `장면 ${shot.index + 1}`, duration, imagePath: shot.imagePath,
        sourceWidth: shot.originalWidth || shot.width, sourceHeight: shot.originalHeight || shot.height,
        prompt: `이 이미지의 인물·사물 자체가 자연스럽게 움직이도록 만드세요. 원본의 얼굴, 형태, 의상, 색상, 재질과 구도를 유지하세요. 이미지 전체에 단순 확대·이동만 적용하지 마세요. 장면 전환이나 새로운 문구를 추가하지 마세요. 주제: ${String(entry.input?.topic || entry.title || "").slice(0, 300)}`,
        status: "draft", error: "", clipPath: ""
      })) };
    const updated = await writePlan(id, plan, { signal });
    report({ phase: "image_video_prepared", message: "장면 준비 완료 — 움직임 설명과 사용할 장면을 확인해 주세요.", entryId: id });
    return updated;
  }

  async function savePlan(input, { signal }) {
    const entry = await getEntry(input.id), plan = getPlan(entry);
    if (Number(input.revision) !== plan.revision) throw fail("장면 상태가 바뀌었습니다. 기록을 다시 불러온 뒤 수정해 주세요.", "STALE_REVISION");
    const info = providerInfo(input.provider || plan.provider);
    const resolution = input.resolution || (info.resolutions.includes(plan.resolution) ? plan.resolution : info.resolutions[0]);
    if (!info.resolutions.includes(resolution)) throw fail("선택한 서비스가 지원하는 해상도를 선택해 주세요.");
    if (!Array.isArray(input.shots) || input.shots.length !== plan.shots.length || new Set(input.shots.map(shot => shot.id)).size !== plan.shots.length) throw fail("장면 목록이 올바르지 않습니다.");
    const shots = input.shots.map(edit => {
      const old = plan.shots.find(shot => shot.id === edit.id);
      const duration = Number(edit.duration), prompt = String(edit.prompt || "").trim(), title = String(edit.title || "").trim();
      const validDuration = old?.imported ? Number.isFinite(duration) && duration > 0 && duration <= old.clipMeta.duration : info.durations.includes(duration);
      if (!old || !validDuration || !prompt || prompt.length > 2000 || title.length > 120) throw fail("장면 이름·움직임 설명·길이를 확인해 주세요.");
      const changed = old.prompt !== prompt || old.duration !== duration || plan.provider !== info.id || plan.resolution !== resolution;
      if (changed && pending(old)) throw fail("요청 중인 장면의 설정은 상태 확인이 끝난 뒤 바꿀 수 있습니다.");
      return { ...old, title, prompt, duration, enabled: Boolean(edit.enabled),
        ...(changed && !old.imported ? { status: "draft", error: "", previousJobs: [...(old.previousJobs || []), ...(old.job ? [old.job] : [])], job: null } : {}) };
    });
    return writePlan(input.id, { ...plan, provider: info.id, resolution, shots, error: "" }, { signal });
  }

  async function generate({ id, shotIds }, { signal, report }) {
    let entry = await getEntry(id), plan = getPlan(entry);
    const info = providerInfo(plan.provider);
    if (!Array.isArray(shotIds) || !shotIds.length || shotIds.length > 16 || new Set(shotIds).size !== shotIds.length) throw fail("생성할 장면을 선택해 주세요.");
    const selected = shotIds.map(id => plan.shots.find(shot => shot.id === id));
    if (selected.some(shot => !shot || !shot.enabled || !["draft", "failed"].includes(shot.status))) throw fail("아직 만들지 않았거나 실패한 장면만 요청할 수 있습니다. 대기 중인 장면은 상태 확인을 눌러 주세요.");
    abort(signal);
    const seconds = selected.reduce((sum, shot) => sum + shot.duration, 0);
    const approval = await nativeCall("dialog.message", { options: { title: "이미지 영상 생성", message: `${info.label}에 ${selected.length}개 장면 · 총 ${seconds}초를 요청할까요?`,
      detail: `선택한 원본 이미지와 움직임 설명이 ${info.label}로 전송됩니다. ${info.model} · ${plan.resolution}. 연결한 구독 계정의 사용량 또는 크레딧을 사용합니다. 요청 후 앱을 취소해도 이미 접수된 외부 작업과 사용량이 취소되는 것은 아닙니다.`,
      buttons: ["요청하기", "취소"], defaultId: 1, cancelId: 1 } });
    if (approval.response !== 0) return { ...entry, operationCanceled: true };
    abort(signal);
    for (const selectedShot of selected) {
      abort(signal);
      const shot = plan.shots.find(item => item.id === selectedShot.id);
      const imageBytes = await fs.readFile(shot.imagePath);
      const localId = crypto.randomUUID();
      if (shot.job) shot.previousJobs = [...(shot.previousJobs || []), shot.job];
      shot.job = { localId, externalTaskId: localId, provider: plan.provider, transport: info.transport, model: info.model, resolution: plan.resolution,
        imageSha256: sha256(imageBytes), requestedAt: Date.now(), duration: shot.duration };
      // Grok's CLI result is a local durable receipt keyed by our request ID.
      // Recording that key first allows read-only recovery after an app restart.
      if (info.transport === "grok-cli") shot.job.jobId = localId;
      shot.status = "submitting"; shot.error = "";
      entry = await writePlan(id, plan, { signal }); plan = entry.imageVideo;
      const active = plan.shots.find(item => item.id === shot.id);
      report({ phase: "image_video_submit", message: `${active.title} — ${info.label}에 생성 요청 중…`, entryId: id });
      let acknowledged = false;
      try {
        const service = await client(plan.provider, { id, job: active.job });
        const result = await service.submit({ imagePath: active.imagePath, imageBase64: imageBytes.toString("base64"), mediaType: "image/png",
          prompt: active.prompt, duration: active.duration, aspectRatio: entry.input?.aspectRatio || "1:1",
          resolution: plan.resolution, externalTaskId: localId }, { signal });
        if (!result.jobId) throw fail("외부 서비스의 작업 번호를 확인하지 못했습니다.", "SUBMISSION_UNCONFIRMED");
        active.job.jobId = result.jobId; active.job.metadata = result.metadata; active.status = "pending";
        acknowledged = true;
        // Save an accepted remote ID even if local cancellation arrives late.
        entry = await writePlan(id, plan); plan = entry.imageVideo;
        abort(signal);
      } catch (error) {
        if (!acknowledged) {
          active.status = error.code === "SUBMISSION_UNCONFIRMED" ? "uncertain" : error.code === "CANCELLED" ? "draft" : "failed";
          active.error = active.status === "uncertain" ? "요청 접수 여부를 확인해야 합니다. 구독 사용량의 중복 소모를 막기 위해 자동으로 다시 요청하지 않습니다." : String(errorMessage(error)).slice(0, 500);
          entry = await writePlan(id, plan); plan = entry.imageVideo;
        }
        throw error;
      }
    }
    report({ phase: "image_video_pending", message: "영상 요청을 접수했습니다. 장면 상태 확인으로 완성된 클립을 가져올 수 있습니다.", entryId: id });
    return entry;
  }

  async function refresh({ id }, { signal, report }) {
    let entry = await getEntry(id), plan = getPlan(entry);
    for (const shot of plan.shots) {
      abort(signal);
      if (shot.status === "submitting") {
        shot.status = "uncertain"; shot.error = "앱 종료 전에 요청 결과가 저장되지 않았습니다. 서비스에서 접수 여부를 확인해 주세요.";
        entry = await writePlan(id, plan, { signal }); plan.revision = entry.imageVideo.revision;
        if (shot.job?.transport !== "grok-cli") continue;
      }
      const recoveringCLI = shot.status === "uncertain" && shot.job?.transport === "grok-cli";
      if (shot.status !== "pending" && !recoveringCLI || !shot.job?.jobId) continue;
      report({ phase: "image_video_poll", message: `${shot.title} — 생성 상태를 확인하는 중…`, entryId: id });
      const service = await client(shot.job.provider, { id, job: shot.job, polling: true });
      let result;
      try { result = await service.poll(shot.job.jobId, { signal }); }
      catch (error) {
        if (!recoveringCLI || error.code !== "SUBMISSION_UNCONFIRMED") throw error;
        shot.error = "CLI 완료 기록을 아직 확인하지 못했습니다. 구독 서비스의 생성 내역을 확인하거나 완성된 클립을 가져와 주세요.";
        entry = await writePlan(id, plan, { signal }); plan.revision = entry.imageVideo.revision;
        continue;
      }
      if (result.status === "failed") { shot.status = "failed"; shot.error = result.error || "영상 서비스에서 생성에 실패했습니다."; }
      else if (result.status === "succeeded") {
        const target = path.join(store.videoDirFor(id), "image-video", "jobs", shot.job.localId, "clip.mp4");
        if (result.videoPath) {
          // CLI output is accepted only from this job's private directory. A
          // model-provided path must never turn the app into an arbitrary reader.
          const root = await fs.realpath(cliWorkDir(id, shot.job.localId));
          const source = await fs.realpath(result.videoPath), relative = path.relative(root, source);
          const stat = await fs.stat(source);
          if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !stat.isFile() || stat.size > 256 * 1024 * 1024) throw fail("CLI가 반환한 영상 파일 경로를 확인할 수 없습니다.");
          abort(signal);
          await store.atomicWrite(target, await fs.readFile(source), { signal });
        } else {
          const download = testProviders.downloadImageVideo || downloadVideo;
          await download(result.videoUrl, target, { signal, atomicWrite: store.atomicWrite, fetchImpl: testProviders.fetchImpl || fetch });
        }
        try {
          const probe = await media.probeClip(target, { signal });
          abort(signal);
          if (probe.duration + 0.15 < shot.duration) throw fail("생성 영상이 요청한 장면 길이보다 짧습니다.");
          shot.clipPath = target; shot.status = "succeeded"; shot.error = ""; shot.imported = false; shot.clipMeta = probe;
        } catch (error) {
          abort(signal);
          shot.status = "failed"; shot.error = "생성된 클립 확인 실패: " + String(errorMessage(error)).slice(0, 400);
        }
      }
      // Commit each completed lookup before contacting the next service. A later
      // outage or cancellation must not lose a downloaded clip or a terminal job.
      entry = await writePlan(id, plan, { signal }); plan.revision = entry.imageVideo.revision;
    }
    return entry;
  }

  async function recover({ id, shotId }, { signal }) {
    const entry = await getEntry(id), plan = getPlan(entry), shot = plan.shots.find(item => item.id === shotId);
    if (!shot || shot.status !== "uncertain") throw fail("접수 여부가 불확실한 장면만 재설정할 수 있습니다.");
    const info = providerInfo(shot.job?.provider || plan.provider);
    const answer = await nativeCall("dialog.message", { options: {
      message: `${shot.title}의 미접수를 ${info.label}에서 확인하셨나요?`,
      detail: `서비스의 작업 내역에서 이 요청이 접수되지 않았음을 확인한 경우에만 다시 준비하세요. 이미 접수된 작업을 재생성하면 사용량이 중복 소모될 수 있습니다. 완성된 영상은 클립 가져오기로 연결할 수 있습니다.\n앱 요청 번호: ${shot.job?.externalTaskId || "없음"}`,
      buttons: ["미접수 확인 · 다시 준비", "취소"], defaultId: 1, cancelId: 1
    } });
    if (answer.response !== 0) return { ...entry, operationCanceled: true };
    abort(signal);
    shot.previousJobs = [...(shot.previousJobs || []), { ...shot.job, recoveryConfirmedAt: Date.now() }];
    shot.job = null; shot.status = "draft"; shot.error = "";
    return writePlan(id, plan, { signal });
  }

  async function importClip({ id, shotId }, { signal }) {
    const entry = await getEntry(id), plan = getPlan(entry), shot = plan.shots.find(item => item.id === shotId);
    if (!shot) throw fail("장면을 찾지 못했습니다.");
    if (["submitting", "pending"].includes(shot.status)) throw fail("요청 중인 장면은 상태 확인이 끝난 뒤 교체해 주세요.");
    const result = await nativeCall("dialog.open", { options: { title: `${shot.title}에 사용할 영상 선택`, properties: ["openFile"], filters: [{ name: "영상", extensions: ["mp4", "mov", "m4v", "webm"] }] } });
    if (result.canceled || !result.filePaths?.[0]) return { ...entry, operationCanceled: true };
    abort(signal);
    const source = result.filePaths[0], probe = await media.probeClip(source, { signal });
    const target = path.join(store.videoDirFor(id), "image-video", "imports", crypto.randomUUID(), "clip" + path.extname(source).toLowerCase());
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, require("node:fs").constants.COPYFILE_EXCL);
    abort(signal);
    shot.clipPath = target; shot.clipMeta = probe; shot.status = "succeeded"; shot.error = ""; shot.imported = true;
    shot.duration = Math.min(shot.duration, probe.duration);
    return writePlan(id, plan, { signal });
  }

  async function exportVideo({ id, options = {} }, { signal, report }) {
    const entry = await getEntry(id), plan = getPlan(entry), selected = plan.shots.filter(shot => shot.enabled);
    if (!selected.length || selected.some(shot => shot.status !== "succeeded" || !shot.clipPath)) throw fail("선택한 모든 장면의 영상이 준비되어야 내보낼 수 있습니다.");
    const aspectRatio = options.aspectRatio || entry.input?.aspectRatio || "1:1";
    if (!["1:1", "16:9", "9:16"].includes(aspectRatio)) throw fail("지원하는 화면비를 선택해 주세요.");
    const workDir = path.join(store.videoDirFor(id), "image-video", "exports", crypto.randomUUID());
    const durationSec = selected.reduce((sum, shot) => sum + shot.duration, 0);
    const music = await musicPipeline.prepareMusic({ entry, options: { ...options, musicSource: options.musicSource || "none" },
      durationSec, cacheDir: store.musicCacheDir, signal, progress: report, fetchImpl: testProviders.fetchImpl });
    const result = await media.assemble({ clips: selected.map(shot => ({ path: shot.clipPath, duration: shot.duration })),
      aspectRatio, quality: options.quality || "final", musicFile: music?.file, workDir, signal, progress: report });
    abort(signal);
    plan.output = { videoPath: result.videoPath, posterPath: result.posterPath, compositionPath: result.compositionPath,
      videoMeta: { ...result.meta, width: result.meta.W, height: result.meta.H, kind: "image_video", music: music?.meta || null, musicError: music?.failed || "", sceneCount: selected.length },
      exportedAt: Date.now() };
    const updated = await writePlan(id, plan, { signal });
    report({ phase: "image_video_done", message: `이미지 활용 영상 완성 — ${Number(result.meta.T).toFixed(1)}초`, entryId: id });
    return updated;
  }
  return { publicPlan, providers, configure, disconnect, prepare, savePlan, generate, refresh, recover, importClip, exportVideo };
}

module.exports = { createImageVideoService, downloadVideo, isPublicAddress };
