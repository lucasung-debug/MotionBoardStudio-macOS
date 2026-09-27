'use strict';

// ChatGPT 구독 OAuth 토큰으로 Codex 백엔드 Responses API를 호출하는 클라이언트.
// - 모델: gpt-6-astra (기본) · 추론 강도: xhigh ("extra high")
// - 텍스트 생성(제작 명세)과 이미지 생성(4×4 디자인 보드)을 모두 지원한다.
// - 이 파일은 electron 을 require 하지 않는다. 토큰은 호출자가 넘겨준다(테스트 가능).

const LLMErrors = require('./llm-errors.cjs');
const { REQUEST_TIMEOUTS, createRequestDeadline } = require('./deadline.cjs');

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// 서버가 version 헤더로 모델을 게이트한다(예: gpt-6-astra 는 최신 Codex 필요).
// 거부되면 npm 의 @openai/codex 최신 버전으로 올려 자동 재시도한다(세션 동안 유지).
const CODEX_VERSION = '0.157.1';
const NPM_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest';
let codexVersion = CODEX_VERSION;
const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_REASONING = 'xhigh';
// 같은 시즌에 계정별로 열려 있는 모델 슬러그가 다르다. Astra가 막히면 순차 폴백.
const MODEL_FALLBACKS = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'];
const unavailableModels = new Set();

function normalizeReasoningEffort(value, model = DEFAULT_MODEL) {
  const compact = String(value || DEFAULT_REASONING).toLowerCase().replace(/[\s_-]+/g, '');
  const aliases = {
    extrahigh: 'xhigh', xhigh: 'xhigh', xhighest: 'max',
    none: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max'
  };
  const allowed = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let effort = allowed.includes(aliases[compact] || compact) ? (aliases[compact] || compact) : DEFAULT_REASONING;
  if (String(model).startsWith('gpt-6-astra') && ['none', 'minimal'].includes(effort)) effort = 'low';
  // 이전 세대 폴백은 xhigh까지만 받는다. 옵션 때문에 폴백이 실패하지 않게 낮춘다.
  if (String(model).startsWith('gpt-5.5') && effort === 'max') effort = 'xhigh';
  return effort;
}

function buildCodexPayload({ model, instructions, input, reasoningEffort }) {
  return {
    model,
    instructions: instructions || undefined,
    input,
    reasoning: {
      effort: normalizeReasoningEffort(reasoningEffort, model),
      summary: 'auto'
    },
    stream: true,
    store: false,
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    include: []
  };
}

function buildImagePayload({ model, prompt, size }) {
  return {
    model,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }]
    }],
    stream: true,
    store: false,
    tools: [{ type: 'image_generation', output_format: 'png', size }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    include: []
  };
}

function openaiSizeFor(aspectRatio) {
  const value = String(aspectRatio || '1:1').replace(/\s+/g, '');
  if (value === '16:9') return '1536x1024';
  if (value === '9:16') return '1024x1792';
  return '1024x1024';
}

