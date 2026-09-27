'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAuthServices } = require('../Runtime/auth.cjs');

const sourceRoot = path.resolve(__dirname, '../upstream/MotionBoardStudio-0.3.2');
const NOW = 1_800_000_000_000;
const ACCESS = 'synthetic-access-token-for-tests';
const REFRESH = 'synthetic-refresh-token-for-tests';
const ID_TOKEN = `header.${Buffer.from(JSON.stringify({
  email: 'example@example.invalid', exp: NOW / 1000 + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'test-account', chatgpt_plan_type: 'test-plan' }
})).toString('base64url')}.signature`;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function tracked(promise) { promise.catch(() => {}); return promise; }
function response(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function tokens(extra = {}) { return { access_token: ACCESS, refresh_token: REFRESH, id_token: ID_TOKEN, expires_in: 3600, ...extra }; }
function stored(account, extra = {}) {
  return {
    accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3600_000,
    ...(account === 'chatgpt'
      ? { idToken: ID_TOKEN, email: 'example@example.invalid', accountId: 'test-account', plan: 'test-plan' }
      : { subscriptionType: 'test-subscription' }),
    ...extra
  };
}

function harness(t, options = {}) {
  const values = new Map(Object.entries(options.values || {}));
  const calls = [], events = [], requests = [], browsers = [], browserWaiters = [];
  let clock = NOW;
  const defaultNative = async (method, payload) => {
    if (method === 'vault.read') return { value: values.get(payload.account) ?? null };
    if (method === 'vault.write') { values.set(payload.account, payload.value); return {}; }
    if (method === 'vault.delete') { values.delete(payload.account); return {}; }
    if (method === 'shell.openExternal') return {};
    throw new Error('Unexpected native method');
  };
  const services = createAuthServices({
    sourceRoot, now: () => clock,
    emit: (channel, payload) => events.push({ channel, payload }),
    nativeCall: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'shell.openExternal') {
        const opened = new URL(payload.url);
        if (browserWaiters.length) browserWaiters.shift().resolve(opened);
        else browsers.push(opened);
      }
      return options.nativeHook
        ? options.nativeHook(method, payload, () => defaultNative(method, payload))
        : defaultNative(method, payload);
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (!options.fetch) throw new Error('Unexpected provider request');
      return options.fetch(url, init);
    }
  });
  t.after(async () => { await Promise.allSettled([services.chatgpt.logout(), services.claude.logout()]); });
  return {
    ...services, values, calls, events, requests,
    advance(ms) { clock += ms; },
    browser() {
      if (browsers.length) return Promise.resolve(browsers.shift());
      const waiter = deferred(); browserWaiters.push(waiter); return waiter.promise;
    }
  };
}

function callback(parameters, { method = 'GET', callbackPath = '/auth/callback', host = '127.0.0.1:1455' } = {}) {
  return tracked(new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: 1455, method, agent: false,
      path: `${callbackPath}?${new URLSearchParams(parameters)}`, headers: { host }
    }, (result) => {
      const parts = [];
      result.on('data', (part) => parts.push(part));
      result.on('error', reject);
      result.on('end', () => resolve({ status: result.statusCode, headers: result.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  }));
}

async function beginChatGPT(h) {
  const result = tracked(h.chatgpt.login());
  const url = await h.browser();
  return { result, url, state: url.searchParams.get('state') };
}

async function assertPortReleased() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(1455, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

function assertPublic(value) {
  const serialized = JSON.stringify(value instanceof Error ? { message: value.message, code: value.code } : value);
  for (const secret of [ACCESS, REFRESH, ID_TOKEN]) assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('accessToken'));
  assert.ok(!serialized.includes('refreshToken'));
  assert.ok(!serialized.includes('idToken'));
}

test('status reads only app vaults, emits public metadata, and does not refresh', async (t) => {
  const h = harness(t, { values: {
    chatgpt: JSON.stringify(stored('chatgpt', { expiresAt: NOW - 1000 })),
    claude: JSON.stringify(stored('claude'))
  } });
  const chatgpt = await h.chatgpt.status(), claude = await h.claude.status();
  assert.equal(chatgpt.loggedIn, true);
  assert.equal(chatgpt.expired, true);
  assert.equal(chatgpt.accountId, 'test-account');
  assert.equal(claude.source, 'oauth');
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.calls.map(({ method, payload }) => [method, payload.account]), [['vault.read', 'chatgpt'], ['vault.read', 'claude']]);
  assertPublic([chatgpt, claude, h.events]);
});

