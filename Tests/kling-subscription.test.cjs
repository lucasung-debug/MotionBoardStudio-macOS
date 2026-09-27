"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CATALOG, createKlingSubscriptionProvider, inspectKlingSubscription } = require("../Runtime/kling-subscription.cjs");

const EXECUTABLE = "/fixture/bin/kling";
const JOB = "fixture-kling-mcp-job-1";
const CDN = "https://fixture.example/regular-watermarked-video.mp4?signature=media-only";
const SECRET = "fixture-sensitive-cli-output-must-not-escape";
const INPUT = Object.freeze({ imagePath: "/fixture/scenes/a ball.png", prompt: "A blue ball spins in place.",
  duration: 5, resolution: "720p", aspectRatio: "1:1", externalTaskId: "fixture-local-shot-1" });

function model() {
  return { model: "kling-video-v2_6", arguments: [
    { name: "prompt", required: false },
    { name: "duration", required: false, default: "5", allowedValues: ["5", "10"] },
    { name: "imageCount", required: false, default: "1", allowedValues: ["1", "2", "3", "4"] },
    { name: "resolution", required: false, default: "1080p", allowedValues: ["720p", "1080p"] },
    { name: "enable_audio", required: false, default: "true", allowedValues: ["true", "false"] }
  ], inputs: [{ name: "first_image", required: true }, { name: "tail_image", required: false }] };
}
function who(overrides = {}) { return { authMode: "oauth", user: { userId: SECRET }, availableModels: { image_to_video: { models: [model()] } }, ...overrides }; }
function envelope(body, options = {}) {
  return { stdout: JSON.stringify({ ok: options.ok ?? true, status: options.status ?? 200, body }),
    stderr: SECRET, exitCode: options.exitCode ?? 0 };
}
function setup(responses) {
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args, options });
    assert.ok(responses.length, "Unexpected extra command or automatic retry");
    const result = responses.shift();
    if (typeof result === "function") return result({ executable, args, options });
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls, adapter: createKlingSubscriptionProvider({ run, executable: EXECUTABLE }) };
}
function rejected(code) {
  return error => {
    assert.equal(error.code, code);
    assert.ok(!String(error.stack).includes(SECRET));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("Kling submission uses OAuth CLI and declared MCP names with one silent clip", async () => {
  const { adapter, calls } = setup([envelope(who()), envelope({ generationId: JOB, status: "submitted", creditsConsumed: 15, token: SECRET })]);
  const result = await adapter.submit(INPUT);
  assert.equal(result.jobId, JOB);
  assert.equal(result.status, "pending");
  assert.equal(result.metadata.transport, "kling-cli");
  assert.equal(result.metadata.billing, "member-credits");
  assert.equal(result.metadata.creditsConsumed, 15);
  assert.equal(result.metadata.audio, false);
  assert.equal(CATALOG.supportsExternalTaskId, false);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(calls.map(call => call.args), [["who_am_i"], [
    "image_to_video", "--model", "kling-video-v2_6", "--image", INPUT.imagePath,
    "--duration", "5", "--resolution", "720p", "--enable_audio", "false", "--imageCount", "1", "--poll", "0", INPUT.prompt
  ]]);
  assert.ok(calls.every(call => call.executable === EXECUTABLE));
  assert.equal(calls[1].options.timeoutMs, 120_000);
});

test("a prompt containing shell syntax stays a single argv value", async () => {
  const { adapter, calls } = setup([envelope(who()), envelope({ generationId: JOB })]);
  const prompt = "Ball says $(not-a-command) and `literal` — then --help appears on screen.";
  await adapter.submit({ ...INPUT, prompt, duration: 10, resolution: "1080p" });
  assert.equal(calls[1].args.at(-1), prompt);
  assert.ok(!calls[1].args.includes("--help"));
});

test("connection inspection returns only account credits and supported capabilities", async () => {
  const { run, calls } = setup([envelope(who()), envelope({ membershipType: "SVIP", membershipTypeDescription: SECRET,
    availableRemainCredits: 1453, userId: SECRET, accessToken: SECRET })]);
  const result = await inspectKlingSubscription({ run, executable: EXECUTABLE });
  assert.deepEqual(result, { configured: true, authMode: "oauth", model: "kling-video-v2_6",
    durations: [5, 10], resolutions: ["720p", "1080p"], membership: "SVIP", credits: 1453 });
  assert.deepEqual(calls.map(call => call.args), [["who_am_i"], ["account"]]);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("inspection accepts the direct-array model shape documented by Kling", async () => {
  const spec = model();
  spec.arguments.find(arg => arg.name === "resolution").allowedValues = ["1080p"];
  const { run } = setup([envelope(who({ availableModels: { image_to_video: [spec] } })),
    envelope({ membershipType: "NORMAL", availableRemainCredits: 0 })]);
  const result = await inspectKlingSubscription({ run, executable: EXECUTABLE });
  assert.equal(result.configured, true);
  assert.equal(result.credits, 0);
  assert.deepEqual(result.resolutions, ["1080p"]);
});

test("non-OAuth authentication never proceeds to upload or account lookup", async () => {
  const { adapter, calls } = setup([envelope(who({ authMode: "api_key" }))]);
  await assert.rejects(adapter.submit(INPUT), rejected("VIDEO_AUTH_REJECTED"));
  assert.equal(calls.length, 1);
  const inspection = setup([envelope(who({ authMode: "api_key" }))]);
  const result = await inspectKlingSubscription({ run: inspection.run, executable: EXECUTABLE });
  assert.equal(result.configured, false);
  assert.equal(result.errorCode, "VIDEO_AUTH_REJECTED");
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("changed live model requirements fail before the charged CLI command", async () => {
  const changes = [
    spec => { spec.model = "kling-v2-6"; },
    spec => { spec.arguments.find(arg => arg.name === "resolution").allowedValues = ["1080p"]; },
    spec => { spec.arguments.find(arg => arg.name === "enable_audio").allowedValues = ["true"]; },
    spec => { spec.arguments.find(arg => arg.name === "imageCount").allowedValues = ["2"]; },
    spec => { spec.inputs[1].required = true; },
    spec => { spec.inputs[0].name = "changed_input"; },
    spec => { spec.arguments.push({ name: "new_required_parameter", required: true }); }
  ];
  for (const change of changes) {
    const spec = model(); change(spec);
    const { adapter, calls } = setup([envelope(who({ availableModels: { image_to_video: { models: [spec] } } }))]);
    await assert.rejects(adapter.submit(INPUT), rejected("VIDEO_CAPABILITIES_UNAVAILABLE"));
    assert.equal(calls.length, 1);
  }
});

test("invalid input and pre-cancellation never start a CLI process", async () => {
  const { adapter, calls } = setup([]);
  for (const input of [ { ...INPUT, imagePath: "https://private.example/image.png" }, { ...INPUT, imagePath: "relative.png" },
    { ...INPUT, prompt: "--image=/unrelated/file.png" }, { ...INPUT, prompt: "" }, { ...INPUT, duration: 6 },
    { ...INPUT, resolution: "4k" }, { ...INPUT, model: "kling-v2-6" } ]) {
    await assert.rejects(adapter.submit(input), error => ["INVALID_VIDEO_INPUT", "INVALID_VIDEO_OPTIONS"].includes(error.code));
  }
  await assert.rejects(adapter.submit(INPUT, { signal: AbortSignal.abort() }), rejected("CANCELLED"));
  assert.equal(calls.length, 0);
});

test("failed and cancelled dispatches stay uncertain without an automatic retry", async () => {
  for (const response of [
    Object.assign(new Error(SECRET), { started: true }),
    Object.assign(new Error(SECRET), { code: "CANCELLED" }),
    { stdout: "partial " + SECRET, stderr: SECRET, exitCode: 1 },
    envelope({ message: SECRET }, { ok: false, status: 503 }),
    envelope({ message: SECRET }, { ok: false, status: 408 }),
    envelope({ generationId: "", token: SECRET })
  ]) {
    const { adapter, calls } = setup([envelope(who()), response]);
    await assert.rejects(adapter.submit(INPUT), rejected("SUBMISSION_UNCONFIRMED"));
    assert.equal(calls.length, 2);
  }
});

test("a runner-proven preflight failure is not reported as a charged submission", async () => {
  const { adapter } = setup([envelope(who()), Object.assign(new Error(SECRET), { started: false, code: "CLI_NOT_FOUND" })]);
  await assert.rejects(adapter.submit(INPUT), rejected("CLI_NOT_FOUND"));
});

test("explicit authentication or quota rejection is sanitized", async () => {
  for (const status of [401, 403, 429]) {
    const { adapter, calls } = setup([envelope(who()), envelope({ message: SECRET }, { ok: false, status, exitCode: 1 })]);
    await assert.rejects(adapter.submit(INPUT), rejected(status === 429 ? "VIDEO_PROVIDER_REJECTED" : "VIDEO_AUTH_REJECTED"));
    assert.equal(calls.length, 2);
  }
});

test("an acknowledged job survives cancellation racing with CLI completion", async () => {
  const controller = new AbortController();
  const { adapter } = setup([envelope(who()), () => {
    controller.abort();
    return envelope({ generationId: JOB, status: "submitted" }, { exitCode: 1 });
  }]);
  const result = await adapter.submit(INPUT, { signal: controller.signal });
  assert.equal(result.jobId, JOB);
});

test("polling handles case-insensitive pending and failed states once per call", async () => {
  for (const status of ["QUEUING", "RUNNING", "submitted", "Processing", "FAILED", "Cancelled", "expired"]) {
    const { adapter, calls } = setup([envelope({ generationId: JOB, status, message: SECRET })]);
    const result = await adapter.poll(JOB);
    assert.equal(result.status, ["FAILED", "Cancelled", "expired"].includes(status) ? "failed" : "pending");
    assert.deepEqual(calls[0].args, ["query_tasks", "--poll", "0", JOB]);
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("completed and partial tasks use a successful video's regular URL", async () => {
  for (const status of ["COMPLETED", "partial_COMPLETED", "succeed"]) {
    const { adapter } = setup([envelope({ generationId: JOB, status, works: [
      { status: "COMPLETED", contentType: "image", url: "https://fixture.example/cover.png" },
      { status: "FAILED", contentType: "video", url: "https://fixture.example/failed.mp4" },
      { status: "completed", contentType: "video", url: CDN, urlWithoutWatermark: "https://fixture.example/clean.mp4" }
    ] })]);
    const result = await adapter.poll(JOB);
    assert.equal(result.status, "succeeded");
    assert.equal(result.videoUrl, CDN);
    if (status.toLowerCase() === "partial_completed") assert.equal(result.metadata.partialCompletion, true);
  }
});

test("polling rejects mismatched tasks, incomplete outputs and unsafe URLs", async () => {
  const completed = { generationId: JOB, status: "COMPLETED" };
  for (const body of [
    { generationId: "another-job", status: "RUNNING" },
    { generationId: JOB, generation_id: "another-job", status: "RUNNING" },
    { ...completed, works: [] },
    { ...completed, works: [{ status: "FAILED", contentType: "video", url: CDN }] },
    { ...completed, works: [{ status: "COMPLETED", contentType: "video", urlWithoutWatermark: CDN }] },
    { ...completed, works: [{ status: "COMPLETED", contentType: "video", url: "https://user:secret@fixture.example/video.mp4" }] },
    { ...completed, works: [{ status: "COMPLETED", contentType: "video", url: "file:///tmp/video.mp4" }] },
    { generationId: JOB, status: "new-unknown-state", error: SECRET }
  ]) {
    const { adapter } = setup([envelope(body)]);
    await assert.rejects(adapter.poll(JOB), rejected("PROVIDER_RESPONSE_INVALID"));
  }
});

test("polling supports documented legacy ID spelling without exposing raw errors", async () => {
  const { adapter } = setup([envelope({ generation_id: JOB, status: "RUNNING" }), new Error(SECRET)]);
  assert.deepEqual(await adapter.poll(JOB), { status: "pending" });
  await assert.rejects(adapter.poll(JOB), rejected("VIDEO_PROVIDER_UNAVAILABLE"));
});

test("connection failures remain bounded diagnostics and never expose CLI output", async () => {
  for (const response of [Object.assign(new Error(SECRET), { code: "CLI_NOT_FOUND", started: false }),
    { stdout: SECRET, stderr: SECRET, exitCode: 1 }, envelope({ authMode: "oauth", availableModels: {} })]) {
    const { run } = setup([response]);
    const result = await inspectKlingSubscription({ run, executable: EXECUTABLE });
    assert.equal(result.configured, false);
    assert.equal(result.membership, null);
    assert.equal(result.credits, null);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});