// SSE(text/event-stream)를 읽어 최종 텍스트와 추론 요약 델타를 콜백한다.
// [DONE]/EOF만으로는 완료로 치지 않고 response.completed 를 요구한다(미완성 응답 적용 방지).
async function readResponsesStream(response, deadline, onDelta = () => {}) {
  if (!response.body?.getReader) throw new Error('ChatGPT 응답 스트림이 없습니다. 다시 요청해 주세요.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let text = '';
  let model = '';
  let terminal = false;
  let completed = false;
  let failure = '';

  const handleEvent = () => {
    if (!dataLines.length || terminal) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data.trim() === '[DONE]') { terminal = true; return; }
    let event;
    try { event = JSON.parse(data); }
    catch { throw new Error('ChatGPT 응답 스트림을 해석할 수 없습니다. 미완성 응답은 적용하지 않았습니다.'); }
    const type = String(event?.type || '');
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
      try { onDelta({ kind: 'text', text: event.delta }); } catch {}
    } else if (type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      try { onDelta({ kind: 'reasoning', text: event.delta }); } catch {}
    } else if (type === 'response.created') {
      try { onDelta({ kind: 'status', text: '모델이 응답을 생성하기 시작했습니다.' }); } catch {}
    } else if (type === 'response.completed' || type === 'response.done') {
      const result = event.response || {};
      terminal = true;
      if (result.error || (result.status && result.status !== 'completed')) {
        failure = LLMErrors.fromStream(result.error) || result.error?.message || `응답 생성이 완료되지 않았습니다 (${result.status}).`;
        return;
      }
      completed = true;
      model = result.model || model;
      const finalText = (result.output || [])
        .filter((item) => item?.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .join('');
      if (finalText) text = finalText;
    } else if (['response.failed', 'response.incomplete', 'response.cancelled', 'error', 'response.error'].includes(type)) {
      terminal = true;
      failure = LLMErrors.fromStream(event.response?.error || event.error || event)
        || event.response?.error?.message || event.error?.message || event.message
        || `응답 생성이 완료되지 않았습니다 (${event.response?.incomplete_details?.reason || type}).`;
    }
  };

  const consumeLine = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '') handleEvent();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };

  try {
    while (!terminal) {
      const { value, done } = await deadline.wait(reader.read());
      if (done) {
        buffer += decoder.decode();
        if (buffer) consumeLine(buffer);
        handleEvent();
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
  if (!completed) throw new Error('ChatGPT 연결이 응답 완료 전에 종료되었습니다. 미완성 응답은 적용하지 않았습니다. 다시 요청해 주세요.');
  return { content: text, model };
}

function codexHeaders(accessToken, accountId) {
  return {
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    version: codexVersion
  };
}

function modelProblem(error) {
  const message = String(error?.message || '');
  return /\((?:400|404)\)/.test(message) && /model/i.test(message);
}

// "The 'gpt-6-astra' model requires a newer version of Codex" — 모델이 없는 게 아니라 클라이언트 버전 문제다.
function versionGated(error) {
  return /newer version of codex/i.test(String(error?.message || ''));
}

function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// npm 에서 최신 Codex 버전을 읽어 올린다. 올렸으면 true.
async function upgradeCodexVersion({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(NPM_LATEST_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    const latest = String((await res.json())?.version || '');
    if (!/^\d+\.\d+\.\d+$/.test(latest) || !newerVersion(latest, codexVersion)) return false;
    codexVersion = latest;
    return true;
  } catch {
    return false;
  }
}

async function postCodex(payload, { accessToken, accountId, signal, deadlineOptions, fetchImpl = fetch } = {}) {
  const deadline = createRequestDeadline({ signal, ...(deadlineOptions || {}) });
  let stage = 'connect';
  try {
    const response = await deadline.wait(fetchImpl(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: codexHeaders(accessToken, accountId),
      body: JSON.stringify(payload),
      signal: deadline.signal
    }));
    deadline.touch();
    stage = 'stream';
    if (!response.ok) {
      const raw = await deadline.wait(response.text());
      throw LLMErrors.fromHttp(response.status, raw, { service: 'ChatGPT', retryAfter: response.headers?.get('retry-after') });
    }
    return { response, deadline };
  } catch (error) {
    deadline.dispose();
    if (signal?.aborted) {
      const cancelled = new Error('생성이 취소되었습니다.');
      cancelled.code = 'CANCELLED';
      throw cancelled;
    }
    if (deadline.signal.aborted) {
      throw deadline.signal.reason instanceof Error
        ? deadline.signal.reason
        : new Error('ChatGPT 연결의 응답 대기시간이 초과되었습니다. 잠시 후 다시 요청해 주세요.');
    }
    if (stage === 'connect') throw new Error(`ChatGPT 서버에 연결할 수 없습니다: ${error.message}`);
    throw error;
  }
}

// 제작 명세(텍스트) 생성. 모델을 사용할 수 없으면(MODEL 오류) 폴백 슬러그를 순차 시도한다.
async function chat({ accessToken, accountId, instructions, input, model = DEFAULT_MODEL, reasoningEffort = DEFAULT_REASONING, onDelta, signal, fetchImpl = fetch }) {
  const preferred = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const candidates = [...new Set([preferred, ...MODEL_FALLBACKS])].filter((slug) => !unavailableModels.has(slug));
  if (!candidates.length) candidates.push(...MODEL_FALLBACKS);

  let lastError;
  let triedUpgrade = false;
  const reasons = new Map();
  for (let i = 0; i < candidates.length; i += 1) {
    const slug = candidates[i];
    let posted;
    try {
      const payload = buildCodexPayload({ model: slug, instructions, input, reasoningEffort });
      posted = await postCodex(payload, { accessToken, accountId, signal, fetchImpl });
      const result = await readResponsesStream(posted.response, posted.deadline, onDelta);
      const why = reasons.get(preferred) || '현재 연결에서 사용할 수 없어';
      return {
        content: result.content,
        model: result.model || slug,
        reasoningEffort: payload.reasoning.effort,
        requestedModel: preferred,
        fallbackReason: slug !== preferred ? `${preferred} 모델을 ${why} ${result.model || slug}로 처리했습니다.` : null
      };
    } catch (error) {
      lastError = error;
      // 버전 게이트: 최신 Codex 버전으로 올려 같은 모델을 한 번 더 시도한다.
      if (versionGated(error) && !triedUpgrade) {
        triedUpgrade = true;
        if (await upgradeCodexVersion({ fetchImpl })) { i -= 1; continue; }
      }
      if (LLMErrors.isTerminal(error)) throw error;
      if (!modelProblem(error)) throw error;
      if (versionGated(error)) reasons.set(slug, `Codex 버전 제한(최신 ${codexVersion}로도 거부)으로 쓸 수 없어`);
      unavailableModels.add(slug);
    } finally {
      posted?.deadline.dispose();
    }
  }
  throw lastError;
}

// 이미지 생성(4×4 디자인 보드). image_generation 툴 결과(base64 PNG)를 Buffer로 돌려준다.
async function generateImage({ accessToken, accountId, prompt, size = '1024x1024', model = DEFAULT_MODEL, onProgress, signal, fetchImpl = fetch }) {
  const preferred = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const candidates = [...new Set([preferred, ...MODEL_FALLBACKS])].filter((slug) => !unavailableModels.has(slug));
  if (!candidates.length) candidates.push(...MODEL_FALLBACKS);

  let lastError;
  let triedUpgrade = false;
  for (let i = 0; i < candidates.length; i += 1) {
    const slug = candidates[i];
    let posted;
    try {
      // 이미지 생성은 첫 이벤트가 보통 수십 초 안에 온다. 한도 초과 계정이 응답 없이
      // 매달리는 경우를 대비해 텍스트 생성보다 짧은 대기 상한을 쓴다.
      posted = await postCodex(buildImagePayload({ model: slug, prompt, size }), {
        accessToken,
        accountId,
        signal,
        fetchImpl,
        deadlineOptions: { firstByteMs: 90000, idleMs: 180000 }
      });
      const image = await readImageStream(posted.response, posted.deadline, onProgress);
      return { buffer: image.buffer, model: image.model || slug, requestedModel: preferred, fallbackReason: slug !== preferred ? `${preferred} 모델을 이미지 생성에 사용할 수 없어 ${slug}로 처리했습니다.` : null };
    } catch (error) {
      lastError = error;
      if (versionGated(error) && !triedUpgrade) {
        triedUpgrade = true;
        if (await upgradeCodexVersion({ fetchImpl })) { i -= 1; continue; }
      }
      if (LLMErrors.isTerminal(error)) throw error;
      if (!modelProblem(error)) throw error;
      unavailableModels.add(slug);
    } finally {
      posted?.deadline.dispose();
    }
  }
  throw lastError;
}

async function readImageStream(response, deadline, onProgress = () => {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let imageBase64 = '';
  let failureMessage = '';
  let terminal = false;
  let model = '';

  const handleEvent = (rawData) => {
    let event;
    try { event = JSON.parse(rawData); } catch { return; }
    const type = String(event?.type || '');
    if (type === 'response.output_item.done') {
      const item = event.item;
      if (item?.type === 'image_generation_call' && typeof item.result === 'string') {
        imageBase64 = item.result;
        try { onProgress({ phase: 'image_done' }); } catch {}
      }
    } else if (type === 'response.image_generation_call.partial_image') {
      try { onProgress({ phase: 'image_partial', partial: true }); } catch {}
    } else if (type === 'response.completed' || type === 'response.done') {
      terminal = true;
      model = event.response?.model || model;
    } else if (type === 'response.failed' || type === 'error' || type === 'response.error') {
      failureMessage = LLMErrors.fromStream(event.response?.error || event.error || event)
        || event.response?.error?.message || event.message || event.error?.message || '이미지 생성이 실패했습니다.';
      terminal = true;
    }
  };

  try {
    while (!terminal) {
      const { value, done } = await deadline.wait(reader.read());
      if (done) break;
      if (value?.byteLength) deadline.touch();
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        handleEvent(data);
      }
    }
  } finally {
    Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
  if (failureMessage) throw failureMessage instanceof Error ? failureMessage : new Error(failureMessage);
  if (!imageBase64) throw new Error('이미지 응답을 찾지 못했습니다. 이 계정은 이미지 생성이 제한되어 있을 수 있습니다.');
  return { buffer: Buffer.from(imageBase64, 'base64'), model };
}

// 문자열/중첩을 고려해 균형 잡힌 JSON 객체 후보를 모두 찾는다.
// (앞뒤 설명에 중괄호가 섞여도 실제 객체를 놓치지 않는다)
function findBalancedObjects(text) {
  const found = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { if (inString) escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try { found.push({ value: JSON.parse(candidate), length: candidate.length }); } catch {}
          break;
        }
      }
    }
  }
  return found;
}

