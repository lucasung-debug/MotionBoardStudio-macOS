'use strict';

// Claude(Anthropic) Messages API 클라이언트 — Claude 구독 OAuth 토큰용.
// - 모델: claude-opus-5-5 (기본) · 추론: effort=max (어댑티브 thinking, 최상위)
// - 시스템 프롬프트는 Claude Code 접두사 "그대로"여야 한다. 뒤에 내용을 덧붙이면
//   구독 라우팅에서 제외되어 429(rate_limit_error, "Error")로 즉시 스로틀된다.
//   작업 지시문(가이드)은 user 메시지에 넣는다.
// - electron 비의존(토큰은 호출자가 넘겨준다). 이미지 생성은 지원하지 않는다(이미지 입력은 지원).

const LLMErrors = require('./llm-errors.cjs');
const { createRequestDeadline } = require('./deadline.cjs');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14';
// 서버가 user-agent 버전으로 모델 지원을 게이트한다(opus-5-5는 2.1.280+ 필요).
const CLAUDE_CLI_VERSION = '2.1.280';
const MIN_CLI_VERSION_FOR_SUPPORT = '2.1.280';
const SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'max';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// max effort의 어댑티브 thinking이 출력 토큰을 크게 소모한다. 모델 상한을 쓴다.
const DEFAULT_MAX_TOKENS = 128000;
const FINAL_DIRECTIVE = '지금 바로 위 지시에 따라 결과를 출력하세요. 출력은 마크다운 코드블록 없이 "{"로 시작해 "}"로 끝나는 JSON 객체 하나여야 합니다. 인사말·설명·YAML 별도 블록을 붙이지 말고, YAML 전문은 반드시 JSON의 "yaml" 문자열 필드 안에 넣으세요.';

function normalizeEffort(value, fallback = DEFAULT_EFFORT) {
  const compact = String(value || fallback).toLowerCase().replace(/[\s_-]+/g, '');
  const aliases = {
    extrahigh: 'xhigh', xhigh: 'xhigh',
    highest: 'max', max: 'max',
    low: 'low', medium: 'medium', mediumhigh: 'high', high: 'high'
  };
  const effort = aliases[compact] || compact;
  return EFFORT_LEVELS.includes(effort) ? effort : fallback;
}

// images: [{ mediaType: 'image/jpeg', data: base64 }] — 텍스트 앞에 붙는다(영상 단계의 보드·프레임 시트).
// finalDirective: 마지막 출력 지시. 기본은 제작 명세(JSON)용이고, 영상 코드 단계는 태그 형식 지시를 넘긴다.
function buildClaudePayload({ model = DEFAULT_MODEL, instructions, userText, effort = DEFAULT_EFFORT, maxTokens = DEFAULT_MAX_TOKENS, images = [], finalDirective = FINAL_DIRECTIVE }) {
  const instructionText = String(instructions || '').trim();
  const inputText = String(userText || '').trim();
  const content = [instructionText, inputText, finalDirective].filter(Boolean).join('\n\n---\n\n');
  const imageBlocks = (images || []).filter((img) => img?.data).map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data }
  }));
  return {
    model,
    max_tokens: Math.max(1024, Number(maxTokens) || DEFAULT_MAX_TOKENS),
    system: SYSTEM_PREFIX,
    messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: content }] }],
    stream: true,
    output_config: { effort: normalizeEffort(effort) }
  };
}

function claudeHeaders(token) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': OAUTH_BETAS,
    'user-agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
    'x-app': 'cli'
  };
}

// HTTP 오류 본문을 사용자 메시지로 변환한다.
// claude_code_version_too_old 는 서버가 클라이언트 버전으로 모델을 막는 경우라 별도 안내.
function mapHttpError(status, raw, { retryAfter } = {}) {
  let detail = null;
  try { detail = JSON.parse(String(raw)); } catch {}
  const errorCode = String(detail?.error?.details?.error_code || '');
  if (errorCode === 'claude_code_version_too_old') {
    const error = new Error(`Claude Code 클라이언트 버전이 낮아 이 모델을 사용할 수 없습니다. 앱의 Claude Code 버전을 ${MIN_CLI_VERSION_FOR_SUPPORT} 이상으로 올려야 합니다.`);
    error.code = 'CLAUDE_VERSION_TOO_OLD';
    error.terminal = true;
    return error;
  }
  const mapped = LLMErrors.fromHttp(status, raw, { service: 'Claude', retryAfter });
  if (status === 429) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) mapped.retryAfterSec = seconds;
  }
  return mapped;
}

function streamFailure(detail) {
  const type = String(detail?.type || '');
  if (type === 'authentication_error' || type === 'permission_error') {
    const error = new Error('[LLM_AUTH_REQUIRED] Claude 인증이 거부되었습니다. 상단의 "Claude 로그인"을 다시 실행해 주세요.');
    error.code = 'LLM_AUTH_REQUIRED';
    error.terminal = true;
    return error;
  }
  return LLMErrors.fromStream(detail) || new Error(`${detail?.message || 'Claude 응답 오류'} (${type || 'error'})`);
}