test('inherited environment tokens cannot authenticate the app', () => {
  const program = `
    const {createAuthServices} = require('./Runtime/auth.cjs');
    const services = createAuthServices({
      sourceRoot: ${JSON.stringify(sourceRoot)},
      nativeCall: async (method) => { if (method !== 'vault.read') throw Error('Unexpected native operation'); return {value:null}; },
      fetchImpl: async () => { throw Error('Unexpected network request'); }
    });
    Promise.all([services.chatgpt.status(), services.claude.status()]).then(statuses => {
      if (statuses.some(status => status.loggedIn)) process.exitCode = 1;
      else process.stdout.write('isolated');
    });
  `;
  const result = spawnSync(process.execPath, ['-e', program], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-env-token', ANTHROPIC_AUTH_TOKEN: 'synthetic-other-token', OPENAI_API_KEY: 'synthetic-api-key' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'isolated');
});

test('ChatGPT callback succeeds only after token exchange and vault persistence', async (t) => {
  const fetched = deferred(), releaseFetch = deferred(), writing = deferred(), releaseWrite = deferred();
  t.after(() => { releaseFetch.resolve(); releaseWrite.resolve(); });
  const h = harness(t, {
    fetch: async () => { fetched.resolve(); await releaseFetch.promise; return response(tokens()); },
    nativeHook: async (method, payload, next) => {
      if (method === 'vault.write') { writing.resolve(); await releaseWrite.promise; }
      return next();
    }
  });
  const login = await beginChatGPT(h);
  assert.equal(login.url.origin, 'https://auth.openai.com');
  assert.equal(login.url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  let callbackFinished = false;
  const result = callback({ code: 'synthetic-code', state: login.state }).then((value) => { callbackFinished = true; return value; });
  await fetched.promise;
  assert.equal(callbackFinished, false);
  releaseFetch.resolve();
  await writing.promise;
  assert.equal(callbackFinished, false);
  releaseWrite.resolve();
  const browser = await result, status = await login.result;
  assert.equal(browser.status, 200);
  assert.equal(browser.headers['cache-control'], 'no-store');
  assert.equal(status.loggedIn, true);
  assert.equal(status.pending, false);
  assertPublic([status, h.events, browser.body]);
  const body = new URLSearchParams(h.requests[0].init.body);
  assert.equal(h.requests[0].init.redirect, 'error');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'synthetic-code');
  assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'), login.url.searchParams.get('code_challenge'));
  assert.deepEqual(await h.chatgpt.getAuth(), { accessToken: ACCESS, accountId: 'test-account' });
  assert.equal(h.requests.length, 1);
  await assertPortReleased();
});

test('ChatGPT rejects a mismatched state without echoing it and closes the callback server', async (t) => {
  const h = harness(t);
  const login = await beginChatGPT(h);
  const browser = await callback({ code: 'private-callback-code', state: 'private-wrong-state' });
  await assert.rejects(login.result, { code: 'AUTH_STATE' });
  assert.equal(browser.status, 400);
  assert.ok(!browser.body.includes('private-'));
  assert.equal(h.requests.length, 0);
  assert.equal((await h.chatgpt.status()).pending, false);
  await assertPortReleased();
});

test('ChatGPT rejects duplicate state parameters and provider errors without exposing descriptions', async (t) => {
  for (const mode of ['duplicate', 'provider', 'missing-code']) {
    const h = harness(t);
    const login = await beginChatGPT(h);
    const fields = [['state', login.state]];
    if (mode === 'duplicate') fields.push(['state', login.state], ['code', 'synthetic-code']);
    if (mode === 'provider') fields.push(['error', 'access_denied'], ['error_description', ACCESS]);
    const browser = await callback(fields);
    await assert.rejects(login.result, { code: mode === 'duplicate' ? 'AUTH_STATE' : 'AUTH_CALLBACK' });
    assert.equal(browser.status, 400);
    assertPublic([browser.body, h.events]);
    assert.equal(h.requests.length, 0);
    await assertPortReleased();
  }
});

test('ChatGPT token rejection returns a failure page and no raw provider error', async (t) => {
  const h = harness(t, { fetch: async () => response({ error: ACCESS, error_description: REFRESH }, 401) });
  const login = await beginChatGPT(h);
  const browser = await callback({ state: login.state, code: 'synthetic-code' });
  await assert.rejects(login.result, (error) => { assertPublic(error); return error.code === 'LLM_AUTH_REQUIRED'; });
  assert.equal(browser.status, 400);
  assert.equal(h.values.has('chatgpt'), false);
  assertPublic([browser.body, h.events]);
  await assertPortReleased();
});

test('a failed vault write restores the previous ChatGPT entry and never reports success', async (t) => {
  const previous = JSON.stringify(stored('chatgpt', { accessToken: 'synthetic-previous-access' }));
  let failWrite = true;
  const h = harness(t, {
    values: { chatgpt: previous }, fetch: async () => response(tokens()),
    nativeHook: async (method, payload, next) => {
      const value = await next();
      if (method === 'vault.write' && failWrite) { failWrite = false; throw new Error(ACCESS); }
      return value;
    }
  });
  const login = await beginChatGPT(h);
  const browser = await callback({ state: login.state, code: 'synthetic-code' });
  await assert.rejects(login.result, { code: 'AUTH_STORAGE' });
  assert.equal(browser.status, 400);
  assert.equal(h.values.get('chatgpt'), previous);
  assertPublic([browser.body, h.events]);
  await assertPortReleased();
});

test('browser launch failure releases ChatGPT server and allows a new login', async (t) => {
  let fail = true;
  const h = harness(t, { nativeHook: async (method, payload, next) => {
    if (method === 'shell.openExternal' && fail) { fail = false; throw new Error(ACCESS); }
    return next();
  } });
  const first = tracked(h.chatgpt.login());
  await h.browser();
  await assert.rejects(first, { code: 'AUTH_BROWSER' });
  await assertPortReleased();
  const second = await beginChatGPT(h);
  await h.chatgpt.cancelLogin();
  await assert.rejects(second.result, { code: 'AUTH_CANCELLED' });
  assert.equal(h.requests.length, 0);
  await assertPortReleased();
});

test('ChatGPT blocks concurrent logins and cancels a pending callback', async (t) => {
  const h = harness(t);
  const login = await beginChatGPT(h);
  await assert.rejects(h.chatgpt.login(), { code: 'AUTH_PENDING' });
  await assert.rejects(h.chatgpt.getAuth(), { code: 'AUTH_PENDING' });
  assert.equal((await h.chatgpt.status()).pending, true);
  await h.chatgpt.loginCancel();
  await assert.rejects(login.result, { code: 'AUTH_CANCELLED' });
  assert.equal((await h.chatgpt.status()).pending, false);
  await assertPortReleased();
});

test('ChatGPT callback port conflicts do not open the browser or leave a pending login', async (t) => {
  const occupied = http.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(1455, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const h = harness(t);
  await assert.rejects(h.chatgpt.login(), { code: 'AUTH_PORT' });
  assert.equal((await h.chatgpt.status()).pending, false);
  assert.equal(h.calls.some((call) => call.method === 'shell.openExternal'), false);
  assert.equal(h.requests.length, 0);
});

test('ChatGPT callback expires after five minutes and releases the server', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const login = await beginChatGPT(h);
  t.mock.timers.tick(5 * 60_000);
  await assert.rejects(login.result, { code: 'AUTH_TIMEOUT' });
  assert.equal((await h.chatgpt.status()).pending, false);
  assert.equal(h.requests.length, 0);
  await assertPortReleased();
});

test('provider exchange timeout aborts the request and fails the browser callback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred();
  const h = harness(t, { fetch: async () => { entered.resolve(); return new Promise(() => {}); } });
  const login = await beginChatGPT(h);
  const browser = callback({ state: login.state, code: 'synthetic-code' });
  await entered.promise;
  t.mock.timers.tick(30_000);
  await assert.rejects(login.result, { code: 'AUTH_TIMEOUT' });
  assert.equal((await browser).status, 400);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.values.has('chatgpt'), false);
  await assertPortReleased();
});

