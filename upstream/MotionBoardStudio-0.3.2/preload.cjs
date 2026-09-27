'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  env: () => ipcRenderer.invoke('studio:env'),
  guide: () => ipcRenderer.invoke('studio:guide'),
  auth: {
    status: () => ipcRenderer.invoke('studio:authStatus'),
    login: () => ipcRenderer.invoke('studio:authLogin'),
    logout: () => ipcRenderer.invoke('studio:authLogout')
  },
  claude: {
    status: () => ipcRenderer.invoke('studio:claudeStatus'),
    loginStart: () => ipcRenderer.invoke('studio:claudeLoginStart'),
    loginComplete: (code) => ipcRenderer.invoke('studio:claudeLoginComplete', { code }),
    loginCancel: () => ipcRenderer.invoke('studio:claudeLoginCancel'),
    logout: () => ipcRenderer.invoke('studio:claudeLogout')
  },
  spec: (input) => ipcRenderer.invoke('studio:spec', input),
  board: (input) => ipcRenderer.invoke('studio:board', input),
  video: (input) => ipcRenderer.invoke('studio:video', input),
  pickMusic: () => ipcRenderer.invoke('studio:pickMusic'),
  installFfmpeg: () => ipcRenderer.invoke('studio:installFfmpeg'),
  videoSaveAs: (id) => ipcRenderer.invoke('studio:videoSaveAs', { id }),
  videoReveal: (id, which) => ipcRenderer.invoke('studio:videoReveal', { id, which }),
  cancel: () => ipcRenderer.invoke('studio:cancel'),
  history: () => ipcRenderer.invoke('studio:history'),
  historyGet: (id) => ipcRenderer.invoke('studio:historyGet', { id }),
  historyRemove: (id) => ipcRenderer.invoke('studio:historyRemove', { id }),
  imageSaveAs: (id) => ipcRenderer.invoke('studio:imageSaveAs', { id }),
  imageImport: (id) => ipcRenderer.invoke('studio:imageImport', { id }),
  reveal: (id) => ipcRenderer.invoke('studio:reveal', { id }),
  openDataDir: () => ipcRenderer.invoke('studio:openDataDir'),
  openExternal: (url) => ipcRenderer.invoke('studio:openExternal', { url }),
  onProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('studio:progress', listener);
    return () => ipcRenderer.removeListener('studio:progress', listener);
  },
  onAuth: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('studio:auth', listener);
    return () => ipcRenderer.removeListener('studio:auth', listener);
  },
  onClaudeAuth: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('studio:claudeAuth', listener);
    return () => ipcRenderer.removeListener('studio:claudeAuth', listener);
  }
});
