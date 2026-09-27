"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeActivity } = require("../Runtime/claude-activity.cjs");
const { readClaudeStream, chat } = require("../upstream/MotionBoardStudio-0.3.2/lib/claude.cjs");

function fakeClock() {
  let present = 0, next = 1;
  const timers = new Map();
  const set = (callback, delay, repeating) => {
    const id = next++; timers.set(id, { callback, delay, repeating, at: present + delay }); return id;
  };
  return {
    now: () => present,
    setIntervalImpl: (callback, delay) => set(callback, delay, true),
    setTimeoutImpl: (callback, delay) => set(callback, delay, false),
    clearIntervalImpl: id => timers.delete(id),
    clearTimeoutImpl: id => timers.delete(id),
    get count() { return timers.size; },
    advance(milliseconds) {
      const target = present + milliseconds;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due; present = timer.at;
        if (timer.repeating) timer.at += timer.delay; else timers.delete(id);
        timer.callback();
      }
      present = target;
    }
  };
}

const bytes = value => new TextEncoder().encode(value);
const event = (value, eol = "\n") => bytes("event: " + value.type + eol + "data: " + JSON.stringify(value) + eol + eol);
const concatenate = chunks => Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
function responseFor(chunks, extra = {}) {
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "x-fixture": "preserved" }, ...extra });
}
function harness(options = {}) {
  const clock = fakeClock(), progress = [];
  const activity = createClaudeActivity({ ...clock, onProgress: value => progress.push(value), fetchImpl: async () => responseFor([]), ...options });
  return { activity, clock, progress };
}
const readAll = async response => Buffer.from(await response.arrayBuffer());
const deadline = { wait: async promise => promise, touch() {} };

test("SSE observer preserves every original byte across CRLF and split UTF-8 chunks", async () => {
  const source = concatenate([
    event({ type: "message_start", message: { model: "PRIVATE_MODEL_SENTINEL" } }, "\r\n"),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "\r\n"),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "한글 ⚾️ and split UTF-8" } }, "\r\n"),
    event({ type: "message_stop" }, "\r\n")
  ]);
  const chunks = Array.from({ length: Math.ceil(source.length / 3) }, (_, index) => source.subarray(index * 3, index * 3 + 3));
  const original = responseFor(chunks), init = { headers: { authorization: "SYNTHETIC_AUTH_SENTINEL" }, body: "PRIVATE_PROMPT_SENTINEL", method: "POST" };
  let count = 0;
  const { activity, clock, progress } = harness({ fetchImpl: async (url, options) => { count++; assert.equal(url, "https://fixture.invalid/messages"); assert.equal(options, init); return original; } });
  const response = await activity.fetchImpl("https://fixture.invalid/messages", init);
  assert.deepEqual(await readAll(response), source);
  assert.equal(response.status, original.status);
  assert.equal(response.headers.get("x-fixture"), "preserved");
  assert.equal(response.url, original.url);
  assert.equal(count, 1);
  assert.equal(progress.at(-1).textCharacters, "한글 ⚾️ and split UTF-8".length);
  assert.equal(clock.count, 0);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|SYNTHETIC_AUTH|한글|split UTF/);
  activity.dispose();
});

test("hidden and redacted thinking blocks provide activity evidence without exposing content", async t => {
  for (const type of ["thinking", "redacted_thinking"]) {
    await t.test(type, async () => {
      const source = [
        event({ type: "message_start", message: { id: "PRIVATE_ID_SENTINEL" } }),
        event({ type: "content_block_start", index: 0, content_block: { type, thinking: "", data: "PRIVATE_REDACTED_SENTINEL" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }),
        event({ type: "ping" }),
        event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "PRIVATE_SIGNATURE_SENTINEL" } }),
        event({ type: "message_stop" })
      ];
      const { activity, clock, progress } = harness({ fetchImpl: async () => responseFor(source) });
      assert.deepEqual(await readAll(await activity.fetchImpl("fixture")), concatenate(source));
      assert.ok(progress.some(value => value.state === "thinking"));
      assert.equal(progress.at(-1).heartbeatCount, 1);
      assert.equal(progress.at(-1).textCharacters, 0);
      assert.equal(clock.count, 0);
      assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|signature|prompt|model|\bid\b/);
    });
  }
});

