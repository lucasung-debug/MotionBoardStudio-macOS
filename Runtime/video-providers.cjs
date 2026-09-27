"use strict";

const { createHmac } = require("node:crypto");

// Public contracts inspected on 2026-09-27. The catalog is deliberately bounded:
// adding a model requires checking its image, duration, resolution and API contract.
// https://docs.x.ai/developers/model-capabilities/video/image-to-video
// https://docs.x.ai/developers/model-capabilities/video/generation
// https://kling.ai/document-api/api/get-started/authentication
// https://kling.ai/document-api/api/video/2-6/image-to-video/legacy
// https://kling.ai/document-api/guides/capability-map/video
const PROVIDERS = Object.freeze({
  grok: Object.freeze({
    id: "grok", label: "Grok", model: "grok-imagine-video-1.5",
    durations: Object.freeze(Array.from({ length: 15 }, (_, index) => index + 1)),
    resolutions: Object.freeze(["480p", "720p", "1080p"]),
    aspectRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]),
    pricingURL: "https://docs.x.ai/developers/models/grok-imagine-video-1.5",
    setupURL: "https://console.x.ai/", supportsExternalTaskId: false, inputDeterminesAspectRatio: true
  }),
  kling: Object.freeze({
    id: "kling", label: "Kling", model: "kling-v2-6",
    durations: Object.freeze([5, 10]), resolutions: Object.freeze(["720p", "1080p"]),
    aspectRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]),
    pricingURL: "https://kling.ai/document-api/pricing/base/video",
    setupURL: "https://kling.ai/document-api/api/get-started/authentication",
    supportsExternalTaskId: true, minImageDimension: 300, inputDeterminesAspectRatio: true
  })
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Conservative app limit, also Kling's documented limit.
const MAX_PROMPT_LENGTH = 2500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const BASES = Object.freeze({ grok: "https://api.x.ai/v1/videos", kling: "https://api-singapore.klingai.com/v1/videos/image2video" });

function failure(code, message, httpStatus) {
  const error = Object.assign(new Error(message), { code });
  if (Number.isInteger(httpStatus)) error.httpStatus = httpStatus;
  return error;
}

function cancelled() { return failure("CANCELLED", "영상 서비스 요청 확인을 취소했습니다."); }
function uncertain(httpStatus) {
  return failure("SUBMISSION_UNCONFIRMED", "영상 생성 요청의 접수 여부를 확인하지 못했습니다. 이미 요금이 발생했을 수 있으므로 서비스의 작업 내역을 확인한 뒤 다시 생성해 주세요.", httpStatus);
}
function invalidResponse() { return failure("PROVIDER_RESPONSE_INVALID", "영상 서비스의 응답 형식을 확인할 수 없습니다. 기존 작업 번호로 다시 확인해 주세요."); }

function requireCredential(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw failure("VIDEO_CREDENTIALS_MISSING", "영상 서비스 연결 정보를 설정해 주세요.");
  }
  return value;
}

function imageDimensions(bytes, mediaType) {
  if (mediaType === "image/png" && bytes.length >= 45 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
      bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mediaType === "image/jpeg" && bytes.length >= 12 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  throw failure("INVALID_VIDEO_INPUT", "이미지 형식과 파일 내용이 맞지 않습니다. 정상적인 PNG 또는 JPEG 파일을 사용해 주세요.");
}

function validateInput(input, catalog) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("INVALID_VIDEO_INPUT", "영상 생성 입력을 확인해 주세요.");
  const { imageBase64, mediaType, model, externalTaskId } = input;
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw failure("INVALID_VIDEO_INPUT", "움직임 설명은 1~2500자로 입력해 주세요.");
  if (model !== undefined && model !== catalog.model) throw failure("INVALID_VIDEO_OPTIONS", "지원하지 않는 영상 모델입니다.");
  if (!["image/png", "image/jpeg"].includes(mediaType)) throw failure("INVALID_VIDEO_INPUT", "PNG 또는 JPEG 이미지를 사용해 주세요.");
  if (typeof imageBase64 !== "string" || !imageBase64 || imageBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    throw failure("INVALID_VIDEO_INPUT", "이미지 데이터를 확인해 주세요. 이미지 한 장은 10MB 이하여야 합니다.");
  }
  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== imageBase64) {
    throw failure("INVALID_VIDEO_INPUT", "이미지 데이터를 확인해 주세요. 이미지 한 장은 10MB 이하여야 합니다.");
  }
  // The native/media boundary decodes the image before this call. Inspect the
  // format and dimensions again so direct callers cannot bypass provider limits.
  const { width, height } = imageDimensions(bytes, mediaType);
  if (!width || !height) throw failure("INVALID_VIDEO_INPUT", "이미지 크기를 확인할 수 없습니다.");
  if (catalog.id === "kling" && (width < 300 || height < 300 || width / height < 0.4 || width / height > 2.5)) {
    throw failure("INVALID_VIDEO_INPUT", "Kling 이미지는 가로·세로 300px 이상이며 화면비는 1:2.5~2.5:1 범위여야 합니다.");
  }
  const duration = input.duration ?? 5, resolution = input.resolution ?? "720p", aspectRatio = input.aspectRatio;
  if (!catalog.durations.includes(duration) || !catalog.resolutions.includes(resolution) ||
      (aspectRatio !== undefined && !catalog.aspectRatios.includes(aspectRatio))) {
    throw failure("INVALID_VIDEO_OPTIONS", "선택한 서비스에서 지원하는 길이, 해상도, 화면비를 선택해 주세요.");
  }
  if (externalTaskId !== undefined && (typeof externalTaskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(externalTaskId))) {
    throw failure("INVALID_VIDEO_INPUT", "영상 작업 식별자가 올바르지 않습니다.");
  }
  return { imageBase64, mediaType, prompt, duration, resolution, aspectRatio, externalTaskId, width, height };
}

