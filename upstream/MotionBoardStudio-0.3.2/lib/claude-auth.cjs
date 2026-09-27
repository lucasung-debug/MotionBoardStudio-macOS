'use strict';

const { app, safeStorage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const oauth = require('./claude-oauth.cjs');

// Claude 구독 인증 해석 우선순위:
// 1) 이 앱에서 로그인한 OAuth 토큰(safeStorage 암호화 저장, 자동 갱신)
// 2) 환경변수 CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN (앱에서 로그아웃하면 다시 로그인할 때까지 쓰지 않음)
//
// Claude Code 로그인 파일(~/.claude/.credentials.json)은 읽지 않는다. 자동으로 가져오면
// 로그인하지 않은 사람도 "연결됨"으로 보이고, 로그아웃해도 다시 잡히며, 앱이 그 갱신 토큰을 쓰는 순간
// 토큰이 교체되어 사용자의 Claude Code 로그인까지 풀릴 수 있기 때문이다.
//
// 로그인은 Claude Code와 동일한 PKCE 플로우다. 승인 페이지가 코드를 표시하면
// 사용자가 앱에 붙여넣고, 앱이 토큰으로 교환한다(Anthropic은 루프백 콜백이 없음).

const PENDING_TTL_MS = 10 * 60 * 1000;
const ENV_TOKENS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

let statusSink = null;
let pendingLogin = null;

function configFile() {
  return path.join(app.getPath('userData'), 'motion-board', 'claude-oauth.bin');
}

async function readEntry() {
  try {
    if (!fs.existsSync(configFile())) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const raw = safeStorage.decryptString(await fsp.readFile(configFile()));
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeEntry(entry) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 보안 저장소를 사용할 수 없습니다.');
  await fsp.mkdir(path.dirname(configFile()), { recursive: true });
  await fsp.writeFile(configFile(), safeStorage.encryptString(JSON.stringify(entry)));
}

async function clearEntry() {
  try { await fsp.rm(configFile(), { force: true }); } catch {}
}

// 로그아웃 표시: 있으면 환경변수 토큰도 쓰지 않는다. 앱에서 다시 로그인하면 지운다.
function loggedOutFlag() {
  return path.join(app.getPath('userData'), 'motion-board', 'claude-logged-out');
}

async function setLoggedOut(value) {
  try {
    if (value) {
      await fsp.mkdir(path.dirname(loggedOutFlag()), { recursive: true });
      await fsp.writeFile(loggedOutFlag(), String(Date.now()));
    } else {
      await fsp.rm(loggedOutFlag(), { force: true });
    }
  } catch {}
}

function envEntry() {
  for (const name of ENV_TOKENS) {
    const token = String(process.env[name] || '').trim();
    if (token) return { accessToken: token, refreshToken: '', expiresAt: 0, subscriptionType: '', source: 'env' };
  }
  return null;
}

async function resolveEntry() {
  return oauth.pickCredential({ stored: await readEntry(), env: envEntry(), loggedOut: fs.existsSync(loggedOutFlag()) });
}

// publicStatus 결과를 다시 publicStatus 에 넣으면 로그아웃 상태가 로그인으로
// 뒤집히므로, emit 에는 항상 { entry, source } 원본만 넘긴다.
function emit(resolved) {
  try { statusSink?.(publicStatus(resolved.entry, resolved.source)); } catch {}
}

function publicStatus(entry, source = '') {
  if (!entry) return { loggedIn: false, source: '', pending: Boolean(pendingLogin) };
  return {
    loggedIn: true,
    source,
    pending: Boolean(pendingLogin),
    subscriptionType: entry.subscriptionType || '',
    expiresAt: entry.expiresAt || 0
  };
}

async function status() {
  const resolved = await resolveEntry();
  emit(resolved);
  return publicStatus(resolved.entry, resolved.source);
}

async function getAuth() {
  const resolved = await resolveEntry();
  const { entry, source } = resolved;
  if (!entry) {
    throw new Error('Claude에 먼저 로그인해 주세요. 상단의 "Claude 로그인" 버튼을 눌러 주세요.');
  }
  if (oauth.isExpiring(entry)) {
    // 갱신할 수 없거나 갱신이 거부되면 "연결됨"으로 남겨 두지 않고 로그아웃 상태로 바꾼다.
    const expired = async (detail) => {
      if (source === 'oauth') await clearEntry();
      emit(await resolveEntry());
      const error = new Error(`[LLM_AUTH_REQUIRED] Claude 로그인이 만료되었습니다. 상단의 "Claude 로그인"으로 다시 로그인해 주세요.${detail ? ` (${detail})` : ''}`);
      error.code = 'LLM_AUTH_REQUIRED';
      error.terminal = true;
      return error;
    };
    if (!entry.refreshToken) throw await expired('');
    let refreshed;
    try {
      refreshed = await oauth.refreshTokens(entry);
    } catch (error) {
      throw await expired(String(error.message || '').slice(0, 120));
    }
    await writeEntry(refreshed).catch(() => {});
    return { token: refreshed.accessToken, source, expiresAt: refreshed.expiresAt };
  }
  return { token: entry.accessToken, source, expiresAt: entry.expiresAt || 0 };
}

async function loginStart() {
  if (pendingLogin) throw new Error('이미 로그인 진행 중입니다. 브라우저에서 승인해 주세요.');
  const pkce = oauth.generatePkce();
  const state = oauth.base64url(crypto.randomBytes(24));
  pendingLogin = { verifier: pkce.verifier, state, at: Date.now() };
  const url = oauth.buildAuthorizeUrl(pkce.challenge, state);
  await shell.openExternal(url);
  return { url };
}

async function loginComplete(pasted) {
  const pending = pendingLogin;
  if (!pending || Date.now() - pending.at > PENDING_TTL_MS) {
    pendingLogin = null;
    throw new Error('로그인 세션이 없거나 만료되었습니다. "Claude 로그인"을 다시 눌러 주세요.');
  }
  const parsed = oauth.parsePastedCode(pasted);
  if (!parsed.state) throw new Error('코드에 state 값이 없습니다. 브라우저에 표시된 "코드#state" 전체를 붙여넣어 주세요.');
  if (parsed.state !== pending.state) throw new Error('OAuth state가 일치하지 않습니다. "Claude 로그인"을 다시 실행해 주세요.');
  const entry = await oauth.exchangeCode({ code: parsed.code, state: parsed.state, verifier: pending.verifier });
  entry.subscriptionType = entry.subscriptionType || '';
  await writeEntry(entry);
  await setLoggedOut(false);
  pendingLogin = null;
  const resolved = { entry, source: 'oauth' };
  emit(resolved);
  return publicStatus(entry, 'oauth');
}

function cancelLogin() {
  pendingLogin = null;
}

async function logout() {
  await clearEntry();
  await setLoggedOut(true);
  const resolved = await resolveEntry();
  emit(resolved);
  return publicStatus(resolved.entry, resolved.source);
}

function init({ onStatus } = {}) {
  statusSink = onStatus || statusSink;
}

module.exports = {
  init,
  status,
  getAuth,
  loginStart,
  loginComplete,
  cancelLogin,
  logout
};