test('ChatGPT cancellation ignores a late token response and releases its port', async (t) => {
  const entered = deferred(), released = deferred();
  const h = harness(t, { fetch: async () => { entered.resolve(); await released.promise; return response(tokens()); } });
  const login = await beginChatGPT(h);
  const browserPromise = callback({ state: login.state, code: 'synthetic-code' });
  await entered.promise;
  await h.chatgpt.cancelLogin();
  await assert.rejects(login.result, { code: 'AUTH_CANCELLED' });
  assert.equal((await browserPromise).status, 400);
  released.resolve();
  await new Promise(setImmediate);
  assert.equal(h.values.has('chatgpt'), false);
  assert.equal(h.calls.filter((call) => call.method === 'vault.write').length, 0);
  assert.equal(h.requests[0].init.signal.aborted, true);
  await assertPortReleased();
});

test('cancellation during a native write restores its predecessor before unlocking login', async (t) => {
  const entered = deferred(), released = deferred();
  t.after(() => released.resolve());
  const previous = JSON.stringify(stored('chatgpt', { accessToken: 'synthetic-previous-access' }));
  let delay = true;
  const h = harness(t, {
    values: { chatgpt: previous }, fetch: async () => response(tokens()),
    nativeHook: async (method, payload, next) => {
      const result = await next();
      if (method === 'vault.write' && delay) { delay = false; entered.resolve(); await released.promise; }
      return result;
    }
  });
  const login = await beginChatGPT(h);
  const browser = callback({ state: login.state, code: 'synthetic-code' });
  await entered.promise;
  const cancelled = h.chatgpt.cancelLogin();
  await assert.rejects(h.chatgpt.login(), { code: 'AUTH_PENDING' });
  released.resolve();
  await cancelled;
  await assert.rejects(login.result, { code: 'AUTH_CANCELLED' });
  assert.equal((await browser).status, 400);
  assert.equal(h.values.get('chatgpt'), previous);
  await assertPortReleased();
});