// Anthropic Messages SSE: data 전용 라인을 파싱한다(data JSON 안에 type 필드가 있음).
async function readClaudeStream(response, deadline, onDelta = () => {}) {
  if (!response.body?.getReader) throw new Error('Claude 응답 스트림이 없습니다. 다시 요청해 주세요.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let text = '';
  let thinkingChars = 0;
  let model = '';
  let stopReason = '';
  let terminal = false;
  let completed = false;
  let failure = '';

  const handleData = () => {
    if (!dataLines.length || terminal) return;
    const data = dataLines.join('\n');
    dataLines = [];
    let event;
    try { event = JSON.parse(data); }
    catch { throw new Error('Claude 응답 스트림을 해석할 수 없습니다. 미완성 응답은 적용하지 않았습니다.'); }
    const type = String(event?.type || '');
    if (type === 'message_start') {
      model = event.message?.model || model;
    } else if (type === 'content_block_delta') {
      const delta = event.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        try { onDelta({ kind: 'text', text: delta.text }); } catch {}
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        thinkingChars += delta.thinking.length;
        try { onDelta({ kind: 'reasoning', text: delta.thinking }); } catch {}
      }
    } else if (type === 'message_delta') {
      stopReason = event.delta?.stop_reason || stopReason;
    } else if (type === 'message_stop') {
      terminal = true;
      completed = true;
    } else if (type === 'error') {
      failure = streamFailure(event.error);
      terminal = true;
    }
  };

  const consumeLine = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '') handleData();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };

  try {
    while (!terminal) {
      const { value, done } = await deadline.wait(reader.read());
      if (done) {
        buffer += decoder.decode();
        if (buffer) consumeLine(buffer);
        handleData();
        break;
      }
      if (value?.byteLength) deadline.touch();
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while (!terminal && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    }
  } finally {
    Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
  if (failure) throw failure instanceof Error ? failure : new Error(failure);
  if (!completed) throw new Error('Claude 연결이 응답 완료 전에 종료되었습니다. 미완성 응답은 적용하지 않았습니다. 다시 요청해 주세요.');
  if (stopReason === 'refusal') throw new Error('Claude가 이 요청을 거부했습니다. 주제나 표현을 조정해 다시 시도해 주세요.');
  if (!text.trim()) {
    throw new Error(stopReason === 'max_tokens'
      ? `Claude가 추론(thinking ${thinkingChars.toLocaleString()}자)에 출력 토큰을 모두 사용해 결과를 작성하지 못했습니다. 잠시 후 다시 시도해 주세요.`
      : 'Claude 응답에 텍스트가 없습니다.');
  }
  return { content: text, model: model || DEFAULT_MODEL, stopReason };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => {
      const error = new Error('생성이 취소되었습니다.');
      error.code = 'CANCELLED';
      reject(error);
    };
    if (signal?.aborted) return fail();
    const onAbort = () => { cleanup(); fail(); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAITS_MS = [15000, 45000];

async function chatOnce({ token, payload, onDelta, signal, fetchImpl = fetch }) {
  // max effort 장문 생성은 오래 걸린다. 총 대기 상한을 넉넉히 둔다.
  const deadline = createRequestDeadline({ signal, totalMs: 3600000 });
  let stage = 'connect';
  try {
    const response = await deadline.wait(fetchImpl(API_URL, {
      method: 'POST',
      headers: claudeHeaders(token),
      body: JSON.stringify(payload),
      signal: deadline.signal
    }));
    deadline.touch();
    stage = 'stream';
    if (!response.ok) {
      const raw = await deadline.wait(response.text());
      if (response.status === 404 && /model/i.test(raw)) {
        throw new Error(`Claude 모델 ${payload.model}을 현재 계정에서 사용할 수 없습니다: ${raw.slice(0, 200)}`);
      }
      throw mapHttpError(response.status, raw, { retryAfter: response.headers?.get('retry-after') });
    }
    const result = await readClaudeStream(response, deadline, onDelta);
    return { content: result.content, model: result.model, effort: payload.output_config.effort, stopReason: result.stopReason };
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = new Error('생성이 취소되었습니다.');
      cancelled.code = 'CANCELLED';
      throw cancelled;
    }
    if (deadline.signal.aborted) {
      throw deadline.signal.reason instanceof Error
        ? deadline.signal.reason
        : new Error('Claude 연결의 응답 대기시간이 초과되었습니다. 잠시 후 다시 요청해 주세요.');
    }
    if (stage === 'connect') throw new Error(`Claude 서버에 연결할 수 없습니다: ${error.message}`);
    throw error;
  } finally {
    deadline.dispose();
  }
}

// 429는 Claude 구독 쪽 단기 스로틀인 경우가 많아 잠시 기다렸다 자동으로 다시 시도한다.
async function chat({ token, instructions, userText, images, finalDirective, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, maxTokens, onDelta, signal, fetchImpl = fetch, rateLimitWaits = RATE_LIMIT_WAITS_MS }) {
  const payload = buildClaudePayload({ model, instructions, userText, effort, maxTokens, images, finalDirective });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chatOnce({ token, payload, onDelta, signal, fetchImpl });
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      const retryable = Number(error?.status) === 429 || error?.code === 'LLM_RATE_LIMIT';
      if (!retryable || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
      const waitMs = Number(error?.retryAfterSec) > 0
        ? Number(error.retryAfterSec) * 1000
        : rateLimitWaits[Math.min(attempt, rateLimitWaits.length - 1)];
      try {
        onDelta?.({
          kind: 'status',
          text: `Claude가 잠시 요청을 제한했습니다. ${Math.round(waitMs / 1000)}초 후 자동으로 다시 시도합니다… (재시도 ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`
        });
      } catch {}
      await delay(waitMs, signal);
    }
  }
}

module.exports = {
  API_URL,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  FINAL_DIRECTIVE,
  EFFORT_LEVELS,
  SYSTEM_PREFIX,
  CLAUDE_CLI_VERSION,
  MIN_CLI_VERSION_FOR_SUPPORT,
  normalizeEffort,
  claudeHeaders,
  buildClaudePayload,
  mapHttpError,
  readClaudeStream,
  chat
};
