"use strict";

const path = require("node:path");

// The official Kling CLI owns OAuth and is a client of Kling's member-account
// MCP service. The application never reads its credentials or falls back to an
// API key. Contract checked against @klingai/cli-global 0.2.0 on 2026-09-28:
// https://github.com/klingai-tech/skills/blob/main/reference.md
// https://github.com/klingai-tech/skills/blob/main/api-examples.md
const CATALOG = Object.freeze({
  id: "kling", label: "Kling", transport: "kling-cli", model: "kling-video-v2_6",
  durations: Object.freeze([5, 10]), resolutions: Object.freeze(["720p", "1080p"]),
  aspectRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]),
  setupURL: "https://github.com/klingai-tech/skills", supportsExternalTaskId: false,
  minImageDimension: 300, inputDeterminesAspectRatio: true, billing: "member-credits"
});

const READ_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_+=./:-]{0,1023}$/;
const MEMBERSHIPS = new Set(["NORMAL", "VIP", "SVIP", "SSVIP", "SSSVIP"]);
const PENDING = new Set(["submitted", "pending", "queuing", "queueing", "processing", "running"]);
const SUCCEEDED = new Set(["succeed", "succeeded", "success", "completed", "partial_completed"]);
const FAILED = new Set(["failed", "failure", "cancelled", "canceled", "expired", "rejected"]);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function cancelled() { return failure("CANCELLED", "Kling 작업 확인을 취소했습니다."); }
function uncertain() {
  return failure("SUBMISSION_UNCONFIRMED", "Kling 요청의 접수 여부를 확인하지 못했습니다. 구독 크레딧이 사용되었을 수 있으므로 Kling의 작업 내역을 확인해 주세요. 자동으로 다시 생성하지 않습니다.");
}
function invalidResponse() { return failure("PROVIDER_RESPONSE_INVALID", "Kling의 응답을 확인하지 못했습니다. 저장된 작업 번호로 다시 확인해 주세요."); }
function unavailable() { return failure("VIDEO_PROVIDER_UNAVAILABLE", "Kling CLI에 연결하지 못했습니다. CLI 설치와 로그인 상태를 확인해 주세요."); }
function authRejected() { return failure("VIDEO_AUTH_REJECTED", "Kling CLI에서 구독 계정으로 로그인해 주세요. 앱은 API 키를 사용하지 않습니다."); }
function capabilitiesUnavailable() { return failure("VIDEO_CAPABILITIES_UNAVAILABLE", "로그인한 Kling 계정에서 선택한 영상 모델의 설정을 확인하지 못했습니다. 연결 상태를 새로 확인해 주세요."); }

function dependencies(run, executable) {
  if (typeof run !== "function" || typeof executable !== "string" || !executable || /[\x00\r\n]/u.test(executable)) {
    throw new TypeError("A Kling CLI executable and process runner are required.");
  }
}

function parseEnvelope(result) {
  if (!result || typeof result.stdout !== "string" || result.stdout.length > MAX_OUTPUT_LENGTH) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.ok !== "boolean" ||
        !Number.isInteger(parsed.status) || !parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) return null;
    return parsed;
  } catch { return null; }
}

function rejection(status) {
  if (status === 401 || status === 403) return authRejected();
  if (status === 429) return failure("VIDEO_PROVIDER_REJECTED", "Kling 계정의 남은 크레딧 또는 요청 한도를 확인해 주세요.");
  return failure("VIDEO_PROVIDER_REJECTED", "Kling이 요청을 거절했습니다. 계정과 장면 설정을 확인해 주세요.");
}

async function command({ run, executable, signal }, args, submission = false) {
  if (signal?.aborted) throw cancelled();
  let result;
  try {
    result = await run(executable, args, { signal, timeoutMs: submission ? SUBMIT_TIMEOUT_MS : READ_TIMEOUT_MS });
  } catch (error) {
    // A runner can prove that exec never started. All other submission failures
    // are uncertain, including cancellation after the upload or MCP call began.
    if (submission && error?.started !== false) throw uncertain();
    if (signal?.aborted || error?.code === "CANCELLED") throw cancelled();
    if (error?.code === "CLI_NOT_FOUND" || error?.code === "ENOENT") {
      throw failure("CLI_NOT_FOUND", "Kling CLI를 설치한 뒤 구독 계정으로 로그인해 주세요.");
    }
    throw unavailable();
  }
  const envelope = parseEnvelope(result);
  if (!envelope) {
    if (submission) throw uncertain();
    if (signal?.aborted) throw cancelled();
    if (result?.exitCode !== 0) throw unavailable();
    throw invalidResponse();
  }
  // A valid acknowledgement is retained even if cancellation raced with CLI
  // shutdown. Never discard a known charged job solely because exitCode != 0.
  if (envelope.ok && envelope.status >= 200 && envelope.status < 300) return envelope.body;
  if (envelope.status >= 400 && envelope.status < 500 && envelope.status !== 408) throw rejection(envelope.status);
  if (submission) throw uncertain();
  if (signal?.aborted) throw cancelled();
  throw unavailable();
}

