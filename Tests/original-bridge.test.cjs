'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const cancelled = () => ({ok: false, code: 'CANCELLED', error: 'Fixture cancellation'});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this.dataset = {}; this.style = {}; this.children = []; this.listeners = new Map();
    const classes = new Set();
    this.classList = {add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, value) => value ? classes.add(name) : classes.delete(name)};
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  async click() { for (const callback of this.listeners.get('click') || []) await callback(); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  removeAttribute(name) { delete this[name]; }
  focus() {}
  load() {}
}

async function originalPage() {
  const elements = new Map(), calls = [], entries = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  Object.entries({topic: 'Offline cancellation fixture', provider: 'chatgpt', aspect: '16:9', duration: '8',
    mode: 'full', musicSource: 'none', quality: 'draft', engine: 'direct'}).forEach(([id, value]) => { get(id).value = value; });
  get('withVideo').checked = true;
  const controls = {board: async ({id}) => {
    const entry = entries.find(item => item.id === id);
    Object.assign(entry, {hasImage: true, imageUrl: 'studio-image://local/fixture.png'});
    return {ok: true, entry: {...entry}};
  }};
  const backend = async ({method, params}) => {
    calls.push({method, params});
    if (method === 'studio:env') return {ok: true, model: 'fixture', reasoningEffort: 'fixture', claudeModel: 'fixture', claudeEffort: 'fixture', ffmpeg: {version: 'fixture'}};
    if (method === 'studio:authStatus' || method === 'studio:claudeStatus') return {ok: true, status: {loggedIn: true, source: 'offline-fixture'}};
    if (method === 'studio:history') return {ok: true, entries: entries.map(entry => ({...entry}))};
    if (method === 'studio:historyGet') return {ok: true, entry: {...entries.find(entry => entry.id === params.id)}};
    if (method === 'studio:cancel') return {ok: true};
    if (method === 'studio:spec') {
      const entry = {id: String(entries.length + 1), title: 'Fixture ' + (entries.length + 1), input: params,
        provider: params.provider, createdAt: 1, yaml: 'fixture: true', imagePrompt: 'Fixture board', notes: []};
      entries.unshift(entry); return {ok: true, entry: {...entry}};
    }
    if (method === 'studio:board') return controls.board(params);
    if (method === 'studio:video') {
      const entry = entries.find(item => item.id === params.id);
      Object.assign(entry, {hasVideo: true, videoUrl: 'studio-video://local/fixture.mp4'});
      return {ok: true, entry: {...entry}};
    }
    throw new Error('Unexpected fixture request: ' + method);
  };
  const context = vm.createContext({
    document: {getElementById: get, querySelectorAll: () => [], createElement: () => new Element()},
    localStorage: {getItem: () => null, setItem() {}},
    webkit: {messageHandlers: {studio: {postMessage: backend}}},
    navigator: {}, console
  });
  context.window = context;
  // Execute the real original handlers. Only DOM nodes and native/provider
  // responses are fixtures; run(), makeVideo(), and cancellation remain real.
  for (const file of ['Runtime/studio-bridge.js', 'upstream/MotionBoardStudio-0.3.2/renderer/app.js', 'Runtime/macos-ui.js']) {
    vm.runInContext(await fs.readFile(path.join(root, file), 'utf8'), context, {filename: file});
  }
  await new Promise(resolve => setImmediate(resolve));
  return {context, get, calls, controls, entries};
}

test('original full-flow cancellation during the board prevents the following video; a new Run resumes', async () => {
  const page = await originalPage(), started = deferred(), finish = deferred();
  const successfulBoard = page.controls.board;
  page.controls.board = async () => { started.resolve(); await finish.promise; return cancelled(); };
  const run = page.get('runBtn').click();
  await started.promise;
  await page.get('cancelBtn').click();
  finish.resolve(); await run;
  assert.equal(page.calls.filter(call => call.method === 'studio:video').length, 0);
  assert.equal(page.calls.filter(call => call.method === 'studio:cancel').length, 1);
  assert.match(page.get('statusText').textContent, /^생성을 취소했습니다\./);
  assert.equal(page.get('runBtn').disabled, false);
  assert.equal(page.context.__studioFlow.cancelled, true);
  assert.equal(page.context.__studioFlow.active, false);
  // A follow-on IPC alone cannot accidentally clear the cancellation latch.
  assert.equal((await page.context.studio.video({id: '1'})).code, 'CANCELLED');
  assert.equal(page.calls.filter(call => call.method === 'studio:video').length, 0);
  page.controls.board = successfulBoard;
  await page.get('runBtn').click();
  assert.equal(page.calls.filter(call => call.method === 'studio:spec').length, 2);
  assert.equal(page.calls.filter(call => call.method === 'studio:board').length, 2);
  assert.equal(page.calls.filter(call => call.method === 'studio:video').length, 1);
  assert.match(page.get('statusText').textContent, /^완료 — Fixture 2/);
  assert.equal(page.context.__studioFlow.cancelled, false);
  assert.match(page.get('ffmpegHint').textContent, /이 Mac에서 렌더링/);
});

test('a native CANCELLED result also stops the original flow; explicit image and video retries start fresh', async () => {
  const page = await originalPage(), successfulBoard = page.controls.board;
  page.controls.board = async () => cancelled();
  await page.get('runBtn').click();
  assert.equal(page.calls.filter(call => call.method === 'studio:video').length, 0);
  assert.match(page.get('statusText').textContent, /^생성을 취소했습니다\./);
  page.controls.board = successfulBoard;
  await page.get('regenImageBtn').click();
  assert.equal(page.calls.filter(call => call.method === 'studio:board').length, 2);
  assert.equal(page.context.__studioFlow.cancelled, false);
  assert.equal(page.get('statusText').textContent, '보드 이미지를 다시 생성했습니다.');
  await page.context.studio.cancel();
  await page.get('makeVideoBtn').click();
  assert.equal(page.calls.filter(call => call.method === 'studio:video').length, 1);
  assert.match(page.get('statusText').textContent, /^영상 완성 — Fixture 1/);
});
