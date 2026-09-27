'use strict';

// The portable host owns authentication. Only public status reaches the renderer;
// tokens remain in this process and the app-specific native Keychain service.
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_ISSUER = 'https://auth.openai.com';
const CHATGPT_REDIRECT = 'http://localhost:1455/auth/callback';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const REFRESH_MARGIN_MS = 120_000;
const LOGIN_TTL = { chatgpt: 5 * 60_000, claude: 10 * 60_000 };
const REQUEST_TIMEOUT_MS = 30_000;

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    if (code === 'LLM_AUTH_REQUIRED') this.terminal = true;
  }
}

function failure(code) {
  const messages = {
    AUTH_PENDING: '이미 인증 작업이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.',
    AUTH_STORAGE: '앱 보안 저장소를 읽거나 갱신하지 못했습니다. 다시 시도해 주세요.',
    AUTH_CANCELLED: '로그인을 취소했습니다.',
    AUTH_TIMEOUT: '인증 시간이 초과되었습니다. 다시 로그인해 주세요.',
    AUTH_STATE: '인증 요청을 확인하지 못했습니다. 로그인을 다시 시작해 주세요.',
    AUTH_CODE: '브라우저에 표시된 코드#state 전체를 입력해 주세요.',
    AUTH_CALLBACK: '인증 응답을 확인하지 못했습니다. 로그인을 다시 시작해 주세요.',
    AUTH_PORT: '로그인용 로컬 포트 1455를 열지 못했습니다. 다른 로그인 창을 닫고 다시 시도해 주세요.',
    AUTH_BROWSER: '인증 페이지를 브라우저에서 열지 못했습니다. 다시 시도해 주세요.',
    AUTH_NETWORK: '인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    AUTH_RESPONSE: '인증 서버의 응답을 확인하지 못했습니다. 다시 로그인해 주세요.',
    LLM_AUTH_REQUIRED: '[LLM_AUTH_REQUIRED] 이 앱에서 다시 로그인해 주세요.'
  };
  return new AuthError(code, messages[code] || messages.AUTH_RESPONSE);
}