test("pings never imply thinking and periodic metadata measures time since actual activity", async () => {
  let source;
  const raw = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const { activity, clock, progress } = harness({ fetchImpl: async () => raw });
  const reader = (await activity.fetchImpl("fixture")).body.getReader();
  source.enqueue(event({ type: "message_start", message: {} })); await reader.read();
  clock.advance(3000);
  source.enqueue(event({ type: "ping" })); await reader.read();
  clock.advance(2000);
  assert.equal(progress.at(-1).elapsedSeconds, 5);
  assert.equal(progress.at(-1).lastActivitySeconds, 2);
  assert.equal(progress.at(-1).heartbeatCount, 1);
  assert.equal(progress.at(-1).state, "waiting");
  assert.ok(!progress.some(value => value.state === "thinking"));
  const count = progress.length;
  clock.advance(5000); assert.equal(progress.length, count + 1);
  source.close(); await reader.read();
  assert.equal(clock.count, 0);
});

test("real upstream parsing plus observeDelta does not double count or regress progress", async () => {
  const answer = '{"title":"Fixture 한글"}';
  const source = [concatenate([
    event({ type: "message_start", message: { model: "fixture" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "PRIVATE_THINKING_SENTINEL" } }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: answer.slice(0, 10) } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: answer.slice(10) } }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    event({ type: "message_stop" })
  ])];
  const { activity, clock, progress } = harness({ fetchImpl: async () => responseFor(source) });
  const result = await readClaudeStream(await activity.fetchImpl("fixture"), deadline, delta => activity.observeDelta(delta));
  assert.equal(result.content, answer);
  assert.equal(progress.at(-1).textCharacters, answer.length);
  const writing = progress.findIndex(value => value.state === "writing");
  assert.ok(writing >= 0);
  assert.ok(!progress.slice(writing).some(value => value.state === "thinking"));
  assert.equal(clock.count, 0);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|Fixture|한글/);
});

test("observeDelta works as a fallback when no SSE transport was observed", () => {
  const { activity, clock, progress } = harness();
  activity.observeDelta({ kind: "reasoning", text: "PRIVATE_REASONING_SENTINEL" });
  assert.equal(progress.at(-1).state, "thinking");
  activity.observeDelta({ kind: "text", text: "한글" });
  activity.observeDelta({ kind: "text", text: "!" });
  clock.advance(5000);
  assert.equal(progress.at(-1).state, "writing");
  assert.equal(progress.at(-1).textCharacters, 3);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|한글/);
  activity.dispose();
  const count = progress.length;
  activity.observeDelta({ kind: "text", text: "ignored" }); clock.advance(10000);
  assert.equal(progress.length, count);
  assert.equal(clock.count, 0);
});

test("the total timeout expires even while a stream continues sending pings", async () => {
  let source, cancelled;
  const raw = new Response(new ReadableStream({ start(controller) { source = controller; }, cancel(reason) { cancelled = reason; } }), { headers: { "content-type": "text/event-stream" } });
  const { activity, clock, progress } = harness({ timeoutMs: 12000, fetchImpl: async () => raw });
  const reader = (await activity.fetchImpl("fixture", { signal: activity.signal })).body.getReader();
  for (let index = 0; index < 3; index++) {
    source.enqueue(event({ type: "ping" })); await reader.read(); clock.advance(3000);
  }
  const pending = reader.read(), rejected = assert.rejects(pending, error => error.code === "SPEC_RESPONSE_TIMEOUT");
  clock.advance(3000); await rejected;
  assert.equal(activity.signal.aborted, true);
  assert.equal(activity.timeoutError.code, "SPEC_RESPONSE_TIMEOUT");
  assert.equal(activity.signal.reason, activity.timeoutError);
  assert.equal(cancelled, activity.timeoutError);
  assert.equal(clock.count, 0);
  assert.ok(!progress.some(value => value.state === "thinking"));
  const count = progress.length; clock.advance(30000); activity.dispose();
  assert.equal(progress.length, count);
});