function permitted(argument, value) {
  return argument && (argument.allowedValues === undefined ||
    (Array.isArray(argument.allowedValues) && argument.allowedValues.some(item => String(item) === String(value))));
}

function capabilities(body) {
  if (body.authMode !== "oauth") throw authRejected();
  // The current service wraps model lists in { models }, while the official
  // reference also documents the earlier direct-array representation.
  const declaration = body.availableModels?.image_to_video;
  const models = Array.isArray(declaration) ? declaration : declaration?.models;
  if (!Array.isArray(models)) throw capabilitiesUnavailable();
  const spec = models.find(model => model?.model === CATALOG.model);
  if (!spec || !Array.isArray(spec.arguments) || !Array.isArray(spec.inputs)) throw capabilitiesUnavailable();
  const args = new Map();
  for (const arg of spec.arguments) {
    if (!arg || typeof arg.name !== "string" || args.has(arg.name)) throw capabilitiesUnavailable();
    args.set(arg.name, arg);
  }
  const supplied = new Set(["prompt", "duration", "resolution", "imageCount", "enable_audio"]);
  if ([...args.values()].some(arg => arg.required && !supplied.has(arg.name) && arg.default === undefined)) throw capabilitiesUnavailable();
  if (!args.has("prompt") || !permitted(args.get("imageCount"), "1") || !permitted(args.get("enable_audio"), "false")) throw capabilitiesUnavailable();
  // The CLI maps --image to the first declared input. Do not upload a scene if
  // a changed model now requires extra images or has another first input.
  if (spec.inputs[0]?.name !== "first_image" || spec.inputs.some((item, index) => index > 0 && item?.required)) throw capabilitiesUnavailable();
  const durations = CATALOG.durations.filter(value => permitted(args.get("duration"), value));
  const resolutions = CATALOG.resolutions.filter(value => permitted(args.get("resolution"), value));
  if (!durations.length || !resolutions.length) throw capabilitiesUnavailable();
  return { model: CATALOG.model, durations, resolutions };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("INVALID_VIDEO_INPUT", "영상 장면 입력을 확인해 주세요.");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  // CLI 0.2.0 has no end-of-options delimiter. Reject a leading flag instead of
  // silently changing the prompt or allowing it to become an extra CLI option.
  if (!prompt || prompt.length > 2500 || prompt.startsWith("--") || prompt.includes("\0")) {
    throw failure("INVALID_VIDEO_INPUT", "움직임 설명은 1~2500자로 입력하고 --로 시작하지 않도록 해 주세요.");
  }
  if (typeof input.imagePath !== "string" || !path.isAbsolute(input.imagePath) || input.imagePath.includes("\0")) {
    throw failure("INVALID_VIDEO_INPUT", "Kling에 전달할 장면 이미지 파일을 확인해 주세요.");
  }
  const duration = input.duration ?? 5, resolution = input.resolution ?? "720p";
  if ((input.model !== undefined && input.model !== CATALOG.model) || !CATALOG.durations.includes(duration) ||
      !CATALOG.resolutions.includes(resolution) ||
      (input.aspectRatio !== undefined && !CATALOG.aspectRatios.includes(input.aspectRatio))) {
    throw failure("INVALID_VIDEO_OPTIONS", "Kling 구독에서 지원하는 영상 길이와 해상도를 선택해 주세요.");
  }
  return { prompt, imagePath: input.imagePath, duration, resolution, aspectRatio: input.aspectRatio };
}

