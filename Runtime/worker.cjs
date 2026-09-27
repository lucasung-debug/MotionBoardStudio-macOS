'use strict';

// The native application owns this process and its pipes. Stdout is JSONL only.
const readline = require('node:readline');
const pending = new Map();
let nextId = 0;
let engine = null;
let initialization = null;
let verification = null;
let stopping = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const safeError = error => String(error?.message || '작업에 실패했습니다.')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]');

function nativeCall(method, params = {}) {
  if (stopping) return Promise.reject(new Error('앱이 종료 중입니다.'));
  const id = 'n' + (++nextId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'native', id, method, params });
  });
}

async function onMessage(message) {
  if (message.kind === 'nativeResult') {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result);
    return;
  }
  if (message.kind === 'init') {
    if (initialization) throw new Error('The runtime was already initialized.');
    initialization = (async () => {
      const { createEngine } = require('./engine.cjs');
      if (message.verification === true) {
        globalThis.fetch = async () => { throw new Error('External requests are disabled in offline verification.'); };
        verification = await require('./verification.cjs').createVerification({ sourceRoot: message.sourceRoot, userData: message.userData, nativeCall });
      }
      engine = await createEngine({ sourceRoot: message.sourceRoot, userData: message.userData,
        nativeCall, emit: (event, payload) => send({ kind: 'event', event, payload }), ...(verification?.injections || {}) });
      send({ kind: 'ready' });
    })();
    await initialization;
    return;
  }
  if (message.kind === 'request') {
    try {
      await initialization;
      if (!engine) throw new Error('앱 처리 엔진이 준비되지 않았습니다.');
      const result = verification && message.method === 'verification:run'
        ? await verification.run(engine, message.params || {}) : await engine.invoke(message.method, message.params);
      send({ kind: 'result', id: message.id, result });
    } catch (error) { send({ kind: 'result', id: message.id, result: { ok: false, error: safeError(error) } }); }
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (line.length > 64 * 1024 * 1024) { send({kind:'fatal', error:'Runtime message too large.'}); process.exit(1); }
  let message;
  try { message = JSON.parse(line); } catch { send({kind:'fatal',error:'Invalid runtime message.'}); return; }
  onMessage(message).catch(error => send({ kind: 'fatal', error: safeError(error) }));
});
lines.on('close', async () => {
  stopping = true;
  for (const call of pending.values()) call.reject(new Error('앱이 종료되었습니다.'));
  pending.clear();
  try { await engine?.shutdown(); } finally { process.exit(0); }
});
process.on('uncaughtException', error => { send({kind:'fatal', error:safeError(error)}); process.exit(1); });
process.on('unhandledRejection', error => { send({kind:'fatal', error:safeError(error)}); });
