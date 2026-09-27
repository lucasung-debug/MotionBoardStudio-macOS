'use strict';

// ChatGPT(Codex 백엔드) 오류를 사용자에게 보여줄 한국어 메시지로 정리한다.
// 401/403/429는 재시도해도 소용없는 "종료성" 오류로 태그해 상위 로직이 반복 호출을 멈추게 한다.

const quota = /usage_limit_reached|insufficient_quota|credit_balance_exhausted|(?:organization|project)_(?:spend|usage)_limit_exceeded/;
const limited = /rate_limit_(?:exceeded|error)|slow_down/;
const tagged = /\[LLM_(?:USAGE_LIMIT|RATE_LIMIT|AUTH_REQUIRED|ACCESS_DENIED)\]/;

function bodyOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

function fromHttp(status, raw, { service = 'ChatGPT', retryAfter, now = Date.now() } = {}) {
  const body = bodyOf(raw);
  const detail = body.error && typeof body.error === 'object' ? body.error : body;
  const code = String(detail.code || detail.type || '');
  let tag;
  let message;
  if (quota.test(code) || (status === 429 && quota.test(String(raw)))) {
    tag = 'LLM_USAGE_LIMIT';
    message = `${service} 연결 계정의 사용량 한도에 도달했습니다. 한도가 회복되기 전에는 다시 요청해도 진행할 수 없습니다.`;
  } else if (status === 429 || limited.test(code)) {
    tag = 'LLM_RATE_LIMIT';
    message = `${service} 요청이 일시적으로 제한되었습니다. 잠시 기다린 뒤 다시 요청해 주세요.`;
  } else if (status === 401) {
    tag = 'LLM_AUTH_REQUIRED';
    message = service === 'ChatGPT'
      ? '로그인 세션이 만료되었거나 유효하지 않습니다. 상단의 ChatGPT 로그인을 다시 실행해 주세요.'
      : service === 'Claude'
        ? 'Claude 로그인 세션이 만료되었거나 유효하지 않습니다. 상단의 Claude 로그인을 다시 실행해 주세요.'
        : 'LLM 인증에 실패했습니다. 연결 설정의 API 키와 계정을 확인해 주세요.';
  } else if (status === 403) {
    tag = 'LLM_ACCESS_DENIED';
    message = `${service} 연결 계정의 접근이 거부되었습니다. 계정·워크스페이스 권한과 연결 설정을 확인해 주세요.`;
  } else {
    return new Error(`${service} 요청 실패 (${status}): ${String(typeof raw === 'object' ? JSON.stringify(raw) : raw).slice(0, 300)}`);
  }
  let resetAt = Number(detail.resets_at) * 1000;
  if (!(resetAt > now)) {
    const seconds = Number(detail.resets_in_seconds ?? retryAfter);
    resetAt = seconds > 0 ? now + seconds * 1000 : Date.parse(String(retryAfter || ''));
  }
  if (resetAt > now && resetAt < now + 370 * 86400000) {
    message += ` 서버 안내 재개 시각: ${new Date(resetAt).toLocaleString('ko-KR')} (이 컴퓨터의 현지 시간).`;
  } else {
    resetAt = null;
  }
  const error = new Error(`[${tag}] ${message} 이 요청의 자동 재시도를 중단합니다.`);
  Object.assign(error, { code: tag, status, resetAt, terminal: true });
  return error;
}

function fromStream(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const code = String(detail.code || detail.type || '');
  return quota.test(code) || limited.test(code) ? fromHttp(429, { error: detail }) : null;
}

function isTerminal(error) {
  const message = String(error?.message || error || '');
  return tagged.test(message) || [401, 403, 429].includes(Number(error?.status))
    || /(?:요청 실패|HTTP)[^\n]{0,20}\b(?:401|403|429)\b/i.test(message) || quota.test(message);
}

function userMessage(error) {
  const message = String(error?.message || error || '');
  const tagAt = message.search(tagged);
  if (tagAt >= 0) return message.slice(tagAt);
  return message;
}

module.exports = { fromHttp, fromStream, isTerminal, userMessage };