test("total timeout also rejects an unresolved fetch and cleans up a late response", async () => {
  let resolve, lateCancelled = false;
  const pendingFetch = new Promise(finish => { resolve = finish; });
  const { activity, clock, progress } = harness({ timeoutMs: 7000, fetchImpl: async () => pendingFetch });
  const pending = activity.fetchImpl("fixture", { signal: activity.signal });
  const rejected = assert.rejects(pending, error => error.code === "SPEC_RESPONSE_TIMEOUT");
  await Promise.resolve();
  clock.advance(7000); await rejected;
  resolve(new Response(new ReadableStream({ cancel() { lateCancelled = true; } })));
  await new Promise(setImmediate);
  assert.equal(lateCancelled, true);
  assert.equal(clock.count, 0);
  const count = progress.length; clock.advance(30000); assert.equal(progress.length, count);
});

test("external cancellation wins over timeout and closes a pending stream read", async () => {
  const external = new AbortController(), cancellation = new Error("Synthetic user cancel");
  let cancelled;
  const raw = new Response(new ReadableStream({ cancel(reason) { cancelled = reason; } }), { headers: { "content-type": "text/event-stream" } });
  const { activity, clock, progress } = harness({ signal: external.signal, timeoutMs: 10000, fetchImpl: async () => raw });
  const reader = (await activity.fetchImpl("fixture", { signal: activity.signal })).body.getReader();
  const pending = reader.read(), rejected = assert.rejects(pending, error => error === cancellation);
  clock.advance(9000); external.abort(cancellation); await rejected; clock.advance(10000);
  assert.equal(activity.signal.reason, cancellation);
  assert.equal(cancelled, cancellation);
  assert.equal(activity.timeoutError, null);
  assert.equal(clock.count, 0);
  const count = progress.length; activity.dispose(); clock.advance(10000); assert.equal(progress.length, count);
});

test("already cancelled requests never invoke fetch or emit progress", async () => {
  const external = new AbortController(); external.abort(new Error("Fixture cancellation"));
  let calls = 0;
  const { activity, clock, progress } = harness({ signal: external.signal, fetchImpl: async () => { calls++; return responseFor([]); } });
  await assert.rejects(activity.fetchImpl("fixture"), /Fixture cancellation/);
  assert.equal(calls, 0); assert.deepEqual(progress, []); assert.equal(clock.count, 0); assert.equal(activity.timeoutError, null);
});

test("user cancellation retains precedence if it follows the total timeout", () => {
  const external = new AbortController();
  const { activity, clock } = harness({ signal: external.signal, timeoutMs: 100 });
  clock.advance(100); assert.equal(activity.timeoutError.code, "SPEC_RESPONSE_TIMEOUT");
  external.abort(); assert.equal(activity.timeoutError, null); activity.dispose();
});

test("HTTP errors and non-SSE responses retain their original identity and body", async t => {
  for (const [status, type] of [[429, "text/event-stream"], [500, "application/json"], [200, "application/json"], [200, "text/plain"]]) {
    await t.test(status + " " + type, async () => {
      const raw = new Response("PRIVATE_HTTP_BODY_SENTINEL", { status, headers: { "content-type": type } });
      const { activity, clock, progress } = harness({ fetchImpl: async () => raw });
      const result = await activity.fetchImpl("fixture");
      assert.equal(result, raw); assert.equal(await result.text(), "PRIVATE_HTTP_BODY_SENTINEL");
      assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/);
      activity.dispose(); assert.equal(clock.count, 0);
    });
  }
});

test("malformed and oversized SSE events pass through unchanged and inspection resumes", async () => {
  const source = concatenate([
    bytes('data: {"malformed":\n\n'),
    bytes('data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"' + "x".repeat(180000) + '"}}\r\n\r\n'),
    bytes('data: {"type":"ping",\r\ndata: "extra":"PRIVATE_SENTINEL"}\r\n\r\n'),
    event({ type: "content_block_start", index: 1, content_block: { type: "thinking" } }),
    event({ type: "message_stop" })
  ]);
  const { activity, clock, progress } = harness({ fetchImpl: async () => responseFor([source]) });
  assert.deepEqual(await readAll(await activity.fetchImpl("fixture")), source);
  assert.ok(progress.some(value => value.state === "thinking"));
  assert.equal(progress.at(-1).heartbeatCount, 1);
  assert.equal(clock.count, 0);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|xxxxxxxx/);
});