for (const account of ['chatgpt', 'claude']) {
  test(`${account} coalesces refreshes and preserves metadata when refresh omits it`, async (t) => {
    const entered = deferred(), released = deferred();
    const previous = stored(account, { expiresAt: NOW + 30_000 });
    const h = harness(t, {
      values: { [account]: JSON.stringify(previous) },
      fetch: async () => { entered.resolve(); await released.promise; return response({ access_token: 'synthetic-refreshed-access', expires_in: 7200 }); }
    });
    const first = h[account].getAuth(), second = h[account].getAuth();
    await entered.promise;
    assert.equal((await h[account].status()).loggedIn, true);
    assert.equal(h.requests.length, 1);
    released.resolve();
    assert.deepEqual(await first, await second);
    const saved = JSON.parse(h.values.get(account));
    assert.equal(saved.accessToken, 'synthetic-refreshed-access');
    assert.equal(saved.refreshToken, REFRESH);
    assert.equal(saved.expiresAt, NOW + 7200_000);
    if (account === 'chatgpt') { assert.equal(saved.accountId, 'test-account'); assert.equal(saved.email, previous.email); }
    else assert.equal(saved.subscriptionType, previous.subscriptionType);
    assert.equal(h.calls.filter((call) => call.method === 'vault.write').length, 1);
    assertPublic(h.events);
  });

  test(`${account} clears rejected refresh credentials but retains them after temporary network failure`, async (t) => {
    for (const status of [401, 503]) {
      const previous = JSON.stringify(stored(account, { expiresAt: NOW - 1000 }));
      const h = harness(t, { values: { [account]: previous }, fetch: async () => response({ private_detail: ACCESS }, status) });
      await assert.rejects(h[account].getAuth(), (error) => {
        assertPublic(error);
        return error.code === (status === 401 ? 'LLM_AUTH_REQUIRED' : 'AUTH_NETWORK');
      });
      assert.equal(h.values.has(account), status === 503);
      assert.equal((await h[account].status()).loggedIn, status === 503);
      assertPublic(h.events);
    }
  });

  test(`${account} logout aborts refresh and prevents a late response restoring credentials`, async (t) => {
    const entered = deferred(), released = deferred();
    const h = harness(t, {
      values: { [account]: JSON.stringify(stored(account, { expiresAt: NOW - 1000 })) },
      fetch: async () => { entered.resolve(); await released.promise; return response(tokens()); }
    });
    const refresh = tracked(h[account].getAuth());
    await entered.promise;
    assert.equal((await h[account].logout()).loggedIn, false);
    await assert.rejects(refresh, { code: 'AUTH_CANCELLED' });
    released.resolve();
    await new Promise(setImmediate);
    assert.equal(h.values.has(account), false);
    await assert.rejects(h[account].getAuth(), { code: 'LLM_AUTH_REQUIRED' });
    assert.equal(h.requests.length, 1);
  });

  test(`${account} never returns refreshed tokens when secure persistence fails`, async (t) => {
    const previous = JSON.stringify(stored(account, { expiresAt: NOW - 1000 }));
    let fail = true;
    const h = harness(t, {
      values: { [account]: previous }, fetch: async () => response({ access_token: 'synthetic-refreshed-access', expires_in: 3600 }),
      nativeHook: async (method, payload, next) => {
        if (method === 'vault.write' && fail) { fail = false; throw new Error(ACCESS); }
        return next();
      }
    });
    await assert.rejects(h[account].getAuth(), (error) => { assertPublic(error); return error.code === 'AUTH_STORAGE'; });
    assert.equal(h.values.get(account), previous);
    assertPublic(h.events);
  });
}

