'use strict';

// Claude(구독) OAuth PKCE 도우미 — electron 비의존(테스트 가능).
// Claude Code와 같은 클라이언트로 claude.ai 승인 → 코드 붙여넣기 → 토큰 교환을 수행한다.
// Anthropic의 리다이렉트는 루프백이 아니라 코드 표시 페이지라서, 앱이 코드를 받아 교환한다.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'user:inference user:profile';
const REFRESH_MARGIN_MS = 120 * 1000;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(challenge, state) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: String(challenge || ''),
    code_challenge_method: 'S256',
    state: String(state || '')
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// 승인 페이지가 보여주는 "코드#state" 형식을 파싱한다. state는 없을 수도 있다.
function parsePastedCode(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('브라우저에 표시된 코드를 입력해 주세요.');
  const hashIndex = text.indexOf('#');
  const code = (hashIndex >= 0 ? text.slice(0, hashIndex) : text).trim();
  const state = hashIndex >= 0 ? text.slice(hashIndex + 1).trim() : '';
  if (!/^[A-Za-z0-9._~-]+$/.test(code)) throw new Error('코드 형식이 올바르지 않습니다. 브라우저에 표시된 값을 그대로 붙여넣어 주세요.');
  return { code, state };
}

// ~/.claude/.credentials.json (Claude Code 로그인 파일)을 읽기 전용으로 해석한다.
function normalizeCredentials(raw, { source = 'claude-code' } = {}) {
  const oauth = raw?.claudeAiOauth && typeof raw.claudeAiOauth === 'object' ? raw.claudeAiOauth : raw;
  const accessToken = String(oauth?.accessToken || '').trim();
  if (!accessToken) return null;
  let expiresAt = Number(oauth.expiresAt) || 0;
  if (expiresAt > 0 && expiresAt < 1e12) expiresAt *= 1000; // 초 단위로 저장된 경우 보정
  return {
    accessToken,
    refreshToken: String(oauth.refreshToken || '').trim(),
    expiresAt,
    subscriptionType: String(oauth.subscriptionType || '').trim(),
    source
  };
}

function credentialsFilePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', '.credentials.json');
}

function readCredentialsFile(homeDir = os.homedir()) {
  const file = credentialsFilePath(homeDir);
  try {
    return { file, entry: normalizeCredentials(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch {
    return { file, entry: null };
  }
}

function toEntry(tokens, previous = {}) {
  const expiresIn = Number(tokens?.expires_in) || 3600;
  return {
    accessToken: String(tokens?.access_token || ''),
    refreshToken: String(tokens?.refresh_token || previous.refreshToken || ''),
    expiresAt: Date.now() + expiresIn * 1000,
    subscriptionType: String(previous.subscriptionType || '')
  };
}

async function exchangeCode({ code, state, verifier, fetchImpl = fetch, timeoutMs = 30000 }) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude 토큰 교환 실패 (${response.status}): ${raw.slice(0, 300)}`);
  const entry = toEntry(JSON.parse(raw));
  if (!entry.accessToken) throw new Error('Claude 토큰 응답에 access_token이 없습니다.');
  return entry;
}

async function refreshTokens(entry, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!entry?.refreshToken) throw new Error('갱신 토큰이 없어 다시 로그인해야 합니다.');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: entry.refreshToken
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude 토큰 갱신 실패 (${response.status}): ${raw.slice(0, 300)}`);
  const next = toEntry(JSON.parse(raw), entry);
  if (!next.accessToken) throw new Error('Claude 갱신 응답에 access_token이 없습니다.');
  return next;
}

// 어떤 자격 증명을 쓸지 고른다: 앱에서 로그인한 토큰 → (로그아웃하지 않았다면) 환경변수 토큰.
// Claude Code 로그인 파일은 후보에 넣지 않는다(자동 연결·로그아웃 불가·토큰 교체 문제).
function pickCredential({ stored, env, loggedOut = false } = {}) {
  if (stored?.accessToken) return { entry: { ...stored, source: 'oauth' }, source: 'oauth' };
  if (env?.accessToken && !loggedOut) return { entry: env, source: 'env' };
  return { entry: null, source: '' };
}

function isExpiring(entry, marginMs = REFRESH_MARGIN_MS) {
  const expiresAt = Number(entry?.expiresAt) || 0;
  if (!expiresAt) return false; // 만료 시각이 없는 토큰(환경변수·setup-token)은 그대로 사용
  return expiresAt - Date.now() <= marginMs;
}

module.exports = {
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  SCOPES,
  REFRESH_MARGIN_MS,
  base64url,
  generatePkce,
  buildAuthorizeUrl,
  parsePastedCode,
  normalizeCredentials,
  credentialsFilePath,
  readCredentialsFile,
  exchangeCode,
  refreshTokens,
  pickCredential,
  isExpiring
};
