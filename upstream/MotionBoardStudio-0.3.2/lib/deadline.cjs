'use strict';

// 네트워크 타임아웃은 모델이 아니라 전송 계층의 책임이다.
// 추론 스트림이 살아 있는 동안에는 중간에 끊지 않는다.

const REQUEST_TIMEOUTS = Object.freeze({ firstByteMs: 300000, idleMs: 300000, totalMs: 1800000 });

function timeoutError(kind, ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  const messages = {
    first: `서버에서 ${minutes}분 동안 응답이 없어 중단했습니다. 연결 상태를 확인한 후 다시 요청해 주세요.`,
    idle: `응답 수신이 ${minutes}분 동안 멈춰 중단했습니다. 잠시 후 다시 요청해 주세요.`,
    total: `요청이 최대 대기시간(${minutes}분)을 초과했습니다. 잠시 후 다시 요청해 주세요.`
  };
  const error = new Error(messages[kind]);
  error.code = `LLM_TIMEOUT_${kind.toUpperCase()}`;
  return error;
}

function createRequestDeadline({
  firstByteMs = REQUEST_TIMEOUTS.firstByteMs,
  idleMs = REQUEST_TIMEOUTS.idleMs,
  totalMs = REQUEST_TIMEOUTS.totalMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  signal
} = {}) {
  const controller = new AbortController();
  let disposed = false;
  const abort = (kind, ms) => { if (!disposed && !controller.signal.aborted) controller.abort(timeoutError(kind, ms)); };
  let idleTimer = setTimer(() => abort('first', firstByteMs), firstByteMs);
  const totalTimer = setTimer(() => abort('total', totalMs), totalMs);
  idleTimer?.unref?.();
  totalTimer?.unref?.();
  const onExternalAbort = () => {
    if (!disposed && !controller.signal.aborted) {
      controller.abort(signal.reason || new Error('요청이 취소되었습니다.'));
    }
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    touch() {
      if (disposed || controller.signal.aborted) return;
      clearTimer(idleTimer);
      idleTimer = setTimer(() => abort('idle', idleMs), idleMs);
      idleTimer?.unref?.();
    },
    async wait(promise) {
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason || new Error('요청이 취소되었습니다.'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try { return await Promise.race([promise, aborted]); }
      finally { controller.signal.removeEventListener('abort', onAbort); }
    },
    dispose() {
      disposed = true;
      clearTimer(idleTimer);
      clearTimer(totalTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  };
}

module.exports = { REQUEST_TIMEOUTS, timeoutError, createRequestDeadline };