test("upstream still receives malformed SSE errors instead of an observer exception", async () => {
  const { activity, clock } = harness({ fetchImpl: async () => responseFor([bytes('data: {"broken":\n\n')]) });
  await assert.rejects(readClaudeStream(await activity.fetchImpl("fixture"), deadline), /Claude 응답 스트림을 해석할 수 없습니다/);
  assert.equal(clock.count, 0); activity.dispose();
});

test("provider stream errors and consumer cancellation clear both timers", async t => {
  await t.test("read failure", async () => {
    const failure = new Error("PRIVATE_STREAM_FAILURE_SENTINEL");
    const raw = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), { headers: { "content-type": "text/event-stream" } });
    const { activity, clock, progress } = harness({ fetchImpl: async () => raw });
    await assert.rejects(readAll(await activity.fetchImpl("fixture")), error => error === failure);
    assert.equal(clock.count, 0); assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/);
  });
  await t.test("SSE error event", async () => {
    const source = event({ type: "error", error: { message: "PRIVATE_PROVIDER_ERROR_SENTINEL", type: "overloaded_error" } });
    const { activity, clock, progress } = harness({ fetchImpl: async () => responseFor([source]) });
    assert.deepEqual(await readAll(await activity.fetchImpl("fixture")), Buffer.from(source));
    assert.equal(clock.count, 0); assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/);
  });
  await t.test("consumer cancel", async () => {
    let cancelled = false;
    const raw = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const { activity, clock, progress } = harness({ fetchImpl: async () => raw });
    const response = await activity.fetchImpl("fixture");
    await response.body.cancel("fixture consumer done");
    assert.equal(cancelled, true); assert.equal(clock.count, 0);
    const count = progress.length; clock.advance(10000); assert.equal(progress.length, count);
  });
});

test("fetch failures and throwing progress callbacks do not leak or alter errors", async () => {
  const failure = new Error("PRIVATE_FETCH_FAILURE_SENTINEL"), clock = fakeClock();
  const activity = createClaudeActivity({ ...clock, fetchImpl: async () => { throw failure; }, onProgress: () => { throw new Error("Fixture UI failure"); } });
  await assert.rejects(activity.fetchImpl("fixture"), error => error === failure);
  assert.equal(clock.count, 0); activity.dispose(); activity.dispose();
});

test("all progress payloads use only the fixed numeric/state contract", async () => {
  const source = [event({ type: "message_start", message: { id: "SECRET" } }), event({ type: "ping" }), event({ type: "message_stop" })];
  const { activity, progress } = harness({ fetchImpl: async () => responseFor(source) });
  await readAll(await activity.fetchImpl("fixture"));
  for (const item of progress) {
    assert.deepEqual(Object.keys(item).sort(), ["elapsedSeconds", "heartbeatCount", "lastActivitySeconds", "state", "textCharacters"]);
    assert.ok(["connecting", "accepted", "thinking", "writing", "waiting"].includes(item.state));
    for (const key of ["elapsedSeconds", "textCharacters", "heartbeatCount"]) assert.ok(Number.isInteger(item[key]) && item[key] >= 0);
    assert.ok(item.lastActivitySeconds === null || Number.isInteger(item.lastActivitySeconds) && item.lastActivitySeconds >= 0);
  }
});

test("connection waiting does not imply any observed server activity", async () => {
  const { activity, clock, progress } = harness({ fetchImpl: async () => new Promise(() => {}) });
  assert.equal(progress[0].lastActivitySeconds, null);
  const pending = activity.fetchImpl("fixture"), rejected = assert.rejects(pending, error => error.code === "SPEC_RESPONSE_TIMEOUT");
  clock.advance(5000);
  assert.equal(progress.at(-1).elapsedSeconds, 5);
  assert.equal(progress.at(-1).lastActivitySeconds, null);
  clock.advance(295000); await rejected;
  assert.ok(progress.every(item => item.lastActivitySeconds === null));
});

