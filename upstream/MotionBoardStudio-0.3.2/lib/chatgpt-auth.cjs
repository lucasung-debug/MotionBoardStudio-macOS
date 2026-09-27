'use strict';

const { app, safeStorage, shell } = require('electron');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// "Sign in with ChatGPT" OAuth (Codex CLI 와 동일한 PKCE 플로우).
// - 브라우저에서 auth.openai.com 로그인 → http://localhost:1455/auth/callback 으로 코드 반환
// - 토큰 교환 후 access/refresh/id 토큰을 safeStorage 로 암호화해 userData 에 저장
// - 호출 시 만료 임박이면 refresh_token 으로 자동 갱신
//
// 이 클라이언트는 ChatGPT 구독 백엔드(chatgpt.com/backend-api/codex) 전용이며
// api.openai.com API 키가 아니다.

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'codex_cli_rs';
const AUTH_CLAIM = 'https://api.openai.com/auth';

let statusSink = null;
let pendingLogin = null;

function configFile() {
  return path.join(app.getPath('userData'), 'motion-board', 'chatgpt-oauth.bin');
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt || '').split('.')[1];
    if (!part) return {};
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function extractAccountInfo(tokens) {
  const claims = decodeJwtPayload(tokens.id_token);
  const auth = claims[AUTH_CLAIM] || {};
  const exp = Number(claims.exp) || Math.floor(Date.now() / 1000) + 3600;
  return {
    accountId: String(auth.chatgpt_account_id || ''),
    email: String(claims.email || auth.email || ''),
    plan: String(auth.chatgpt_plan_type || ''),
    expiresAt: exp * 1000
  };
}

