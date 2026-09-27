"use strict";

// Functional Node adaptation of the creator-supplied MotionBoardStudio 0.3.2
// orchestration. Provider clients, prompts, audio, and direction logic are reused.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createStore } = require("./store.cjs");
const { createRenderer } = require("./render.cjs");
const { createImageVideoService } = require("./image-video.cjs");
const specification = require("./specification.cjs");
const { createClaudeActivity } = require("./claude-activity.cjs");

async function createEngine({ sourceRoot, userData, nativeCall, emit = () => {}, authServices, testProviders = {} }) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(userData || "")) throw new Error("Absolute source and data directories are required.");
  if (typeof nativeCall !== "function") throw new Error("A native macOS callback is required.");
  const secrets = new Set();
  function redact(value) {
    let result = String(value);
    for (const secret of secrets) result = result.split(secret).join("[redacted]");
    return result.replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, "[redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|api[_-]?key|access[_-]?key|secret[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, "$1[redacted]");
  }
  function publicValue(value) {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(publicValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|api[_-]?key|client[_-]?secret|access[_-]?key|secret[_-]?key)$/i.test(key) ? "[redacted]" : publicValue(item)]));
    return value;
  }
  function rememberAuth(value) {
    for (const key of ["accessToken", "token", "refreshToken", "idToken", "apiKey", "accessKey", "secretKey"]) {
      if (typeof value?.[key] === "string" && value[key].length >= 8) secrets.add(value[key]);
    }
    return value;
  }
  const safeEmit = (event, payload) => emit(event, publicValue(payload));
  const library = name => require(path.join(sourceRoot, "lib", name));
  const codex = { ...library("codex.cjs"), ...(testProviders.codex || {}) };
  const claude = { ...library("claude.cjs"), ...(testProviders.claude || {}) };
  const prompt = library("prompt.cjs");
  const errors = library("llm-errors.cjs");
  const compose = library("video/compose.cjs");
  const pipeline = testProviders.pipeline || library("video/pipeline.cjs");
  const ffmpeg = testProviders.ffmpeg || library("video/ffmpeg.cjs");
  const { withImageFallback } = library("video/llm-fallback.cjs");
  const store = createStore(userData);
  await store.ensureDirs();
  const savedState = await store.readState();
  // The Mac host's explicit bundled path takes priority over a previously
  // selected external installation, keeping it paired with its encoder.
  if (!process.env.MOTION_BOARD_FFMPEG && typeof savedState.ffmpegPath === "string" && savedState.ffmpegPath) {
    process.env.MOTION_BOARD_FFMPEG = savedState.ffmpegPath;
  }
  const renderer = testProviders.renderer || createRenderer({ sourceRoot, nativeCall, ffmpeg });
  const services = authServices || await require("./auth.cjs").createAuthServices({ sourceRoot, nativeCall, emit: safeEmit, fetchImpl: testProviders.fetchImpl });
  const auth = services.chatgpt, claudeAuth = services.claude;
  await auth.init?.(); await claudeAuth.init?.();
  const promptsDir = path.join(sourceRoot, "prompts");
  const appVersion = JSON.parse(await fsp.readFile(path.join(sourceRoot, "package.json"), "utf8")).version;
  const providerName = provider => provider === "claude" ? "Claude" : "ChatGPT";
  const normalizeProvider = value => value === "claude" ? "claude" : "chatgpt";
  const normalizeMode = value => ["full", "image_only", "spec_only"].includes(value) ? value : "full";
  const operations = new Set();
  let currentRun = null, closing = false;
  const checkAbort = signal => { if (signal?.aborted) throw Object.assign(new Error("생성이 취소되었습니다."), { code: "CANCELLED" }); };
  const progress = (run, payload) => safeEmit("studio:progress", { runId: run.id, ...payload });
  const userMessage = error => {
    if (error?.code === "FFMPEG_MISSING") return '영상 제작에 필요한 ffmpeg를 찾지 못했습니다. 영상 옵션의 "ffmpeg 연결 / 설치 안내"에서 설치한 macOS용 실행 파일을 선택해 주세요. Homebrew를 사용한다면 터미널에서 "brew install ffmpeg"로 설치할 수 있습니다.';
    const message = errors.userMessage(error);
    const httpFailure = message.match(/^(ChatGPT|Claude) 요청 실패 \((\d{3})\):/);
    if (httpFailure) return `${httpFailure[1]} 요청에 실패했습니다 (HTTP ${httpFailure[2]}). 서버의 원문 응답은 표시하지 않습니다.`;
    return redact(message).slice(0, 1200);
  };
  const fail = error => ({ ok: false, error: userMessage(error), code: redact(error?.code || "") });

  function summary(entry) {
    return {
      id: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt || entry.createdAt,
      topic: entry.input?.topic || "", title: entry.title, provider: entry.provider || "chatgpt",
      mode: entry.input?.mode || entry.mode, model: entry.model, reasoningEffort: entry.reasoningEffort,
      imageModel: entry.imageModel || "", imageNote: entry.imageNote || "",
      hasImage: Boolean(entry.imagePath && fs.existsSync(entry.imagePath)),
      imageUrl: store.imageUrlForPath(entry.imagePath), imageError: entry.imageError || "",
      fallbackReason: entry.fallbackReason || "",
      hasVideo: Boolean(entry.videoPath && fs.existsSync(entry.videoPath)),
      videoUrl: store.videoUrlFor(entry.videoPath), posterUrl: store.videoUrlFor(entry.posterPath),
      videoError: entry.videoError || "", videoModel: entry.videoModel || "", videoProvider: entry.videoProvider || "",
      videoMeta: entry.videoMeta || null,
      hasImageVideo: Boolean(entry.imageVideo?.output?.videoPath && fs.existsSync(entry.imageVideo.output.videoPath))
    };
  }
  function publicEntry(entry) {
    return { ...summary(entry), input: entry.input, concept: entry.concept, yaml: entry.yaml,
      imagePrompt: entry.imagePrompt, notes: entry.notes || [], imageVideo: imageVideo.publicPlan(entry.imageVideo) };
  }
  async function entryFor(id) {
    const entry = (await store.readHistory()).find(item => item.id === id);
    if (!entry) throw new Error("기록을 찾을 수 없습니다. 명세를 먼저 생성하거나 기록에서 불러와 주세요.");
    return entry;
  }
  async function withRun(kind, entryId, action) {
    if (currentRun) throw new Error("이미 생성이 진행 중입니다. 완료되거나 취소된 뒤에 다시 시도해 주세요.");
    const run = { id: crypto.randomUUID(), entryId, kind, controller: new AbortController(), committed: false };
    currentRun = run;
    try { return await action(run, payload => progress(run, payload)); }
    finally { if (currentRun === run) currentRun = null; }
  }
  function protectActive(id) {
    if (currentRun && (!id || currentRun.entryId === id)) throw new Error("이 기록을 생성 중입니다. 완료되거나 취소된 뒤에 다시 시도해 주세요.");
  }

  const imageVideo = createImageVideoService({ sourceRoot, store, nativeCall, getEntry: entryFor, rememberAuth, errorMessage: userMessage, testProviders });
  const imageOperation = action => input => withRun("image-video", input.id, async (run, report) => {
    try {
      const entry = await action(input, { signal: run.controller.signal, report });
      run.committed = true;
      return { ok: true, canceled: Boolean(entry.operationCanceled), entry: publicEntry(entry) };
    } catch (error) {
      // Earlier shots may already have been accepted or downloaded. Return the
      // saved state with the error so the UI can resume without guessing/replay.
      const entry = await entryFor(input.id).catch(() => null);
      return { ...fail(error), ...(entry ? { entry: publicEntry(entry) } : {}) };
    }
  });

  async function runSpec(input) {
    return withRun("spec", null, async (run, report) => {
      const provider = normalizeProvider(input.provider), mode = normalizeMode(input.mode);
      const claudeOptions = specification.claudeOptions(input);
      const signal = run.controller.signal;
      report({ phase: "prepare", message: `${providerName(provider)} 로그인과 가이드를 확인하는 중…` });
      const guide = prompt.loadGuide(promptsDir);
      const contractMode = mode === "image_only" ? "image_only" : "full";
      const instructions = specification.instructionsForSpecification(prompt.buildInstructions({ guide: guide.content, mode: contractMode }), contractMode);
      const userText = prompt.buildUserMessage({ ...input, mode });
      const onDelta = delta => report({ phase: "stream", kind: delta.kind, text: delta.text, message: delta.kind === "status" ? delta.text : undefined });
      const requestSpecification = async (text, { repair = false } = {}) => {
        if (provider === "claude") {
          const { token } = rememberAuth(await claudeAuth.getAuth()); checkAbort(signal);
          if (!repair) report({ phase: "request", message: `${claude.DEFAULT_MODEL}에 제작 명세를 요청했습니다 · 추론 ${claudeOptions.effort} · 응답 대기 상한 ${claudeOptions.timeoutMs / 60_000}분` });
          const activity = createClaudeActivity({ fetchImpl: testProviders.fetchImpl, signal,
            timeoutMs: testProviders.specificationTimeoutMs ?? claudeOptions.timeoutMs,
            onProgress: payload => report({ phase: "spec_wait", ...payload }) });
          try {
            const response = await claude.chat({ token, instructions, userText: text, finalDirective: specification.directive(contractMode),
              model: claude.DEFAULT_MODEL, effort: claudeOptions.effort, signal: activity.signal,
              onDelta: delta => { activity.observeDelta(delta); onDelta(delta); }, fetchImpl: activity.fetchImpl });
            checkAbort(signal);
            if (activity.timeoutError) throw activity.timeoutError;
            return { ...response, requestedModel: claude.DEFAULT_MODEL, reasoningEffort: response.effort || claudeOptions.effort, fallbackReason: "" };
          } catch (error) {
            checkAbort(signal);
            throw activity.timeoutError || error;
          } finally { activity.dispose(); }
        }
        const { accessToken, accountId } = rememberAuth(await auth.getAuth()); checkAbort(signal);
        if (!repair) report({ phase: "request", message: `${codex.DEFAULT_MODEL}에 제작 명세를 요청했습니다…` });
        return codex.chat({ accessToken, accountId, instructions,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: text }] }],
          model: codex.DEFAULT_MODEL, reasoningEffort: codex.DEFAULT_REASONING, signal, onDelta, fetchImpl: testProviders.fetchImpl });
      };
      let result = await requestSpecification(userText);
      checkAbort(signal);
      report({ phase: "parse", message: "응답을 해석해 제작 명세를 정리하는 중…" });
      const parse = reply => specification.parseSpecificationResponse(reply, { mode: contractMode, normalizeResult: prompt.normalizeResult });
      const recordFailure = async (error, reply, attempt) => {
        await store.atomicWrite(path.join(store.baseDir, `failed-response-${run.id}-${attempt}.json`), JSON.stringify({
          provider, model: redact(reply.model || ""), message: userMessage(error), code: error.code || "", attempt,
          ...specification.responseDiagnostics(reply)
        }, null, 2), { signal }).catch(() => {});
      };
      let decoded;
      try { decoded = parse(result); }
      catch (error) {
        await recordFailure(error, result, 1);
        checkAbort(signal);
        if (!error.repairable) throw error;
        report({ phase: "spec_repair", message: `${providerName(provider)}의 응답 형식을 한 번 정리하는 중… 기존 내용과 검증 한계를 유지합니다.` });
        // Same selected provider, model and app account. Only malformed completed
        // specifications get one repair; auth, transport and truncation do not.
        result = await requestSpecification(specification.repairMessage(userText, result, contractMode), { repair: true });
        checkAbort(signal);
        try { decoded = parse(result); }
        catch (repairError) {
          await recordFailure(repairError, result, 2);
          if (repairError.code === "SPEC_FORMAT_INVALID") repairError.message = `${providerName(provider)} 응답 형식을 한 번 보정했지만 완성된 제작 명세 JSON을 받지 못했습니다. 입력은 유지되며 불완전한 결과는 저장하지 않았습니다.`;
          throw repairError;
        }
      }
      if (decoded.locallyRepaired) report({ phase: "spec_repaired", message: "응답의 줄바꿈 표기를 정리했습니다. 제작 내용은 그대로 유지했습니다." });
      const parsed = decoded.parsed;
      const entry = { id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(),
        input: { ...input, mode, ...(provider === "claude" ? { claudeEffort: claudeOptions.effort } : {}) }, provider,
        title: parsed.title, concept: parsed.concept, yaml: parsed.yaml, imagePrompt: parsed.imagePrompt, notes: parsed.notes,
        model: result.model, requestedModel: result.requestedModel, reasoningEffort: result.reasoningEffort,
        fallbackReason: result.fallbackReason || "", guideName: guide.name, imagePath: "", imageModel: "", imageNote: "", imageError: "" };
      await store.addEntry(entry, { signal }); run.committed = true;
      report({ phase: "spec_done", message: "명세 생성 완료 — " + entry.title, entryId: entry.id });
      return entry;
    });
  }

  async function runBoard({ id, promptOverride, aspectRatio }) {
    return withRun("board", id, async (run, report) => {
      const entry = await entryFor(id), signal = run.controller.signal;
      try {
        const boardPrompt = String(promptOverride || entry.imagePrompt || "").trim();
        if (!boardPrompt) throw new Error("이미지 지시문이 없습니다. 명세를 다시 생성해 주세요.");
        const state = await store.readState();
        if (Number(state.chatgptLimitUntil) > Date.now()) throw new Error(`ChatGPT 사용량 한도로 ${new Date(state.chatgptLimitUntil).toLocaleString("ko-KR")}까지 이미지 자동 생성이 불가능합니다. 외부 이미지 가져오기를 사용할 수 있습니다.`);
        report({ phase: "image_prepare", message: "ChatGPT 이미지 생성(4×4 디자인 보드)을 준비하는 중…" });
        const { accessToken, accountId } = rememberAuth(await auth.getAuth()); checkAbort(signal);
        const result = await codex.generateImage({ accessToken, accountId, prompt: boardPrompt,
          size: codex.openaiSizeFor(String(aspectRatio || entry.input?.aspectRatio || "1:1")), model: codex.DEFAULT_MODEL,
          signal, fetchImpl: testProviders.fetchImpl,
          onProgress: event => { if (event.phase === "image_partial") report({ phase: "image_stream", message: "보드 이미지를 그리는 중…" }); } });
        checkAbort(signal);
        if (!Buffer.isBuffer(result.buffer) || !result.buffer.length) throw new Error("생성된 이미지 데이터가 없습니다.");
        const file = store.imagePathFor(id);
        await store.atomicWrite(file, result.buffer, { signal });
        const updated = await store.updateEntry(id, { imagePath: file, imageModel: result.model,
          imageNote: result.fallbackReason || "", imageError: "" }, { signal });
        run.committed = true;
        report({ phase: "image_done", message: "디자인 보드 이미지 생성 완료", entryId: id });
        return updated;
      } catch (error) {
        if (error?.code === "LLM_USAGE_LIMIT") {
          const previous = await store.readState();
          await store.writeState({ ...previous, chatgptLimitUntil: Number(error.resetAt) || Date.now() + 86400000,
            chatgptLimitMessage: userMessage(error) }).catch(() => {});
        }
        await store.updateEntry(id, { imageError: userMessage(error) }).catch(() => {});
        throw error;
      }
    });
  }

  async function loadImage(file) {
    const result = await nativeCall("image.loadForModel", { path: file });
    if (!result?.data || !/^image\//.test(result.mediaType || "")) throw new Error("모델에 보낼 이미지를 읽을 수 없습니다.");
    return result;
  }
  function videoLlm(provider, run, report) {
    const signal = run.controller.signal;
    const onDelta = delta => report({ phase: "code_stream", kind: delta.kind, text: delta.text, message: delta.kind === "status" ? delta.text : undefined });
    if (provider === "claude") return async ({ instructions, userText, images, directive }) => {
      const { token } = rememberAuth(await claudeAuth.getAuth()); checkAbort(signal);
      const result = await claude.chat({ token, instructions, userText, images, finalDirective: directive || compose.OUTPUT_DIRECTIVE,
        model: claude.DEFAULT_MODEL, effort: claude.DEFAULT_EFFORT, signal, onDelta, fetchImpl: testProviders.fetchImpl });
      checkAbort(signal); return { content: result.content, model: result.model };
    };
    return withImageFallback(async ({ instructions, userText, images, directive }) => {
      const { accessToken, accountId } = rememberAuth(await auth.getAuth()); checkAbort(signal);
      const content = [{ type: "input_text", text: userText + "\n\n---\n\n" + (directive || compose.OUTPUT_DIRECTIVE) },
        ...(images || []).map(image => ({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` }))];
      const result = await codex.chat({ accessToken, accountId, instructions, input: [{ type: "message", role: "user", content }],
        model: codex.DEFAULT_MODEL, reasoningEffort: codex.DEFAULT_REASONING, signal, onDelta, fetchImpl: testProviders.fetchImpl });
      checkAbort(signal); return { content: result.content, model: result.model };
    }, { isTerminal: error => errors.isTerminal(error), isCancelled: () => signal.aborted,
      onFallback: error => report({ phase: "compose", message: "보드 이미지 첨부 요청이 실패해 명세만으로 다시 요청합니다: " + userMessage(error).slice(0, 160) }) });
  }

  async function runVideo({ id, options = {} }) {
    return withRun("video", id, async (run, report) => {
      const entry = await entryFor(id), signal = run.controller.signal;
      if (!entry.yaml && !entry.imagePrompt) throw new Error("영상을 만들 제작 명세가 없습니다.");
      const provider = normalizeProvider(options.provider || entry.provider);
      const workDir = path.join(store.videoDirFor(id), "run-" + run.id);
      try {
        report({ phase: "video_prepare", message: `영상 제작 준비 — ${providerName(provider)}${entry.imagePath ? " · 보드 이미지 참고" : " · 명세로 제작"}` });
        const result = await pipeline.runVideo({ entry, options, workDir, cacheDir: store.musicCacheDir,
          llm: videoLlm(provider, run, report), loadImage, renderer, progress: report, signal, fetchImpl: testProviders.fetchImpl });
        checkAbort(signal);
        if (!result.videoPath || !path.resolve(result.videoPath).startsWith(workDir + path.sep) || !fs.existsSync(result.videoPath)) throw new Error("완성된 영상 파일을 확인하지 못했습니다.");
        const updated = await store.updateEntry(id, { videoPath: result.videoPath, posterPath: result.posterPath,
          compositionPath: result.compositionPath, videoMeta: result.meta, videoModel: result.model || "", videoProvider: provider, videoError: "" }, { signal });
        run.committed = true;
        // Previous runs remain recoverable. A failed/cancelled regeneration never
        // removes the currently referenced video, image, poster, or composition.
        report({ phase: "video_done", message: `영상 완성 — ${Number(result.meta.T).toFixed(2)}초 · ${result.meta.frames}프레임`, entryId: id });
        return updated;
      } catch (error) {
        await store.updateEntry(id, { videoError: userMessage(error) }).catch(() => {});
        throw error;
      }
    });
  }

  async function saveAs(entry, kind, videoKind) {
    const source = kind === "video" ? (videoKind === "image_video" ? entry.imageVideo?.output?.videoPath : entry.videoPath) : entry.imagePath;
    if (!source || !fs.existsSync(source)) throw new Error("저장할 파일이 없습니다.");
    const extension = path.extname(source).slice(1) || (kind === "video" ? "mp4" : "png");
    const label = kind === "video" ? (videoKind === "image_video" ? "이미지영상" : "영상") : "디자인보드";
    const result = await nativeCall("dialog.save", { options: { title: label + " 저장",
      defaultPath: path.join(os.homedir(), "Downloads", `${prompt.sanitizeFileName(entry.title, "motion")}_${label}.${extension}`),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } });
    if (result.canceled || !result.filePath) return { ok: true, saved: false };
    if (path.resolve(result.filePath) !== path.resolve(source)) await store.atomicWrite(result.filePath, await fsp.readFile(source));
    return { ok: true, saved: true, filePath: result.filePath };
  }
  async function installFfmpeg() {
    const existing = ffmpeg.locate({ refresh: true });
    if (existing) return { ok: true, ffmpeg: existing };
    const answer = await nativeCall("dialog.message", { options: { type: "question", title: "ffmpeg 연결",
      message: "영상 제작에 사용할 macOS용 ffmpeg가 필요합니다.",
      detail: "설치한 ffmpeg 실행 파일을 선택하거나 공식 설치 안내를 열 수 있습니다. Homebrew를 사용한다면 터미널에서 brew install ffmpeg로 설치할 수 있습니다.",
      buttons: ["실행 파일 선택", "설치 안내", "취소"], defaultId: 0, cancelId: 2 } });
    if (answer.response === 1) {
      await nativeCall("shell.openExternal", { url: "https://ffmpeg.org/download.html#build-mac" });
      return { ok: true, canceled: true };
    }
    if (answer.response !== 0) return { ok: true, canceled: true };
    const choice = await nativeCall("dialog.open", { options: { title: "ffmpeg 실행 파일 선택", properties: ["openFile"] } });
    if (choice.canceled || !choice.filePaths?.[0]) return { ok: true, canceled: true };
    const previous = process.env.MOTION_BOARD_FFMPEG;
    process.env.MOTION_BOARD_FFMPEG = choice.filePaths[0];
    const found = ffmpeg.locate({ refresh: true });
    if (!found || path.resolve(found.ffmpeg) !== path.resolve(choice.filePaths[0])) {
      if (previous === undefined) delete process.env.MOTION_BOARD_FFMPEG; else process.env.MOTION_BOARD_FFMPEG = previous;
      throw new Error("선택한 파일을 ffmpeg로 실행하지 못했습니다. macOS용 실행 파일인지 확인해 주세요.");
    }
    await store.writeState({ ...(await store.readState()), ffmpegPath: found.ffmpeg });
    safeEmit("studio:progress", { phase: "ffmpeg", message: `ffmpeg ${found.version || ""} 연결 완료` });
    return { ok: true, ffmpeg: found };
  }

  const handlers = {
    "studio:env": async () => ({ ok: true, ffmpeg: ffmpeg.locate(), model: codex.DEFAULT_MODEL, reasoningEffort: codex.DEFAULT_REASONING,
      claudeModel: claude.DEFAULT_MODEL, claudeEffort: specification.DEFAULT_CLAUDE_EFFORT, guideName: prompt.loadGuide(promptsDir).name,
      appVersion, dataDir: store.baseDir, platform: "darwin" }),
    "studio:guide": async () => { const guide = prompt.loadGuide(promptsDir); return { ok: true, name: guide.name, content: guide.content }; },
    "studio:authStatus": async () => ({ ok: true, status: await auth.status() }),
    "studio:authLogin": async () => ({ ok: true, status: await auth.login() }),
    "studio:authLogout": async () => ({ ok: true, status: await auth.logout() }),
    "studio:claudeStatus": async () => ({ ok: true, status: await claudeAuth.status() }),
    "studio:claudeLoginStart": async () => ({ ok: true, ...(await claudeAuth.loginStart()) }),
    "studio:claudeLoginComplete": async ({ code }) => ({ ok: true, status: await claudeAuth.loginComplete(code) }),
    "studio:claudeLoginCancel": async () => { await claudeAuth.cancelLogin(); return { ok: true }; },
    "studio:claudeLogout": async () => ({ ok: true, status: await claudeAuth.logout() }),
    "studio:spec": async input => ({ ok: true, entry: publicEntry(await runSpec(input)) }),
    "studio:board": async input => ({ ok: true, entry: publicEntry(await runBoard(input)) }),
    "studio:video": async input => ({ ok: true, entry: publicEntry(await runVideo(input)) }),
    "studio:imageVideoProviders": imageVideo.providers,
    "studio:imageVideoConfigure": input => { protectActive(); return imageVideo.configure(input); },
    "studio:imageVideoDisconnect": input => { protectActive(); return imageVideo.disconnect(input); },
    "studio:imageVideoPrepare": imageOperation(imageVideo.prepare),
    "studio:imageVideoSavePlan": imageOperation(imageVideo.savePlan),
    "studio:imageVideoGenerate": imageOperation(imageVideo.generate),
    "studio:imageVideoRefresh": imageOperation(imageVideo.refresh),
    "studio:imageVideoRecover": imageOperation(imageVideo.recover),
    "studio:imageVideoImportClip": imageOperation(imageVideo.importClip),
    "studio:imageVideoExport": imageOperation(imageVideo.exportVideo),
    "studio:installFfmpeg": installFfmpeg,
    "studio:pickMusic": async () => {
      const result = await nativeCall("dialog.open", { options: { title: "영상에 쓸 음악 파일 선택", properties: ["openFile"],
        filters: [{ name: "오디오", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] }] } });
      return result.canceled || !result.filePaths?.[0] ? { ok: true, canceled: true } : { ok: true, file: result.filePaths[0] };
    },
    "studio:videoSaveAs": async ({ id, kind }) => saveAs(await entryFor(id), "video", kind),
    "studio:videoReveal": async ({ id, which, kind }) => {
      const entry = await entryFor(id), result = kind === "image_video" ? entry.imageVideo?.output : entry;
      const file = which === "code" ? result?.compositionPath : result?.videoPath;
      if (!file || !fs.existsSync(file)) throw new Error("표시할 파일이 없습니다.");
      await nativeCall("shell.reveal", { path: file }); return { ok: true };
    },
    "studio:cancel": async () => {
      if (!currentRun || currentRun.committed) return { ok: false, error: "진행 중인 생성이 없습니다." };
      currentRun.controller.abort(); return { ok: true };
    },
    "studio:history": async () => ({ ok: true, entries: (await store.readHistory()).map(summary) }),
    "studio:historyGet": async ({ id }) => ({ ok: true, entry: publicEntry(await entryFor(id)) }),
    "studio:historyRemove": async ({ id }) => { protectActive(id); return { ok: true, ...(await store.removeEntry(id)) }; },
    "studio:imageImport": async ({ id }) => {
      protectActive(id); const entry = await entryFor(id);
      const result = await nativeCall("dialog.open", { options: { title: "보드 이미지 가져오기", properties: ["openFile"],
        filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "webp"] }] } });
      const source = result.filePaths?.[0];
      if (result.canceled || !source) return { ok: true, canceled: true };
      protectActive(id);
      await loadImage(source);
      const extension = path.extname(source).toLowerCase();
      const target = store.imagePathFor(id, extension);
      await store.atomicWrite(target, await fsp.readFile(source));
      const updated = await store.updateEntry(id, { imagePath: target, imageModel: "외부 이미지",
        imageNote: "가져온 이미지 (ChatGPT 웹 등 외부 도구에서 생성)", imageError: "" });
      return { ok: true, entry: publicEntry(updated) };
    },
    "studio:imageSaveAs": async ({ id }) => saveAs(await entryFor(id), "image"),
    "studio:reveal": async ({ id }) => {
      const entry = await entryFor(id);
      if (!entry.imagePath || !fs.existsSync(entry.imagePath)) throw new Error("표시할 보드 이미지가 없습니다.");
      await nativeCall("shell.reveal", { path: entry.imagePath }); return { ok: true };
    },
    "studio:openDataDir": async () => { await store.ensureDirs(); await nativeCall("shell.openPath", { path: store.baseDir }); return { ok: true }; },
    "studio:openExternal": async ({ url }) => {
      const parsed = new URL(String(url || ""));
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("허용되지 않은 주소입니다.");
      await nativeCall("shell.openExternal", { url: parsed.href }); return { ok: true };
    }
  };

  function invoke(method, params = {}) {
    if (closing) return Promise.resolve({ ok: false, code: "SHUTDOWN", error: "앱을 종료하는 중입니다." });
    if (!Object.hasOwn(handlers, method)) return Promise.resolve({ ok: false, code: "UNKNOWN_METHOD", error: "지원하지 않는 앱 요청입니다." });
    const task = Promise.resolve().then(() => handlers[method](params || {})).then(publicValue).catch(fail);
    operations.add(task); task.finally(() => operations.delete(task));
    return task;
  }
  async function shutdown() {
    closing = true;
    currentRun?.controller.abort();
    await Promise.allSettled([auth.cancelLogin?.(), claudeAuth.cancelLogin?.()]);
    await renderer.shutdown?.();
    await Promise.allSettled(Array.from(operations));
    await store.flush();
  }
  return { invoke, shutdown, methods: Object.freeze(Object.keys(handlers)), resolveMedia: url => store.resolveMedia(url) };
}

module.exports = { createEngine };