test("the original deadline still expires while an SSE rate-limit retry is paused", async () => {
  let calls = 0;
  const source = event({ type: "error", error: { type: "rate_limit_error", message: "PRIVATE_RATE_LIMIT_SENTINEL" } });
  const { activity, clock, progress } = harness({ timeoutMs: 12000, fetchImpl: async () => { calls++; return responseFor([source]); } });
  await assert.rejects(readClaudeStream(await activity.fetchImpl("fixture"), deadline), error => error.code === "LLM_RATE_LIMIT");
  assert.equal(clock.count, 1);
  const count = progress.length; clock.advance(12000);
  assert.equal(activity.timeoutError.code, "SPEC_RESPONSE_TIMEOUT");
  await assert.rejects(activity.fetchImpl("fixture"), error => error.code === "SPEC_RESPONSE_TIMEOUT");
  assert.equal(calls, 1);
  assert.equal(clock.count, 0); assert.equal(progress.length, count);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/);
});

test("actual upstream chat retries an SSE rate limit using the same remaining deadline", async () => {
  let calls = 0;
  const answer = '{"title":"Synthetic response"}';
  const { activity, clock, progress } = harness({ timeoutMs: 12000, fetchImpl: async () => {
    calls++;
    if (calls === 1) {
      clock.advance(4000);
      return responseFor([event({ type: "error", error: { type: "rate_limit_error", message: "PRIVATE_RATE_SENTINEL" } })]);
    }
    assert.equal(clock.count, 2);
    clock.advance(3000);
    return responseFor([event({ type: "message_start", message: { model: "fixture" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }),
      event({ type: "message_delta", delta: { stop_reason: "end_turn" } }), event({ type: "message_stop" })]);
  } });
  const result = await chat({ token: "SYNTHETIC_FIXTURE_TOKEN", instructions: "Synthetic fixture only", userText: "Fixture", fetchImpl: activity.fetchImpl,
    signal: activity.signal, onDelta: delta => activity.observeDelta(delta), rateLimitWaits: [0, 0] });
  assert.equal(result.content, answer); assert.equal(calls, 2); assert.equal(clock.count, 0);
  assert.equal(progress.at(-1).elapsedSeconds, 7);
  assert.equal(progress.at(-1).textCharacters, answer.length);
  assert.equal(activity.timeoutError, null);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|SYNTHETIC_FIXTURE_TOKEN|Synthetic response/);
});

test("a completed SSE request cannot be silently reused after cleanup", async () => {
  let calls = 0;
  const { activity, clock } = harness({ fetchImpl: async () => { calls++; return responseFor([event({ type: "message_stop" })]); } });
  await readAll(await activity.fetchImpl("fixture"));
  await assert.rejects(activity.fetchImpl("fixture"), error => error.code === "SPEC_RESPONSE_CLOSED");
  assert.equal(calls, 1); assert.equal(clock.count, 0);
});

test("HTTP 429 retries retain the original total deadline and monitoring", async () => {
  let calls = 0;
  const denied = new Response("Synthetic rate limit", { status: 429, headers: { "retry-after": "1" } });
  const { activity, clock, progress } = harness({ timeoutMs: 10000, fetchImpl: async () => {
    calls++; return calls === 1 ? denied : responseFor([event({ type: "message_start", message: {} }), event({ type: "message_stop" })]);
  } });
  assert.equal(await activity.fetchImpl("fixture"), denied);
  assert.equal(clock.count, 2);
  activity.observeDelta({ kind: "status", text: "PRIVATE_RETRY_SENTINEL" });
  clock.advance(1000);
  await readAll(await activity.fetchImpl("fixture"));
  assert.equal(calls, 2); assert.equal(clock.count, 0);
  assert.ok(progress.some(item => item.state === "accepted" && item.elapsedSeconds === 1));
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/);
});