function jobIdentifier(value) { return typeof value === "string" && ID_PATTERN.test(value); }
function generationId(body) {
  const id = body.generationId ?? body.generation_id;
  if (body.generationId !== undefined && body.generation_id !== undefined && body.generationId !== body.generation_id) return null;
  return jobIdentifier(id) ? id : null;
}
function normalizedStatus(value) { return typeof value === "string" ? value.toLowerCase() : ""; }
function videoURL(value) {
  if (typeof value !== "string" || value.length > 8192) throw invalidResponse();
  let url;
  try { url = new URL(value); } catch { throw invalidResponse(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port || url.hash) throw invalidResponse();
  // Downloads are performed without authentication and validate DNS/redirects
  // at the existing media boundary. Keep the service's regular watermarked URL.
  return url.href;
}

async function inspectKlingSubscription({ run, executable, signal } = {}) {
  dependencies(run, executable);
  const result = { configured: false, authMode: null, model: CATALOG.model, durations: [], resolutions: [], membership: null, credits: null };
  try {
    const who = await command({ run, executable, signal }, ["who_am_i"]);
    if (who.authMode === "oauth") result.authMode = "oauth";
    Object.assign(result, capabilities(who));
    const account = await command({ run, executable, signal }, ["account"]);
    if (!MEMBERSHIPS.has(account.membershipType) || typeof account.availableRemainCredits !== "number" ||
        !Number.isFinite(account.availableRemainCredits) || account.availableRemainCredits < 0) throw invalidResponse();
    result.membership = account.membershipType;
    result.credits = account.availableRemainCredits;
    result.configured = true;
  } catch (error) {
    // Never expose stderr, raw bodies, user identifiers, credential paths, or
    // error causes. A caller can safely show this bounded diagnostic in the UI.
    result.errorCode = error.code || "VIDEO_PROVIDER_UNAVAILABLE";
    result.message = error.message;
  }
  return result;
}

function createKlingSubscriptionProvider({ run, executable } = {}) {
  dependencies(run, executable);
  return Object.freeze({
    async submit(input, { signal } = {}) {
      if (signal?.aborted) throw cancelled();
      const options = validateInput(input);
      const live = capabilities(await command({ run, executable, signal }, ["who_am_i"]));
      if (!live.durations.includes(options.duration) || !live.resolutions.includes(options.resolution)) throw capabilitiesUnavailable();
      const body = await command({ run, executable, signal }, [
        "image_to_video", "--model", CATALOG.model, "--image", options.imagePath,
        "--duration", String(options.duration), "--resolution", options.resolution,
        "--enable_audio", "false", "--imageCount", "1", "--poll", "0", options.prompt
      ], true);
      const jobId = generationId(body);
      if (!jobId) throw uncertain();
      const metadata = { provider: "kling", transport: CATALOG.transport, billing: CATALOG.billing,
        model: CATALOG.model, duration: options.duration, resolution: options.resolution, audio: false,
        aspectRatioMode: "source-image", requestedCompositionAspectRatio: options.aspectRatio ?? null };
      if (typeof body.creditsConsumed === "number" && Number.isFinite(body.creditsConsumed) && body.creditsConsumed >= 0) metadata.creditsConsumed = body.creditsConsumed;
      return { jobId, status: "pending", metadata };
    },
    async poll(jobId, { signal } = {}) {
      if (!jobIdentifier(jobId)) throw failure("INVALID_VIDEO_JOB", "Kling 작업 번호를 확인해 주세요.");
      const body = await command({ run, executable, signal }, ["query_tasks", "--poll", "0", jobId]);
      if (generationId(body) !== jobId) throw invalidResponse();
      const status = normalizedStatus(body.status);
      if (PENDING.has(status)) return { status: "pending" };
      if (FAILED.has(status)) return { status: "failed", error: "Kling에서 영상 생성이 완료되지 않았습니다. 서비스의 작업 내역을 확인해 주세요." };
      if (SUCCEEDED.has(status)) {
        if (!Array.isArray(body.works)) throw invalidResponse();
        const work = body.works.find(item => item?.contentType === "video" && SUCCEEDED.has(normalizedStatus(item.status)) && typeof item.url === "string");
        if (!work) throw invalidResponse();
        return { status: "succeeded", videoUrl: videoURL(work.url),
          ...(status === "partial_completed" ? { metadata: { partialCompletion: true } } : {}) };
      }
      throw invalidResponse();
    }
  });
}

module.exports = { CATALOG, createKlingSubscriptionProvider, inspectKlingSubscription };