function safeFailure(error, fallback = 'AUTH_RESPONSE') {
  return error instanceof AuthError ? error : failure(fallback);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A browser login can fail before its initiating IPC call receives the result.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(safeFailure(signal.reason, 'AUTH_CANCELLED'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(safeFailure(signal.reason, 'AUTH_CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jwtClaims(value) {
  try {
    if (typeof value !== 'string' || value.length > 131_072) return {};
    const parsed = JSON.parse(Buffer.from(value.split('.')[1] || '', 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function token(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 131_072 ? value : '';
}

function metadata(value, limit = 254) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
}

function expiry(tokens, now) {
  const expiresIn = Number(tokens.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn <= 366 * 86400) return now + expiresIn * 1000;
  const exp = Number(jwtClaims(tokens.access_token).exp || jwtClaims(tokens.id_token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : now + 3600_000;
}

function storedEntry(account, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !token(value.accessToken)) return null;
  const entry = {
    accessToken: value.accessToken,
    refreshToken: token(value.refreshToken),
    expiresAt: Number.isFinite(value.expiresAt) && value.expiresAt > 0 ? value.expiresAt : 0
  };
  if (account === 'chatgpt') {
    entry.idToken = token(value.idToken);
    entry.accountId = metadata(value.accountId, 200);
    if (!entry.accountId) return null;
    entry.email = metadata(value.email);
    entry.plan = metadata(value.plan, 80);
  } else {
    entry.subscriptionType = metadata(value.subscriptionType, 80);
  }
  return entry;
}

function entryFromTokens(account, tokens, previous, now) {
  if (!tokens || typeof tokens !== 'object' || !token(tokens.access_token)) throw failure('AUTH_RESPONSE');
  const entry = {
    accessToken: tokens.access_token,
    refreshToken: token(tokens.refresh_token) || previous?.refreshToken || '',
    expiresAt: expiry(tokens, now)
  };
  if (account === 'chatgpt') {
    entry.idToken = token(tokens.id_token) || previous?.idToken || '';
    const claims = jwtClaims(token(tokens.id_token) || entry.idToken);
    const access = jwtClaims(tokens.access_token);
    const auth = claims[AUTH_CLAIM] || access[AUTH_CLAIM] || {};
    entry.accountId = metadata(auth.chatgpt_account_id || previous?.accountId, 200);
    entry.email = metadata(claims.email || auth.email || previous?.email);
    entry.plan = metadata(auth.chatgpt_plan_type || previous?.plan, 80);
    if (!entry.accountId) throw failure('AUTH_RESPONSE');
  } else {
    entry.subscriptionType = metadata(tokens.subscription_type || previous?.subscriptionType, 80);
  }
  return entry;
}

function sendPage(response, success, statusCode = 400) {
  if (!response || response.destroyed || response.writableEnded) return Promise.resolve();
  const message = success
    ? '로그인이 완료되었고 앱 보안 저장소에 저장되었습니다. 스튜디오로 돌아가세요.'
    : '로그인을 완료하지 못했습니다. 스튜디오에서 로그인을 다시 시작해 주세요.';
  return new Promise((resolve) => {
    response.once('finish', resolve);
    response.once('close', resolve);
    response.writeHead(success ? 200 : statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff'
    });
    response.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>MotionBoardStudio</title><body><p>${message}</p></body></html>`);
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    try {
      server.close(resolve);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    } catch { resolve(); }
  });
}

function createAuthServices({ sourceRoot, nativeCall, emit = () => {}, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (typeof sourceRoot !== 'string' || typeof nativeCall !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('Authentication requires sourceRoot, nativeCall, and fetch.');
  }
  // Only the pure PKCE, URL, and pasted-code helpers are used. In particular,
  // readCredentialsFile, pickCredential, and all environment-token paths are unused.
  const claudeOAuth = require(path.join(sourceRoot, 'lib', 'claude-oauth.cjs'));

  async function requestTokens(account, body, transaction) {
    const controller = new AbortController();
    const parent = transaction.controller.signal;
    const aborted = () => controller.abort(safeFailure(parent.reason, 'AUTH_CANCELLED'));
    parent.addEventListener('abort', aborted, { once: true });
    if (parent.aborted) aborted();
    const timeout = setTimeout(() => controller.abort(failure('AUTH_TIMEOUT')), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await abortable(fetchImpl(
        account === 'chatgpt' ? `${CHATGPT_ISSUER}/oauth/token` : claudeOAuth.TOKEN_URL,
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': account === 'chatgpt' ? 'application/x-www-form-urlencoded' : 'application/json' },
          body: account === 'chatgpt' ? new URLSearchParams(body).toString() : JSON.stringify(body),
          signal: controller.signal
        }
      ), controller.signal);
      if (!response.ok) {
        // Never include the provider body or a native exception in public errors.
        if ([400, 401, 403].includes(response.status)) throw failure('LLM_AUTH_REQUIRED');
        throw failure('AUTH_NETWORK');
      }
      const raw = await abortable(response.text(), controller.signal);
      if (typeof raw !== 'string' || raw.length > 1_048_576) throw failure('AUTH_RESPONSE');
      try { return JSON.parse(raw); } catch { throw failure('AUTH_RESPONSE'); }
    } catch (error) {
      if (controller.signal.aborted) throw safeFailure(controller.signal.reason, 'AUTH_CANCELLED');
      throw safeFailure(error, 'AUTH_NETWORK');
    } finally {
      clearTimeout(timeout);
      parent.removeEventListener('abort', aborted);
    }
  }

  function createProvider(account) {
    const channel = account === 'chatgpt' ? 'studio:auth' : 'studio:claudeAuth';
    let pending = null, refreshing = null, loggingOut = null, sink = null, epoch = 0;
    let vaultTail = Promise.resolve();

    function publicStatus(entry) {
      const loggedIn = Boolean(entry && (entry.expiresAt > now() || entry.refreshToken));
      const result = { loggedIn, pending: Boolean(pending && !pending.committed) };
      if (account === 'claude') result.source = loggedIn ? 'oauth' : '';
      if (loggedIn) {
        result.expiresAt = entry.expiresAt;
        result.expired = entry.expiresAt <= now();
        if (account === 'chatgpt') Object.assign(result, { email: entry.email, plan: entry.plan, accountId: entry.accountId });
        else result.subscriptionType = entry.subscriptionType;
      }
      return result;
    }

    function notify(entry) {
      const status = publicStatus(entry);
      try { emit(channel, status); } catch {}
      try { sink?.(status); } catch {}
      return status;
    }

    function vault(operation) {
      const result = vaultTail.then(operation).catch((error) => { throw safeFailure(error, 'AUTH_STORAGE'); });
      vaultTail = result.catch(() => {});
      return result;
    }

    function read() {
      return vault(async () => {
        const result = await nativeCall('vault.read', { account });
        const value = typeof result?.value === 'string' ? result.value : null;
        let parsed = null;
        try { parsed = value === null ? null : JSON.parse(value); } catch {}
        return { value, entry: storedEntry(account, parsed) };
      });
    }

    async function notifyStored() {
      if (loggingOut) return;
      try { notify((await read()).entry); } catch { notify(null); }
    }

    function check(transaction) {
      if (transaction.controller.signal.aborted) throw safeFailure(transaction.controller.signal.reason, 'AUTH_CANCELLED');
      if (transaction.epoch !== epoch) throw failure('AUTH_CANCELLED');
    }

    function cancel(transaction, reason = failure('AUTH_CANCELLED')) {
      if (transaction && !transaction.committed && !transaction.controller.signal.aborted) transaction.controller.abort(reason);
    }

    function persist(transaction, entry) {
      return vault(async () => {
        check(transaction);
        let writeError = null;
        try { await nativeCall('vault.write', { account, value: JSON.stringify(entry) }); }
        catch { writeError = failure('AUTH_STORAGE'); }
        if (writeError || transaction.controller.signal.aborted || transaction.epoch !== epoch) {
          // A native write cannot be cancelled. Restore its predecessor before
          // releasing the operation lock, including uncertain write failures.
          if (transaction.previous.value === null) await nativeCall('vault.delete', { account });
          else await nativeCall('vault.write', { account, value: transaction.previous.value });
          if (writeError) throw writeError;
          check(transaction);
        }
        transaction.committed = true;
        clearTimeout(transaction.timer);
      });
    }

    function startLogin(worker) {
      if (pending || refreshing || loggingOut) throw failure('AUTH_PENDING');
      const transaction = {
        epoch, controller: new AbortController(), started: deferred(), code: deferred(),
        committed: false, claimed: false, deadline: now() + LOGIN_TTL[account], response: null, server: null
      };
      pending = transaction;
      transaction.timer = setTimeout(() => cancel(transaction, failure('AUTH_TIMEOUT')), LOGIN_TTL[account]);
      transaction.timer.unref?.();
      transaction.done = (async () => {
        try {
          transaction.previous = await read();
          check(transaction);
          notify(transaction.previous.entry);
          const entry = await worker(transaction);
          await sendPage(transaction.response, true);
          return entry;
        } catch (error) {
          const safe = safeFailure(error);
          transaction.started.reject(safe);
          await sendPage(transaction.response, false, transaction.httpStatus || 400);
          throw safe;
        } finally {
          clearTimeout(transaction.timer);
          await closeServer(transaction.server);
          if (pending === transaction) pending = null;
          await notifyStored();
        }
      })().then((entry) => publicStatus(entry));
      transaction.done.catch(() => {});
      return transaction;
    }

    async function openBrowser(transaction, url) {
      check(transaction);
      try { await abortable(nativeCall('shell.openExternal', { url }), transaction.controller.signal); }
      catch (error) { throw safeFailure(error, 'AUTH_BROWSER'); }
      check(transaction);
    }

    async function chatgptLogin(transaction) {
      const pkce = claudeOAuth.generatePkce();
      const state = crypto.randomBytes(24).toString('base64url');
      const server = http.createServer((request, response) => {
        let url;
        try { url = new URL(request.url, CHATGPT_REDIRECT); } catch {
          response.writeHead(400); response.end('Bad Request'); return;
        }
        if (url.pathname !== '/auth/callback') { response.writeHead(404); response.end('Not Found'); return; }
        if (transaction.claimed || transaction.controller.signal.aborted) {
          response.writeHead(409); response.end('Authentication is already completing.'); return;
        }
        transaction.claimed = true;
        transaction.response = response;
        const host = request.headers.host;
        if (request.method !== 'GET' || !['localhost:1455', '127.0.0.1:1455'].includes(host)) {
          cancel(transaction, failure('AUTH_CALLBACK')); return;
        }
        const states = url.searchParams.getAll('state');
        if (states.length !== 1 || !secureEqual(states[0], state)) {
          cancel(transaction, failure('AUTH_STATE')); return;
        }
        if (url.searchParams.has('error')) { cancel(transaction, failure('AUTH_CALLBACK')); return; }
        const codes = url.searchParams.getAll('code');
        if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) {
          cancel(transaction, failure('AUTH_CALLBACK')); return;
        }
        transaction.code.resolve(codes[0]);
      });
      transaction.server = server;
      server.on('error', () => cancel(transaction, failure('AUTH_PORT')));
      await abortable(new Promise((resolve) => server.listen(1455, '127.0.0.1', resolve)), transaction.controller.signal);
      check(transaction);
      const url = new URL(`${CHATGPT_ISSUER}/oauth/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT,
        scope: 'openid profile email offline_access', code_challenge: pkce.challenge,
        code_challenge_method: 'S256', id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true', state, originator: 'codex_cli_rs'
      }).toString();
      await openBrowser(transaction, url.toString());
      const code = await abortable(transaction.code.promise, transaction.controller.signal);
      check(transaction);
      const tokens = await requestTokens(account, {
        grant_type: 'authorization_code', code, client_id: CHATGPT_CLIENT_ID,
        redirect_uri: CHATGPT_REDIRECT, code_verifier: pkce.verifier
      }, transaction);
      check(transaction);
      const entry = entryFromTokens(account, tokens, null, now());
      await persist(transaction, entry);
      return entry;
    }

    async function claudeLogin(transaction) {
      const pkce = claudeOAuth.generatePkce();
      transaction.state = crypto.randomBytes(24).toString('base64url');
      const url = claudeOAuth.buildAuthorizeUrl(pkce.challenge, transaction.state);
      await openBrowser(transaction, url);
      transaction.ready = true;
      transaction.started.resolve({ url });
      const parsed = await abortable(transaction.code.promise, transaction.controller.signal);
      check(transaction);
      const tokens = await requestTokens(account, {
        grant_type: 'authorization_code', code: parsed.code, state: parsed.state,
        client_id: claudeOAuth.CLIENT_ID, redirect_uri: claudeOAuth.REDIRECT_URI, code_verifier: pkce.verifier
      }, transaction);
      check(transaction);
      const entry = entryFromTokens(account, tokens, null, now());
      await persist(transaction, entry);
      return entry;
    }

    function credentials(entry) {
      return account === 'chatgpt'
        ? { accessToken: entry.accessToken, accountId: entry.accountId }
        : { token: entry.accessToken, source: 'oauth', expiresAt: entry.expiresAt };
    }

    async function getAuth() {
      if (pending || loggingOut) throw failure('AUTH_PENDING');
      if (refreshing) return refreshing.done;
      const generation = epoch;
      const previous = await read();
      if (generation !== epoch || pending || loggingOut) throw failure('AUTH_CANCELLED');
      if (refreshing) return refreshing.done;
      if (!previous.entry) throw failure('LLM_AUTH_REQUIRED');
      if (previous.entry.expiresAt - now() > REFRESH_MARGIN_MS) return credentials(previous.entry);
      const transaction = { epoch, previous, controller: new AbortController(), committed: false };
      refreshing = transaction;
      transaction.done = (async () => {
        try {
          if (!previous.entry.refreshToken) throw failure('LLM_AUTH_REQUIRED');
          const tokens = await requestTokens(account, {
            grant_type: 'refresh_token',
            client_id: account === 'chatgpt' ? CHATGPT_CLIENT_ID : claudeOAuth.CLIENT_ID,
            refresh_token: previous.entry.refreshToken
          }, transaction);
          check(transaction);
          const entry = entryFromTokens(account, tokens, previous.entry, now());
          await persist(transaction, entry);
          return credentials(entry);
        } catch (error) {
          const safe = safeFailure(error);
          if (safe.code === 'LLM_AUTH_REQUIRED' && !transaction.controller.signal.aborted && transaction.epoch === epoch) {
            await vault(async () => { check(transaction); await nativeCall('vault.delete', { account }); });
          }
          throw safe;
        } finally {
          if (refreshing === transaction) refreshing = null;
          await notifyStored();
        }
      })();
      transaction.done.catch(() => {});
      return transaction.done;
    }

    async function cancelLogin() {
      const transaction = pending;
      cancel(transaction);
      if (transaction) await transaction.done.catch((error) => {
        if (error.code === 'AUTH_STORAGE') throw error;
      });
      return publicStatus((await read()).entry);
    }

    function logout() {
      if (loggingOut) return loggingOut;
      epoch += 1;
      const login = pending, refresh = refreshing;
      cancel(login); cancel(refresh);
      const work = (async () => {
        await Promise.allSettled([login?.done, refresh?.done]);
        await vault(() => nativeCall('vault.delete', { account }));
        return notify(null);
      })();
      loggingOut = work;
      work.finally(() => { if (loggingOut === work) loggingOut = null; }).catch(() => {});
      return work;
    }

    const service = {
      init({ onStatus } = {}) { if (typeof onStatus === 'function') sink = onStatus; },
      async status() { return notify((await read()).entry); },
      getAuth, logout, cancelLogin, loginCancel: cancelLogin
    };
    if (account === 'chatgpt') {
      service.login = async () => startLogin(chatgptLogin).done;
    } else {
      service.loginStart = async () => startLogin(claudeLogin).started.promise;
      service.loginComplete = async (pasted) => {
        const transaction = pending;
        if (!transaction) throw failure('AUTH_STATE');
        if (now() >= transaction.deadline) {
          cancel(transaction, failure('AUTH_TIMEOUT'));
          return transaction.done;
        }
        if (!transaction.ready || transaction.claimed) throw failure('AUTH_PENDING');
        let parsed;
        try { parsed = claudeOAuth.parsePastedCode(pasted); } catch { throw failure('AUTH_CODE'); }
        if (!parsed.state) throw failure('AUTH_CODE');
        if (!secureEqual(parsed.state, transaction.state)) {
          cancel(transaction, failure('AUTH_STATE'));
          return transaction.done;
        }
        transaction.claimed = true;
        transaction.code.resolve(parsed);
        return transaction.done;
      };
    }
    return service;
  }

  return { chatgpt: createProvider('chatgpt'), claude: createProvider('claude') };
}

module.exports = { createAuthServices };