test('Claude uses pasted code#state, PKCE, and the app vault before reporting success', async (t) => {
  const h = harness(t, { fetch: async () => response(tokens({ subscription_type: 'test-subscription' })) });
  const started = await h.claude.loginStart(), url = new URL(started.url);
  assert.equal(url.origin, 'https://claude.ai');
  assert.equal((await h.claude.status()).pending, true);
  await assert.rejects(h.claude.loginStart(), { code: 'AUTH_PENDING' });
  const status = await h.claude.loginComplete(`synthetic-code#${url.searchParams.get('state')}`);
  assert.equal(status.loggedIn, true);
  assert.equal(status.pending, false);
  assert.equal(status.source, 'oauth');
  assertPublic([status, h.events]);
  const body = JSON.parse(h.requests[0].init.body);
  assert.equal(h.requests[0].url, 'https://console.anthropic.com/v1/oauth/token');
  assert.equal(body.state, url.searchParams.get('state'));
  assert.equal(crypto.createHash('sha256').update(body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.deepEqual(await h.claude.getAuth(), { token: ACCESS, source: 'oauth', expiresAt: NOW + 3600_000 });
});

test('Claude rejects incomplete pasted input, invalidates mismatched state, and permits a new login', async (t) => {
  const h = harness(t);
  await h.claude.loginStart();
  await assert.rejects(h.claude.loginComplete('synthetic-code'), { code: 'AUTH_CODE' });
  assert.equal((await h.claude.status()).pending, true);
  await assert.rejects(h.claude.loginComplete('synthetic-code#wrong-state'), { code: 'AUTH_STATE' });
  assert.equal((await h.claude.status()).pending, false);
  await h.claude.loginStart();
  await h.claude.cancelLogin();
  assert.equal(h.requests.length, 0);
});

test('Claude expires pasted-code sessions after the original ten-minute lifetime', async (t) => {
  const h = harness(t);
  const started = await h.claude.loginStart(), state = new URL(started.url).searchParams.get('state');
  h.advance(10 * 60_000);
  await assert.rejects(h.claude.loginComplete(`synthetic-code#${state}`), { code: 'AUTH_TIMEOUT' });
  assert.equal((await h.claude.status()).pending, false);
  assert.equal(h.requests.length, 0);
});

test('Claude rejects concurrent completions and discards a cancelled token exchange', async (t) => {
  const entered = deferred(), released = deferred();
  const h = harness(t, { fetch: async () => { entered.resolve(); await released.promise; return response(tokens()); } });
  const started = await h.claude.loginStart(), state = new URL(started.url).searchParams.get('state');
  const completed = tracked(h.claude.loginComplete(`synthetic-code#${state}`));
  await entered.promise;
  await assert.rejects(h.claude.loginComplete(`synthetic-code#${state}`), { code: 'AUTH_PENDING' });
  await h.claude.cancelLogin();
  await assert.rejects(completed, { code: 'AUTH_CANCELLED' });
  released.resolve();
  await new Promise(setImmediate);
  assert.equal(h.values.has('claude'), false);
});

test('Claude browser failures are sanitized and do not leave pending sessions', async (t) => {
  const h = harness(t, { nativeHook: async (method, payload, next) => {
    if (method === 'shell.openExternal') throw new Error(ACCESS);
    return next();
  } });
  await assert.rejects(h.claude.loginStart(), { code: 'AUTH_BROWSER' });
  await h.claude.cancelLogin();
  assert.equal((await h.claude.status()).pending, false);
  assertPublic(h.events);
});

test('vault errors do not expose native details or falsely confirm logout', async (t) => {
  const h = harness(t, {
    values: { claude: JSON.stringify(stored('claude')) },
    nativeHook: async (method, payload, next) => {
      if (method === 'vault.delete') throw new Error(REFRESH);
      return next();
    }
  });
  await assert.rejects(h.claude.logout(), (error) => { assertPublic(error); return error.code === 'AUTH_STORAGE'; });
  assert.equal((await h.claude.status()).loggedIn, true);
  assertPublic(h.events);
});

test('invalid stored JSON and expired non-refreshable entries cannot authenticate', async (t) => {
  const h = harness(t, { values: {
    chatgpt: '{invalid JSON',
    claude: JSON.stringify(stored('claude', { expiresAt: NOW - 1000, refreshToken: '' }))
  } });
  assert.equal((await h.chatgpt.status()).loggedIn, false);
  assert.equal((await h.claude.status()).loggedIn, false);
  await assert.rejects(h.chatgpt.getAuth(), { code: 'LLM_AUTH_REQUIRED' });
  await assert.rejects(h.claude.getAuth(), { code: 'LLM_AUTH_REQUIRED' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.values.has('claude'), false);
});