function publicStatus(entry) {
  if (!entry) return { loggedIn: false, pending: Boolean(pendingLogin) };
  return {
    loggedIn: true,
    pending: Boolean(pendingLogin),
    email: entry.email || '',
    plan: entry.plan || '',
    accountId: entry.accountId || '',
    expiresAt: entry.expiresAt || 0
  };
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

// entry(원본, null 가능)를 받아 공개 상태로 변환해 1회만 알린다.
// publicStatus 결과를 다시 publicStatus 에 넣으면 {loggedIn:false} 가 truthy 로
// 재해석되므로, emit 에는 항상 원본 entry 를 넘긴다.
function emit(entry) {
  try { statusSink?.(publicStatus(entry)); } catch {}
}

async function exchangeTokens(body) {
  const form = new URLSearchParams(body);
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`토큰 교환 실패 (${response.status}): ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  if (!data.access_token) throw new Error('토큰 응답에 access_token이 없습니다.');
  return data;
}

function authorizeUrl(pkce, state) {
  const params = [
    ['response_type', 'code'],
    ['client_id', CLIENT_ID],
    ['redirect_uri', REDIRECT_URI],
    ['scope', SCOPE],
    ['code_challenge', pkce.challenge],
    ['code_challenge_method', 'S256'],
    ['id_token_add_organizations', 'true'],
    ['codex_cli_simplified_flow', 'true'],
    ['state', state],
    ['originator', ORIGINATOR]
  ];
  return `${ISSUER}/oauth/authorize?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

const SUCCESS_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>로그인 완료</title>
<style>body{font-family:system-ui,sans-serif;background:#101014;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{text-align:center;padding:48px;border-radius:16px;background:#1b1b22;box-shadow:0 12px 48px rgba(0,0,0,.5)}
h1{margin:0 0 8px;font-size:22px}p{color:#9a9aa8;margin:0}</style></head>
<body><div class="card"><h1>✅ ChatGPT 로그인 완료</h1><p>안전하게 저장되었습니다. 브라우저 탭을 닫고 스튜디오로 돌아가세요.</p></div></body></html>`;
const FAILURE_HTML = (message) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>로그인 실패</title></head>
<body style="font-family:system-ui,sans-serif;background:#101014;color:#ffb4b4;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div>로그인 실패: ${String(message).replace(/[<>&]/g, '')}</div></body></html>`;

// 브라우저 OAuth 로그인. auth.openai.com 을 기본 브라우저로 열고
// localhost:1455 콜백에서 인증 코드를 받아 토큰으로 교환한다.
async function login() {
  if (pendingLogin) throw new Error('이미 로그인 진행 중입니다. 브라우저에서 로그인을 완료해 주세요.');

  const pkce = generatePkce();
  const state = base64url(crypto.randomBytes(24));
  const url = authorizeUrl(pkce, state);

  const codePromise = new Promise((resolveCode, rejectCode) => {
    const server = http.createServer((req, res) => {
      let parsed;
      try { parsed = new URL(req.url, `http://localhost:${REDIRECT_PORT}`); } catch {
        res.writeHead(400); res.end('Bad Request'); return;
      }
      if (parsed.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not Found'); return; }

      const sendPage = (status, html) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      };

      if (parsed.searchParams.get('state') !== state) {
        sendPage(400, FAILURE_HTML('state 불일치 (CSRF 가능성)'));
        cleanupServer();
        rejectCode(new Error('OAuth state 불일치로 로그인을 중단했습니다.'));
        return;
      }
      const errorCode = parsed.searchParams.get('error');
      if (errorCode) {
        const desc = parsed.searchParams.get('error_description') || '';
        sendPage(400, FAILURE_HTML(errorCode + (desc ? `: ${desc}` : '')));
        cleanupServer();
        rejectCode(new Error(`OAuth 오류: ${errorCode}${desc ? ` ${desc}` : ''}`));
        return;
      }
      const code = parsed.searchParams.get('code');
      if (!code) {
        sendPage(400, FAILURE_HTML('인증 코드가 없습니다.'));
        cleanupServer();
        rejectCode(new Error('인증 코드 없이 콜백이 도착했습니다.'));
        return;
      }
      sendPage(200, SUCCESS_HTML);
      cleanupServer();
      resolveCode(code);
    });

    function cleanupServer() {
      clearTimeout(timeout);
      try { server.close(); } catch {}
      pendingLogin = null;
    }

    const timeout = setTimeout(() => {
      cleanupServer();
      rejectCode(new Error('로그인 시간이 초과되었습니다(5분). 다시 시도해 주세요.'));
    }, 5 * 60 * 1000);

    server.on('error', (error) => {
      clearTimeout(timeout);
      pendingLogin = null;
      const hint = error.code === 'EADDRINUSE'
        ? '포트 1455 가 사용 중입니다. 다른 로그인 창(Codex CLI 등)을 닫고 재시도하세요.'
        : error.message;
      rejectCode(new Error(`로그인 서버 시작 실패: ${hint}`));
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {});
  });

  pendingLogin = { state };
  await shell.openExternal(url);
  try {
    const code = await codePromise;
    const tokens = await exchangeTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier
    });
    const info = extractAccountInfo(tokens);
    if (!info.accountId) throw new Error('id_token에 ChatGPT 계정 정보가 없습니다.');
    const entry = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      idToken: tokens.id_token || '',
      ...info
    };
    await writeEntry(entry);
    emit(entry);
    return publicStatus(entry);
  } finally {
    pendingLogin = null;
  }
}

async function refresh(entry) {
  if (!entry.refreshToken) throw new Error('갱신 토큰이 없습니다. 다시 로그인해 주세요.');
  const tokens = await exchangeTokens({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: entry.refreshToken
  });
  const next = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || entry.refreshToken,
    idToken: tokens.id_token || entry.idToken,
    ...extractAccountInfo(tokens)
  };
  await writeEntry(next);
  emit(next);
  return next;
}

async function getAuth() {
  const entry = await readEntry();
  if (!entry) throw new Error('ChatGPT에 먼저 로그인해 주세요. 상단의 "ChatGPT 로그인" 버튼을 눌러 주세요.');
  const expiresIn = (entry.expiresAt || 0) - Date.now();
  if (expiresIn <= 120 * 1000) {
    const refreshed = await refresh(entry).catch(async (error) => {
      await clearEntry();
      emit(null);
      throw new Error(`로그인 세션이 만료되었습니다. 다시 로그인해 주세요. (${error.message})`);
    });
    return { accessToken: refreshed.accessToken, accountId: refreshed.accountId };
  }
  return { accessToken: entry.accessToken, accountId: entry.accountId };
}

async function status() {
  const entry = await readEntry();
  emit(entry);
  return publicStatus(entry);
}

async function logout() {
  await clearEntry();
  emit(null);
  return publicStatus(null);
}

function init({ onStatus } = {}) {
  statusSink = onStatus || statusSink;
}

module.exports = {
  init,
  login,
  status,
  logout,
  getAuth,
  publicStatus,
  __test: {
    authorizeUrl,
    generatePkce,
    decodeJwtPayload,
    extractAccountInfo,
    CLIENT_ID,
    REDIRECT_URI
  }
};