function validateJobId(jobId) {
  if (typeof jobId !== "string" || !ID_PATTERN.test(jobId)) throw failure("INVALID_VIDEO_JOB", "영상 서비스의 작업 번호가 올바르지 않습니다.");
  return jobId;
}

function videoURL(value, secrets) {
  if (typeof value !== "string" || value.length > 8192 || secrets.some(secret => value.includes(secret))) throw invalidResponse();
  let url;
  try { url = new URL(value); } catch { throw invalidResponse(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !url.hostname) throw invalidResponse();
  // The caller downloads the result without provider credentials and validates the
  // destination/redirects separately; signed provider CDN URLs may change hosts.
  return url.href;
}

function createVideoProvider({ provider, credentials, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw failure("UNKNOWN_VIDEO_PROVIDER", "지원하지 않는 영상 서비스입니다.");
  if (typeof fetchImpl !== "function" || typeof now !== "function") throw new TypeError("Invalid video provider dependencies.");
  const catalog = PROVIDERS[provider];
  // Credentials are supplied by the app's own Keychain boundary. Never read env,
  // other applications' stores, OAuth connector tokens, or arbitrary base URLs.
  const secret = provider === "grok"
    ? { apiKey: requireCredential(credentials?.apiKey) }
    : { accessKey: requireCredential(credentials?.accessKey), secretKey: requireCredential(credentials?.secretKey) };
  const secrets = Object.values(secret);
  function authorization() {
    if (provider === "grok") return `Bearer ${secret.apiKey}`;
    const seconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw failure("INVALID_VIDEO_CLOCK", "시스템 날짜와 시간을 확인해 주세요.");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: secret.accessKey, exp: seconds + 1800, nbf: seconds - 5 })).toString("base64url");
    const signingInput = `${header}.${payload}`;
    return `Bearer ${signingInput}.${createHmac("sha256", secret.secretKey).update(signingInput).digest("base64url")}`;
  }

  async function request(url, { method, body, signal }) {
    if (signal?.aborted) throw cancelled();
    const submission = method === "POST";
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let response;
    // Resolve auth before the request starts so a local clock error is not
    // incorrectly reported as a potentially charged submission.
    const headers = { Authorization: authorization(), Accept: "application/json" };
    if (submission) headers["Content-Type"] = "application/json";
    try {
      response = await fetchImpl(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: requestSignal, redirect: "error" });
    } catch {
      if (submission) throw uncertain();
      if (signal?.aborted) throw cancelled();
      throw failure("VIDEO_PROVIDER_UNAVAILABLE", "영상 서비스에 연결하지 못했습니다. 저장된 작업 번호로 다시 확인할 수 있습니다.");
    }
    // Do not expose or log provider error bodies: they may echo credentials,
    // prompts or image data. Neither submissions nor polls retry automatically.
    if (!response || !Number.isInteger(response.status)) throw submission ? uncertain() : invalidResponse();
    if (response.status < 200 || response.status >= 300) {
      if (submission && (response.status >= 500 || response.status === 408 || response.status < 400)) throw uncertain(response.status);
      if (response.status >= 500 || response.status === 408) throw failure("VIDEO_PROVIDER_UNAVAILABLE", "영상 서비스가 응답하지 않습니다. 저장된 작업 번호로 다시 확인해 주세요.", response.status);
      const code = [401, 403].includes(response.status) ? "VIDEO_AUTH_REJECTED" : "VIDEO_PROVIDER_REJECTED";
      throw failure(code, response.status === 429 ? "영상 서비스의 잔액 또는 요청 한도를 확인해 주세요." : "영상 서비스가 요청을 거절했습니다. 연결 정보와 생성 설정을 확인해 주세요.", response.status);
    }
    try {
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data;
    } catch { throw submission ? uncertain() : (signal?.aborted ? cancelled() : invalidResponse()); }
  }

  function klingSuccess(data, submission) {
    if (data.code === 0) return;
    if (Number.isInteger(data.code) && data.code >= 1000 && data.code < 2000) {
      throw failure(data.code < 1100 ? "VIDEO_AUTH_REJECTED" : "VIDEO_PROVIDER_REJECTED", "Kling이 요청을 거절했습니다. 연결 정보, 잔액과 생성 설정을 확인해 주세요.");
    }
    throw submission ? uncertain() : invalidResponse();
  }

  return Object.freeze({
    async submit(input, { signal } = {}) {
      if (signal?.aborted) throw cancelled();
      const options = validateInput(input, catalog);
      const { imageBase64, mediaType, prompt, duration, resolution, aspectRatio, externalTaskId } = options;
      let body, url;
      if (provider === "grok") {
        url = `${BASES.grok}/generations`;
        body = { model: catalog.model, prompt, image: { url: `data:${mediaType};base64,${imageBase64}` }, duration, resolution };
        // xAI stretches an image if aspect_ratio is sent. Preserve the source
        // image instead; the final compositor can letterbox to the requested ratio.
        // xAI does not document external_task_id or idempotent resubmission.
      } else {
        url = BASES.kling;
        body = { model_name: catalog.model, image: imageBase64, prompt, duration: String(duration), mode: resolution === "1080p" ? "pro" : "std", sound: "off" };
        if (externalTaskId !== undefined) body.external_task_id = externalTaskId;
        // Kling's image-to-video ratio follows the image. The caller prepares a
        // correctly proportioned frame; aspect_ratio is not a documented field.
      }
      const data = await request(url, { method: "POST", body, signal });
      if (provider === "kling") klingSuccess(data, true);
      const jobId = provider === "grok" ? data.request_id : data.data?.task_id;
      // Once a POST was sent, an incomplete acknowledgement cannot safely be
      // retried. Even a cancellation must preserve a returned job identifier.
      if (typeof jobId !== "string" || !ID_PATTERN.test(jobId)) throw uncertain();
      return { jobId, status: "pending", metadata: {
        provider, model: catalog.model, duration, resolution,
        aspectRatioMode: "source-image", sourceWidth: options.width, sourceHeight: options.height,
        requestedCompositionAspectRatio: aspectRatio ?? null
      } };
    },
    async poll(jobId, { signal } = {}) {
      validateJobId(jobId);
      const data = await request(`${BASES[provider]}/${encodeURIComponent(jobId)}`, { method: "GET", signal });
      if (provider === "kling") klingSuccess(data, false);
      if (provider === "kling" && data.data?.task_id !== undefined && data.data.task_id !== jobId) throw invalidResponse();
      const status = provider === "grok" ? data.status : data.data?.task_status;
      if ((provider === "grok" && status === "done") || (provider === "kling" && status === "succeed")) {
        if (provider === "grok" && data.video?.respect_moderation === false) return { status: "failed", error: "영상 서비스의 콘텐츠 검사로 결과가 제공되지 않았습니다." };
        const url = provider === "grok" ? data.video?.url : data.data?.task_result?.videos?.[0]?.url;
        return { status: "succeeded", videoUrl: videoURL(url, secrets) };
      }
      if (["failed", "expired"].includes(status)) return { status: "failed", error: status === "expired" ? "영상 작업이 만료되었습니다. 서비스의 작업 내역을 확인해 주세요." : "영상 서비스에서 생성에 실패했습니다. 서비스의 작업 내역을 확인해 주세요." };
      const pending = provider === "grok" ? ["pending"] : ["submitted", "processing"];
      if (pending.includes(status)) return { status: "pending" };
      throw invalidResponse();
    }
  });
}

module.exports = { PROVIDERS, createVideoProvider };
