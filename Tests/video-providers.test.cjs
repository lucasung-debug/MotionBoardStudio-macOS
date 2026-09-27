"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { PROVIDERS, createVideoProvider } = require("../Runtime/video-providers.cjs");

const CREDENTIALS = Object.freeze({
  grok: { apiKey: "fixture-xai-secret-not-a-real-key" },
  kling: { accessKey: "fixture-kling-access-key", secretKey: "fixture-kling-secret-not-a-real-key" }
});
const NOW = 1_790_467_200_000;
const JOB = "fixture-job-8";
const CDN = "https://fixture-cdn.example/video.mp4?signature=temporary-media-link";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width = 512, height = 512) {
  function chunk(type, bytes) {
    const body = Buffer.concat([Buffer.from(type), bytes]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const INPUT = Object.freeze({ imageBase64: png(), mediaType: "image/png", prompt: "A fixture ball spins in place.", duration: 5, resolution: "720p", aspectRatio: "16:9", externalTaskId: "fixture-local-shot-1" });
function json(data, status = 200) { return { status, json: async () => data }; }
function setup(provider, responses, extra = {}) {
  const calls = [];
  const adapter = createVideoProvider({ provider, credentials: CREDENTIALS[provider], now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, "Unexpected retry or extra API request");
      const response = responses.shift();
      if (typeof response === "function") return response(url, options);
      return response;
    }, ...extra });
  return { adapter, calls };
}
function rejected(code) {
  return error => {
    assert.equal(error.code, code);
    for (const value of Object.values(CREDENTIALS).flatMap(Object.values)) assert.ok(!String(error.stack).includes(value));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("Grok submits an image directly to xAI and preserves its aspect ratio", async () => {
  const { adapter, calls } = setup("grok", [json({ request_id: JOB })]);
  const result = await adapter.submit({ ...INPUT, duration: 12, resolution: "1080p" });
  assert.equal(result.jobId, JOB); assert.equal(result.status, "pending");
  assert.deepEqual(result.metadata, { provider: "grok", model: "grok-imagine-video-1.5", duration: 12,
    resolution: "1080p", aspectRatioMode: "source-image", sourceWidth: 512, sourceHeight: 512, requestedCompositionAspectRatio: "16:9" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/videos/generations");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${CREDENTIALS.grok.apiKey}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: "grok-imagine-video-1.5", prompt: INPUT.prompt,
    image: { url: `data:image/png;base64,${INPUT.imageBase64}` }, duration: 12, resolution: "1080p" });
});

test("Kling uses the official Singapore endpoint, raw image bytes and a valid fresh HS256 JWT", async () => {
  let clock = NOW;
  const { adapter, calls } = setup("kling", [json({ code: 0, data: { task_id: JOB } }), json({ code: 0, data: { task_id: JOB, task_status: "processing" } })], { now: () => clock });
  const result = await adapter.submit({ ...INPUT, resolution: "1080p", duration: 10 });
  assert.equal(result.jobId, JOB); assert.equal(result.metadata.aspectRatioMode, "source-image");
  assert.equal(calls[0].url, "https://api-singapore.klingai.com/v1/videos/image2video");
  assert.deepEqual(JSON.parse(calls[0].options.body), { model_name: "kling-v2-6", image: INPUT.imageBase64,
    prompt: INPUT.prompt, duration: "10", mode: "pro", sound: "off", external_task_id: INPUT.externalTaskId });
  const token = calls[0].options.headers.Authorization.slice(7), [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iss: CREDENTIALS.kling.accessKey, exp: NOW / 1000 + 1800, nbf: NOW / 1000 - 5 });
  assert.equal(signature, createHmac("sha256", CREDENTIALS.kling.secretKey).update(`${header}.${payload}`).digest("base64url"));
  clock += 60_000;
  assert.deepEqual(await adapter.poll(JOB), { status: "pending" });
  assert.notEqual(calls[1].options.headers.Authorization, calls[0].options.headers.Authorization);
  assert.equal(calls[1].url, `https://api-singapore.klingai.com/v1/videos/image2video/${JOB}`);
  assert.equal(calls[1].options.body, undefined);
});

test("each provider normalizes pending, successful and failed job states without exposing provider messages", async () => {
  const grok = setup("grok", [json({ status: "pending" }), json({ status: "done", video: { url: CDN, respect_moderation: true } }),
    json({ status: "failed", error: { message: CREDENTIALS.grok.apiKey } }), json({ status: "expired" }),
    json({ status: "done", video: { url: CDN, respect_moderation: false } })]);
  assert.deepEqual(await grok.adapter.poll(JOB), { status: "pending" });
  assert.deepEqual(await grok.adapter.poll(JOB), { status: "succeeded", videoUrl: CDN });
  for (let index = 0; index < 3; index++) {
    const result = await grok.adapter.poll(JOB);
    assert.equal(result.status, "failed"); assert.ok(!result.error.includes(CREDENTIALS.grok.apiKey));
  }
  const kling = setup("kling", [json({ code: 0, data: { task_status: "submitted" } }),
    json({ code: 0, data: { task_status: "succeed", task_result: { videos: [{ url: CDN }] } } }),
    json({ code: 0, data: { task_status: "failed", task_status_msg: CREDENTIALS.kling.secretKey } })]);
  assert.deepEqual(await kling.adapter.poll(JOB), { status: "pending" });
  assert.deepEqual(await kling.adapter.poll(JOB), { status: "succeeded", videoUrl: CDN });
  const result = await kling.adapter.poll(JOB);
  assert.equal(result.status, "failed"); assert.ok(!result.error.includes(CREDENTIALS.kling.secretKey));
});

test("invalid credentials and unsupported providers are rejected before network access", () => {
  for (const options of [{ provider: "higgsfield", credentials: {} }, { provider: "constructor", credentials: {} }]) {
    assert.throws(() => createVideoProvider(options), rejected("UNKNOWN_VIDEO_PROVIDER"));
  }
  for (const credentials of [{}, { apiKey: "" }, { apiKey: "fixture\nsecret" }]) {
    assert.throws(() => createVideoProvider({ provider: "grok", credentials }), rejected("VIDEO_CREDENTIALS_MISSING"));
  }
  assert.throws(() => createVideoProvider({ provider: "kling", credentials: { accessKey: "fixture" } }), rejected("VIDEO_CREDENTIALS_MISSING"));
  assert.throws(() => { PROVIDERS.kling.model = "arbitrary-model"; }, TypeError);
  assert.throws(() => { PROVIDERS.grok.resolutions.push("4k"); }, TypeError);
});

test("invalid options, unsafe IDs, image types, dimensions and base64 never submit a paid request", async () => {
  const grok = setup("grok", []), kling = setup("kling", []);
  for (const patch of [{ model: "unverified-model" }, { duration: 16 }, { duration: "5" }, { duration: NaN },
    { resolution: "4k" }, { aspectRatio: "100:1" }]) {
    await assert.rejects(grok.adapter.submit({ ...INPUT, ...patch }), rejected("INVALID_VIDEO_OPTIONS"));
  }
  for (const patch of [{ prompt: "" }, { prompt: "a".repeat(2501) }, { mediaType: "image/svg+xml" },
    { imageBase64: `data:image/png;base64,${INPUT.imageBase64}` }, { imageBase64: "YWJj$===" },
    { imageBase64: Buffer.from("not-an-image").toString("base64") }, { imageBase64: INPUT.imageBase64, mediaType: "image/jpeg" },
    { imageBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }, { externalTaskId: "../../other-job" }]) {
    await assert.rejects(grok.adapter.submit({ ...INPUT, ...patch }), rejected("INVALID_VIDEO_INPUT"));
  }
  for (const imageBase64 of [png(299, 512), png(512, 299), png(1000, 300)]) {
    await assert.rejects(kling.adapter.submit({ ...INPUT, imageBase64 }), rejected("INVALID_VIDEO_INPUT"));
  }
  await assert.rejects(kling.adapter.submit({ ...INPUT, duration: 6 }), rejected("INVALID_VIDEO_OPTIONS"));
  for (const id of ["../../job", "https://another.example", "foo?secret=bar", "", 123]) {
    await assert.rejects(grok.adapter.poll(id), rejected("INVALID_VIDEO_JOB"));
  }
  assert.equal(grok.calls.length + kling.calls.length, 0);
});

test("HTTP rejection is deterministic and provider error bodies are never read", async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    const { adapter, calls } = setup("grok", [{ status, json: () => { throw new Error("Error bodies must not be read"); } }]);
    await assert.rejects(adapter.submit(INPUT), error => {
      rejected([401, 403].includes(status) ? "VIDEO_AUTH_REJECTED" : "VIDEO_PROVIDER_REJECTED")(error);
      assert.equal(error.httpStatus, status); return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("uncertain submissions never retry or claim a safe failure", async () => {
  const cases = [() => { throw new Error(CREDENTIALS.grok.apiKey); }, { status: 503 }, { status: 408 }, { status: 307 },
    { status: 200, json: () => { throw new Error(CREDENTIALS.grok.apiKey); } }, json({ request_id: "../unsafe" }), json({}), json(null)];
  for (const response of cases) {
    const { adapter, calls } = setup("grok", [response]);
    await assert.rejects(adapter.submit(INPUT), rejected("SUBMISSION_UNCONFIRMED"));
    assert.equal(calls.length, 1);
  }
  for (const data of [{ code: 5000 }, { code: 0, data: {} }, { code: 99999 }]) {
    const { adapter, calls } = setup("kling", [json(data)]);
    await assert.rejects(adapter.submit(INPUT), rejected("SUBMISSION_UNCONFIRMED"));
    assert.equal(calls.length, 1);
  }
  const kling = setup("kling", [json({ code: 1004, message: CREDENTIALS.kling.secretKey })]);
  await assert.rejects(kling.adapter.submit(INPUT), rejected("VIDEO_AUTH_REJECTED"));
});

test("cancelling before submission sends nothing; cancelling after send preserves uncertainty", async () => {
  const before = new AbortController(); before.abort();
  const unused = setup("grok", []);
  await assert.rejects(unused.adapter.submit(INPUT, { signal: before.signal }), rejected("CANCELLED"));
  assert.equal(unused.calls.length, 0);
  const after = new AbortController();
  const started = setup("grok", [(_url, options) => {
    after.abort(); assert.equal(options.signal.aborted, true); throw new Error(CREDENTIALS.grok.apiKey);
  }]);
  await assert.rejects(started.adapter.submit(INPUT, { signal: after.signal }), rejected("SUBMISSION_UNCONFIRMED"));
  assert.equal(started.calls.length, 1);
  const acknowledged = new AbortController();
  const late = setup("grok", [() => { acknowledged.abort(); return json({ request_id: JOB }); }]);
  assert.equal((await late.adapter.submit(INPUT, { signal: acknowledged.signal })).jobId, JOB);
});

test("poll transport errors preserve the remote job without exposing secrets or re-submitting", async () => {
  const { adapter, calls } = setup("grok", [() => { throw new Error(CREDENTIALS.grok.apiKey); }, { status: 503 }, json({ status: "pending" })]);
  await assert.rejects(adapter.poll(JOB), rejected("VIDEO_PROVIDER_UNAVAILABLE"));
  await assert.rejects(adapter.poll(JOB), rejected("VIDEO_PROVIDER_UNAVAILABLE"));
  assert.deepEqual(await adapter.poll(JOB), { status: "pending" });
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.options.method === "GET"));
  const controller = new AbortController();
  const aborted = setup("grok", [() => { controller.abort(); throw new Error("fixture abort"); }]);
  await assert.rejects(aborted.adapter.poll(JOB, { signal: controller.signal }), rejected("CANCELLED"));
});

test("unknown or incomplete poll responses never masquerade as pending or downloadable results", async () => {
  const responses = [json({ status: "mystery" }), json({ status: "done" }), json({ status: "done", video: { url: "file:///private/data" } }),
    json({ status: "done", video: { url: "https://user:password@example.com/video.mp4" } }),
    json({ status: "done", video: { url: `https://cdn.example/video.mp4?reflected=${CREDENTIALS.grok.apiKey}` } }),
    { status: 200, json: () => { throw new Error(CREDENTIALS.grok.apiKey); } }];
  const { adapter } = setup("grok", responses);
  while (responses.length) await assert.rejects(adapter.poll(JOB), rejected("PROVIDER_RESPONSE_INVALID"));
  const mismatch = setup("kling", [json({ code: 0, data: { task_id: "wrong-job", task_status: "processing" } })]);
  await assert.rejects(mismatch.adapter.poll(JOB), rejected("PROVIDER_RESPONSE_INVALID"));
});
