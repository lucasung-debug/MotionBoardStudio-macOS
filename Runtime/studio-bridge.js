(() => {
  'use strict';
  const subscriptions = new Map();
  const generationMethods = new Set(['studio:spec', 'studio:board', 'studio:video', 'studio:imageVideoPrepare', 'studio:imageVideoGenerate', 'studio:imageVideoRefresh', 'studio:imageVideoRecover', 'studio:imageVideoImportClip', 'studio:imageVideoExport']);
  let flowCancelled = false, flowActive = false, flowVersion = 0;
  // The original UI runs spec, board, and video as separate IPC calls. Retain a
  // cancellation across that sequence so a later stage cannot start a new job.
  Object.defineProperty(window, '__studioFlow', { value: Object.freeze({
    begin() { flowVersion += 1; flowCancelled = false; flowActive = true; },
    finish() { flowActive = false; return flowCancelled; },
    get active() { return flowActive; },
    get cancelled() { return flowCancelled; }
  })});
  const invoke = (method, params) => {
    const generation = generationMethods.has(method), version = flowVersion;
    if (generation && flowCancelled) {
      return Promise.resolve({ok: false, code: 'CANCELLED', error: '생성이 취소되었습니다.'});
    }
    if (method === 'studio:cancel') flowCancelled = true;
    return Promise.resolve(window.webkit.messageHandlers.studio.postMessage({method, params: params ?? null})).then(result => {
      if (generation && version === flowVersion && result?.code === 'CANCELLED') flowCancelled = true;
      return result;
    });
  };
  const subscribe = event => handler => {
    if (typeof handler !== 'function') throw new TypeError('An event handler is required.');
    if (!subscriptions.has(event)) subscriptions.set(event, new Set());
    subscriptions.get(event).add(handler);
    return () => subscriptions.get(event)?.delete(handler);
  };
  Object.defineProperty(window, '__studioEvent', { value: (event, payload) => {
    for (const callback of subscriptions.get(event) || []) { try { callback(payload); } catch {} }
  }});
  Object.defineProperty(window, 'studio', { value: Object.freeze({
    env: () => invoke('studio:env'), guide: () => invoke('studio:guide'),
    auth: Object.freeze({status: () => invoke('studio:authStatus'), login: () => invoke('studio:authLogin'), logout: () => invoke('studio:authLogout')}),
    claude: Object.freeze({status: () => invoke('studio:claudeStatus'), loginStart: () => invoke('studio:claudeLoginStart'),
      loginComplete: code => invoke('studio:claudeLoginComplete', {code}), loginCancel: () => invoke('studio:claudeLoginCancel'), logout: () => invoke('studio:claudeLogout')}),
    spec: input => invoke('studio:spec', input), board: input => invoke('studio:board', input), video: input => invoke('studio:video', input),
    imageVideo: Object.freeze({
      providers: () => invoke('studio:imageVideoProviders'), configure: input => invoke('studio:imageVideoConfigure', input),
      disconnect: input => invoke('studio:imageVideoDisconnect', input), prepare: input => invoke('studio:imageVideoPrepare', input),
      savePlan: input => invoke('studio:imageVideoSavePlan', input), generate: input => invoke('studio:imageVideoGenerate', input),
      refresh: input => invoke('studio:imageVideoRefresh', input), importClip: input => invoke('studio:imageVideoImportClip', input),
      recover: input => invoke('studio:imageVideoRecover', input),
      export: input => invoke('studio:imageVideoExport', input)
    }),
    pickMusic: () => invoke('studio:pickMusic'), installFfmpeg: () => invoke('studio:installFfmpeg'),
    videoSaveAs: (id,kind) => invoke('studio:videoSaveAs', {id,kind}), videoReveal: (id,which,kind) => invoke('studio:videoReveal', {id,which,kind}),
    cancel: () => invoke('studio:cancel'), history: () => invoke('studio:history'),
    historyGet: id => invoke('studio:historyGet', {id}), historyRemove: id => invoke('studio:historyRemove', {id}),
    imageSaveAs: id => invoke('studio:imageSaveAs', {id}), imageImport: id => invoke('studio:imageImport', {id}),
    reveal: id => invoke('studio:reveal', {id}), openDataDir: () => invoke('studio:openDataDir'), openExternal: url => invoke('studio:openExternal', {url}),
    onProgress: subscribe('studio:progress'), onAuth: subscribe('studio:auth'), onClaudeAuth: subscribe('studio:claudeAuth')
  })});
})();
