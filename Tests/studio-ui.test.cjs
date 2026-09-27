'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = require('../StudioUI/app.js');

function fixtureEntry() {
  return { id: 'fixture-entry', title: 'Offline scenes', yaml: 'fixture: true', imageUrl: 'studio-image://fixture/board',
    input: { aspectRatio: '16:9' }, imageVideo: { revision: 1, provider: 'grok', resolution: '720p',
      shots: Array.from({ length: 16 }, (_, index) => ({ id: `cell-${index}`, index, title: `Scene ${index + 1}`,
        prompt: 'The subject turns toward the camera.', duration: 5, status: 'draft', imageUrl: `studio-image://fixture/${index}` })) } };
}

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.dataset = {}; this.style = {}; this.events = {}; this.children = []; this._text = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  pause() {} load() {} focus() {} select() {} remove() {}
}

function harness(overrides = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const calls = [];
  const entry = fixtureEntry();
  const api = {
    history: async () => ({ ok: true, entries: [] }),
    auth: { status: async () => ({ ok: true, status: { loggedIn: true } }) },
    imageVideo: {
      savePlan: async payload => { calls.push(['save', payload]); return { ok: true, entry: { ...entry, imageVideo: { ...entry.imageVideo, ...payload,
        shots: payload.shots.map(shot => ({ ...entry.imageVideo.shots.find(item => item.id === shot.id), ...shot })), revision: 2 } } }; },
      generate: async payload => { calls.push(['generate', payload]); return { ok: true, entry }; },
      refresh: async payload => { calls.push(['refresh', payload]); return { ok: true, entry }; },
      export: async payload => { calls.push(['export', payload]); return { ok: true, entry }; },
      importClip: async payload => { calls.push(['import', payload]); return { ok: true, entry }; },
      prepare: async payload => { calls.push(['prepare', payload]); return { ok: true, entry }; },
      recover: async payload => { calls.push(['recover', payload]); return { ok: true, entry }; },
      ...overrides.imageVideo
    },
    ...overrides.api
  };
  const window = { studio: api, confirm: () => true, __studioFlow: { cancelled: false } };
  const context = vm.createContext({ window, document: { getElementById: get, querySelectorAll: () => [], createElement: () => new Element() },
    module: { exports: {} }, console, URL, fixture: entry, providers: [{ id: 'grok', label: 'Grok', configured: true, durations: [5, 10], resolutions: ['720p'] }],
    localStorage: { setItem() {}, getItem: () => null } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../StudioUI/app.js'), 'utf8'), context);
  vm.runInContext('imageProviders = providers; current = fixture; imageDraft = copyImagePlan(fixture); selectedShotId = imageDraft.shots[0].id; bindImageVideoEvents();', context);
  return { elements, get, calls, entry, api, window, context,
    evaluate: source => vm.runInContext(source, context),
    click: id => get(id).events.click[0]() };
}

test('all sixteen cells remain visible, with twelve default shots and preserved explicit selections', () => {
  const entry = fixtureEntry();
  const plan = ui.copyImagePlan(entry);
  assert.equal(plan.shots.length, 16);
  assert.equal(plan.shots.filter(shot => shot.enabled).length, 12);
  assert.ok(plan.shots.slice(12).every(shot => !shot.enabled));
  entry.imageVideo.shots[0].enabled = false;
  entry.imageVideo.shots[15].enabled = true;
  const restored = ui.copyImagePlan(entry);
  assert.equal(restored.shots[0].enabled, false);
  assert.equal(restored.shots[15].enabled, true);
  restored.shots[0].prompt = 'Edited';
  assert.notEqual(entry.imageVideo.shots[0].prompt, 'Edited');
});

test('paid generation includes only explicitly selected draft and failed scenes', () => {
  const statuses = ['draft', 'failed', 'pending', 'submitting', 'uncertain', 'succeeded'];
  const shots = statuses.map((status, id) => ({ id, status, enabled: true }));
  shots.push({ id: 'excluded', enabled: false, status: 'draft' });
  assert.deepEqual(ui.imageGenerationShots({ shots }).map(shot => shot.id), [0, 1]);
});

test('save payload carries editing fields and revision without media or job internals', () => {
  const plan = ui.copyImagePlan(fixtureEntry());
  plan.shots[0].providerJobId = 'private-job-id';
  plan.shots[0].prompt = '  Move the subject.  ';
  const payload = ui.imagePlanPayload(plan);
  assert.equal(payload.revision, 1);
  assert.equal(payload.resolution, '720p');
  assert.equal(payload.shots[0].prompt, 'Move the subject.');
  assert.deepEqual(Object.keys(payload.shots[0]).sort(), ['duration', 'enabled', 'id', 'prompt', 'title']);
});

test('stale clips in pending scenes do not count as ready for assembly', () => {
  const selection = ui.imageSelection({ shots: [
    { enabled: true, duration: 5, status: 'succeeded', videoUrl: 'studio-video://one' },
    { enabled: true, duration: 10, status: 'pending', videoUrl: 'studio-video://old' },
    { enabled: false, duration: 5, status: 'succeeded', videoUrl: 'studio-video://excluded' }
  ] });
  assert.equal(selection.shots.length, 2); assert.equal(selection.seconds, 15); assert.equal(selection.ready, 1);
});

test('generation saves edits first and sends only eligible scene IDs from the saved plan', async () => {
  const app = harness();
  app.entry.imageVideo.shots[1].status = 'pending'; app.entry.imageVideo.shots[2].status = 'uncertain';
  app.evaluate("imageDraftDirty = true; imageDraft.shots[0].prompt = 'New movement'; imageDraft.shots[1].status = 'pending'; imageDraft.shots[2].status = 'uncertain';");
  await app.click('generateScenesBtn');
  assert.deepEqual(app.calls.map(call => call[0]), ['save', 'generate']);
  assert.equal(app.calls[0][1].shots[0].prompt, 'New movement');
  assert.ok(!app.calls[1][1].shotIds.includes('cell-12'));
  assert.ok(!app.calls[1][1].shotIds.includes('cell-1'));
  assert.ok(!app.calls[1][1].shotIds.includes('cell-2'));
  assert.equal(app.evaluate('imageDraftDirty'), false);
});

test('failed revision save preserves edits and prevents any generation or refresh', async () => {
  const app = harness({ imageVideo: { savePlan: async () => ({ ok: false, code: 'CONFLICT', error: 'The plan changed.' }) } });
  app.evaluate("imageDraftDirty = true; imageDraft.shots[0].prompt = 'Unsaved movement';");
  await app.click('generateScenesBtn');
  await app.click('refreshScenesBtn');
  assert.deepEqual(app.calls, []);
  assert.equal(app.evaluate('imageDraftDirty'), true);
  assert.equal(app.evaluate('imageDraft.shots[0].prompt'), 'Unsaved movement');
  assert.match(app.get('statusText').textContent, /입력한 내용은 유지/);
});

test('cancel during save prevents a following paid request', async () => {
  const app = harness();
  app.api.imageVideo.savePlan = async () => {
    app.window.__studioFlow.cancelled = true;
    return { ok: true, entry: app.entry };
  };
  app.evaluate('imageDraftDirty = true;');
  await app.click('generateScenesBtn');
  assert.deepEqual(app.calls, []);
});

test('image creation CTA prepares spec and board without calling paid video generation', async () => {
  const app = harness();
  app.api.spec = async input => { app.calls.push(['spec', input]); return { ok: true, entry: { ...app.entry, imageUrl: null, imageVideo: undefined } }; };
  app.api.board = async payload => { app.calls.push(['board', payload]); return { ok: true, entry: { ...app.entry, imageVideo: undefined } }; };
  app.api.video = async () => { throw new Error('Motion pipeline must not run in image mode.'); };
  app.get('topic').value = 'Offline fixture'; app.get('provider').value = 'chatgpt';
  app.get('withVideo').checked = true; app.get('mode').value = 'spec_only';
  app.evaluate("creationMode = 'image_video'; imageDraftDirty = false;");
  await app.evaluate('run()');
  assert.deepEqual(app.calls.map(call => call[0]), ['spec', 'board', 'prepare']);
  assert.equal(app.calls[0][1].withVideo, false);
  assert.equal(app.calls[0][1].mode, 'full');
});

test('import and local assembly do not request provider authentication', async () => {
  const app = harness();
  app.api.auth.status = async () => { throw new Error('Provider authentication is not needed for local media.'); };
  app.get('imageVideoMusicSource').value = 'none';
  await app.click('importSceneClipBtn');
  await app.click('exportImageVideoBtn');
  assert.deepEqual(app.calls.map(call => call[0]), ['import', 'export']);
  assert.equal(app.calls[1][1].options.musicSource, 'none');
});

test('pending work disables new controls and provider changes but preserves local scene state', () => {
  const app = harness();
  app.evaluate("imageDraft.shots[0].status = 'uncertain'; refreshImageControls();");
  assert.equal(app.get('imageVideoProvider').disabled, true);
  assert.equal(app.get('scenePrompt').disabled, true);
  assert.equal(app.get('importSceneClipBtn').disabled, false);
  assert.equal(app.get('refreshScenesBtn').disabled, false);
  app.evaluate('setBusy(true);');
  assert.equal(app.get('generateScenesBtn').disabled, true);
  assert.equal(app.get('refreshScenesBtn').disabled, true);
  assert.equal(app.get('exportImageVideoBtn').disabled, true);
});

test('uncertain requests are reset only by an explicit recovery action without new generation', async () => {
  const app = harness();
  app.evaluate("imageDraft.shots[0].status = 'uncertain'; renderSceneEditor(); refreshImageControls();");
  assert.equal(app.get('recoverSceneBtn').hidden, false);
  assert.deepEqual(app.calls, []);
  await app.click('recoverSceneBtn');
  assert.deepEqual(app.calls.map(call => call[0]), ['recover']);
  assert.equal(app.calls[0][1].shotId, 'cell-0');
});

test('provider changes retain imported fractional clip duration', () => {
  const app = harness();
  app.evaluate("imageDraft.shots[0].imported = true; imageDraft.shots[0].duration = 4.37; imageDraft.shots[0].status = 'succeeded';");
  app.get('imageVideoProvider').value = 'grok';
  app.get('imageVideoProvider').events.change[0]();
  assert.equal(app.evaluate('imageDraft.shots[0].duration'), 4.37);
  assert.deepEqual(app.calls, []);
});