// LLM 출력에서 JSON 객체를 추출한다(코드블록/앞뒤 설명/설명 속 중괄호 허용).
function extractJson(text) {
  const trimmed = String(text || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const candidates = findBalancedObjects(trimmed);
  if (candidates.length) {
    const contractLike = candidates.find((item) =>
      item.value && typeof item.value === 'object'
      && ('yaml' in item.value || 'image_prompt' in item.value || 'title' in item.value));
    if (contractLike) return contractLike.value;
    return candidates.sort((a, b) => b.length - a.length)[0].value;
  }
  throw new Error('응답에서 결과(JSON)를 찾지 못했습니다. 다시 시도해 주세요.');
}

module.exports = {
  CODEX_RESPONSES_URL,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  MODEL_FALLBACKS,
  REQUEST_TIMEOUTS,
  normalizeReasoningEffort,
  buildCodexPayload,
  buildImagePayload,
  openaiSizeFor,
  createRequestDeadline,
  readResponsesStream,
  chat,
  generateImage,
  extractJson,
  CODEX_VERSION,
  NPM_LATEST_URL,
  versionGated,
  codexVersion: () => codexVersion,
  __test: {
    setVersion(v) { codexVersion = v; },
    resetModels() { unavailableModels.clear(); }
  }
};
