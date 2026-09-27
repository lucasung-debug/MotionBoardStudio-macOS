"use strict";

// This observer reports transport/activity metadata only. It does not request,
// retain, or publish the model's reasoning, signatures, or generated text.
const REPORT_INTERVAL_MS = 5000;
const MAX_INSPECTION_CHARACTERS = 65536;
const DECODE_SLICE_BYTES = 4096;

function createClaudeActivity({ fetchImpl = fetch, signal, onProgress = () => {}, timeoutMs = 300000,
  now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (typeof fetchImpl !== "function" || typeof onProgress !== "function" || typeof now !== "function") throw new TypeError("Invalid Claude activity callbacks.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("A positive Claude activity timeout is required.");
  const controller = new AbortController(), startedAt = now();
  let active = true, retryPending = false, state = "connecting", lastActivityAt = null, lastStateAt = startedAt;
  let textCharacters = 0, heartbeatCount = 0, observedTransport = false, currentBlock = null;
  let interval = null, timeout = null, timeoutFailure = null;
  const inspectionCleanups = new Set();
  const secondsSince = (time, present) => Math.max(0, Math.floor((present - time) / 1000));
  function emit() {
    if (!active) return;
    const present = now();
    try { onProgress({ state, elapsedSeconds: secondsSince(startedAt, present), lastActivitySeconds: lastActivityAt === null ? null : secondsSince(lastActivityAt, present), textCharacters, heartbeatCount }); }
    catch { /* A UI callback must never alter the provider stream. */ }
  }
  function changeState(next) {
    if (!active || state === next) return;
    state = next; lastStateAt = now(); emit();
  }
  function finish(finalSnapshot = false, allowRetry = false) {
    if (!active && !retryPending) return;
    if (finalSnapshot) emit();
    active = false;
    retryPending = allowRetry && !controller.signal.aborted && !signal?.aborted;
    if (interval !== null) clearIntervalImpl(interval);
    interval = null;
    if (!retryPending) {
      if (timeout !== null) clearTimeoutImpl(timeout);
      timeout = null;
      signal?.removeEventListener("abort", externalAbort);
    }
    for (const cleanup of inspectionCleanups) cleanup();
    inspectionCleanups.clear();
  }
  function externalAbort() {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    finish();
  }
  function reportInterval() {
    if (!active) return;
    // A heartbeat never supplies evidence that the model is thinking.
    if (state === "accepted" && now() - lastStateAt >= REPORT_INTERVAL_MS) state = "waiting";
    emit();
  }
  if (signal?.aborted) externalAbort();
  else {
    signal?.addEventListener("abort", externalAbort, { once: true });
    interval = setIntervalImpl(reportInterval, REPORT_INTERVAL_MS);
    timeout = setTimeoutImpl(() => {
      if (!active && !retryPending) return;
      if (signal?.aborted) { externalAbort(); return; }
      timeoutFailure = Object.assign(new Error("Claude 제작 명세의 최대 응답 대기시간을 초과했습니다. 불완전한 결과는 저장하지 않았습니다. 다시 시도해 주세요."), { code: "SPEC_RESPONSE_TIMEOUT" });
      controller.abort(timeoutFailure);
      finish();
    }, timeoutMs);
    interval?.unref?.(); timeout?.unref?.();
    emit();
  }

  function handleEvent(event) {
    if (!active || !event || typeof event !== "object") return;
    switch (event.type) {
      case "message_start": changeState("accepted"); break;
      case "content_block_start":
        currentBlock = Number.isInteger(event.index) ? event.index : null;
        if (["thinking", "redacted_thinking"].includes(event.content_block?.type)) changeState("thinking");
        else changeState("waiting");
        break;
      case "content_block_delta":
        if (event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text.length) {
          textCharacters += event.delta.text.length; changeState("writing");
        }
        break;
      case "content_block_stop":
        if (currentBlock === event.index) { currentBlock = null; changeState("waiting"); }
        break;
      case "ping": heartbeatCount++; break;
      case "message_stop": finish(true); break;
      case "error":
        // Keep the original deadline during the upstream client's bounded
        // rate-limit backoff, but emit no progress until it starts another fetch.
        finish(false, /rate_limit_(?:exceeded|error)|slow_down/.test(String(event.error?.code || event.error?.type || "")));
        break;
    }
  }

  function createInspector() {
    const decoder = new TextDecoder();
    let line = "", data = null, discardedLine = false, discardedEvent = false;
    const reset = () => { line = ""; data = null; discardedLine = false; discardedEvent = false; };
    inspectionCleanups.add(reset);
    function dispatch() {
      const value = data, discard = discardedEvent;
      data = null; discardedEvent = false;
      if (discard || value === null || !active) return;
      try { handleEvent(JSON.parse(value)); }
      catch { /* Malformed event data belongs to the original Claude parser. */ }
    }
    function consumeLine(value) {
      if (value.endsWith("\r")) value = value.slice(0, -1);
      if (!value) { dispatch(); return; }
      if (discardedEvent || !value.startsWith("data:")) return;
      const part = value.slice(5).replace(/^ /, "");
      if ((data?.length || 0) + part.length + 1 > MAX_INSPECTION_CHARACTERS) {
        data = null; discardedEvent = true; return;
      }
      data = data === null ? part : data + "\n" + part;
    }
    function consume(text) {
      for (const character of text) {
        if (!active) return;
        if (character === "\n") {
          if (!discardedLine) consumeLine(line);
          line = ""; discardedLine = false;
        } else if (!discardedLine) {
          if (line.length + character.length > MAX_INSPECTION_CHARACTERS) {
            line = ""; data = null; discardedLine = true; discardedEvent = true;
          } else line += character;
        }
      }
    }
    return {
      inspect(chunk) {
        if (!active) return;
        if (chunk?.byteLength) lastActivityAt = now();
        try {
          const bytes = ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : null;
          if (!bytes) return;
          for (let offset = 0; active && offset < bytes.length; offset += DECODE_SLICE_BYTES) consume(decoder.decode(bytes.subarray(offset, offset + DECODE_SLICE_BYTES), { stream: true }));
        } catch { reset(); }
      },
      end() {
        if (active) {
          try { consume(decoder.decode()); if (line && !discardedLine) consumeLine(line); dispatch(); } catch { /* Pass through EOF. */ }
          finish(true);
        }
        reset(); inspectionCleanups.delete(reset);
      },
      clear() { reset(); inspectionCleanups.delete(reset); }
    };
  }

  function observeResponse(response) {
    if (response?.headers) lastActivityAt = now();
    if (!response?.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers?.get("content-type")?.trim() || "") || !response.body?.getReader) return response;
    observedTransport = true;
    changeState("waiting");
    const reader = response.body.getReader(), inspector = createInspector();
    let closed = false, released = false, output;
    function release() {
      if (released) return;
      released = true; controller.signal.removeEventListener("abort", abortStream); inspector.clear();
      try { reader.releaseLock(); } catch { /* A pending read will finish its cleanup. */ }
    }
    function abortStream() {
      if (closed) return;
      closed = true; finish();
      const reason = controller.signal.reason || new DOMException("Aborted", "AbortError");
      output.error(reason);
      Promise.resolve(reader.cancel(reason)).catch(() => {}).finally(release);
    }
    const body = new ReadableStream({
      start(streamController) {
        output = streamController;
        controller.signal.addEventListener("abort", abortStream, { once: true });
        if (controller.signal.aborted) abortStream();
      },
      async pull(streamController) {
        try {
          const result = await reader.read();
          if (closed) { release(); return; }
          if (result.done) { closed = true; inspector.end(); streamController.close(); release(); return; }
          inspector.inspect(result.value);
          streamController.enqueue(result.value);
        } catch (error) {
          if (!closed) { closed = true; finish(); streamController.error(error); }
          release();
        }
      },
      async cancel(reason) {
        if (closed) return;
        closed = true;
        // readClaudeStream cancels its reader in finally before chat retries.
        // That internal cleanup must not erase the remaining request deadline.
        if (!retryPending) finish();
        try { await reader.cancel(reason); } finally { release(); }
      }
    });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const key of ["url", "redirected", "type"]) Object.defineProperty(wrapped, key, { value: response[key] });
    return wrapped;
  }

  async function monitoredFetch(...args) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!active && retryPending) {
      active = true; retryPending = false; observedTransport = false; currentBlock = null;
      interval = setIntervalImpl(reportInterval, REPORT_INTERVAL_MS); interval?.unref?.();
    }
    // A completed/disposed request cannot be reused without a fresh observer.
    if (!active) throw Object.assign(new Error("Claude 응답 연결이 종료되어 추가 요청을 중단했습니다. 다시 시도해 주세요."), { code: "SPEC_RESPONSE_CLOSED" });
    changeState("connecting");
    let abortWait;
    try {
      // Forward arguments untouched: the caller supplies the linked signal to
      // Claude's request deadline; auth headers and request bodies are opaque.
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return fetchImpl(...args);
      });
      pending.then(response => {
        if (controller.signal.aborted) Promise.resolve(response?.body?.cancel(controller.signal.reason)).catch(() => {});
      }, () => {});
      const aborted = new Promise((_, reject) => {
        abortWait = () => reject(controller.signal.reason || new DOMException("Aborted", "AbortError"));
        controller.signal.addEventListener("abort", abortWait, { once: true });
        if (controller.signal.aborted) abortWait();
      });
      return observeResponse(await Promise.race([pending, aborted]));
    } catch (error) { finish(); throw error; }
    finally { if (abortWait) controller.signal.removeEventListener("abort", abortWait); }
  }

  return {
    fetchImpl: monitoredFetch,
    signal: controller.signal,
    observeDelta(delta) {
      // The real SSE observer already sees the same deltas, often before the
      // upstream parser processes its chunk. Do not count twice or regress state.
      if (!active || observedTransport) return;
      if (delta?.kind === "text" && typeof delta.text === "string" && delta.text.length) {
        lastActivityAt = now(); textCharacters += delta.text.length; changeState("writing");
      } else if (delta?.kind === "reasoning") { lastActivityAt = now(); changeState("thinking"); }
      else if (delta?.kind === "status") changeState("waiting");
    },
    get timeoutError() { return signal?.aborted ? null : timeoutFailure; },
    dispose() { finish(); }
  };
}

module.exports = { createClaudeActivity };
