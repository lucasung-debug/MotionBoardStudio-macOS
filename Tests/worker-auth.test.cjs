'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { once } = require('node:events');

test('native Keychain diagnostics survive the worker and auth boundary without exposing native text', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motionboard-worker-auth-'));
  const repo = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [path.join(repo, 'Runtime/worker.cjs')], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    await closed; clearTimeout(timer);
    await fs.rm(root, { recursive: true, force: true });
  });
  const pending = new Map(), nativeCalls = [], publicEvents = [];
  let next = 0, diagnostics = { operation: 'delete', status: -34018 };
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.kind === 'ready') readyResolve();
    else if (message.kind === 'fatal') readyReject(new Error('Worker failed'));
    else if (message.kind === 'result') pending.get(message.id)?.(message.result);
    else if (message.kind === 'event') publicEvents.push(message);
    else if (message.kind === 'native') {
      nativeCalls.push(message.method);
      if (message.method === 'vault.delete') send({ kind: 'nativeResult', id: message.id,
        error: 'synthetic-private-native-message', storageError: diagnostics });
      else if (message.method === 'vault.read') send({ kind: 'nativeResult', id: message.id, result: { value: null } });
      else send({ kind: 'nativeResult', id: message.id, error: 'Unexpected native operation' });
    }
  });
  send({ kind: 'init', sourceRoot: path.join(repo, 'upstream/MotionBoardStudio-0.3.2'), userData: root });
  await ready;
  const request = method => new Promise(resolve => {
    const id = String(++next); pending.set(id, resolve);
    send({ kind: 'request', id, method });
  });
  const failed = await request('studio:authLogout');
  assert.equal(failed.ok, false); assert.equal(failed.code, 'AUTH_STORAGE');
  assert.match(failed.error, /macOS -34018/);
  for (const invalid of [
    { operation: 'read', status: -34018 },
    { operation: 'delete', status: 'synthetic-private-native-message' },
    { operation: 'delete', status: -2147483649 }
  ]) {
    diagnostics = invalid;
    const result = await request('studio:authLogout');
    assert.equal(result.code, 'AUTH_STORAGE');
    assert.doesNotMatch(result.error, /macOS|synthetic-private/);
  }
  assert.ok(nativeCalls.every(method => method === 'vault.delete'));
  assert.equal(publicEvents.some(event => event.payload?.loggedIn === false), false);
  assert.doesNotMatch(JSON.stringify([failed, publicEvents]), /synthetic-private/);
});
