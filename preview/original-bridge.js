/* Static preview adapter. No provider, credential, network, or file access. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory;
  if (root) root.studio = factory(root.document);
})(typeof window === "undefined" ? null : window, function (document) {
  "use strict";
  const message = "원본 0.3.2 화면 미리보기입니다. 로그인·AI 생성·파일 기능은 Mac 연결 작업 중이며, 이 화면에서는 실행되지 않습니다.";
  const capabilities = Object.freeze({ preview: true, authentication: false, generation: false, fileAccess: false, mediaExport: false });
  const status = () => ({ loggedIn: false, pending: false, connected: false, source: "preview" });
  const unavailable = async function () {
    if (document) {
      const label = document.getElementById("statusText");
      if (label) label.textContent = message;
    }
    return { ok: false, code: "PREVIEW_UNAVAILABLE", error: message };
  };
  const onEvent = function () { return function unsubscribe() {}; };
  const api = {
    capabilities: capabilities,
    env: async () => ({
      ok: true, preview: true, capabilities: capabilities,
      ffmpeg: null, model: "gpt-6-astra", reasoningEffort: "xhigh",
      claudeModel: "claude-opus-5-5", claudeEffort: "max",
      guideName: "주제형_모션그래픽_올인원_가이드.md", appVersion: "0.3.2", dataDir: null
    }),
    guide: unavailable,
    auth: Object.freeze({ status: async () => ({ ok: true, status: status() }), login: unavailable, logout: unavailable }),
    claude: Object.freeze({ status: async () => ({ ok: true, status: status() }), loginStart: unavailable, loginComplete: unavailable, loginCancel: unavailable, logout: unavailable }),
    history: async () => ({ ok: true, entries: [], preview: true }),
    onProgress: onEvent, onAuth: onEvent, onClaudeAuth: onEvent
  };
  for (const method of ["spec", "board", "video", "pickMusic", "installFfmpeg", "videoSaveAs", "videoReveal", "cancel", "historyGet", "historyRemove", "imageSaveAs", "imageImport", "reveal", "openDataDir", "openExternal"]) api[method] = unavailable;

  function clarifyPreview() {
    const hint = document.getElementById("ffmpegHint");
    if (hint) hint.textContent = "영상 렌더·음악 연결은 Mac 이식 작업 중입니다. 이 미리보기는 ffmpeg 설치나 영상 생성을 실행하지 않습니다.";
    const install = document.getElementById("installFfmpegBtn");
    if (install) { install.hidden = true; install.disabled = true; }
    const history = document.getElementById("historyEmpty");
    if (history) history.textContent = "미리보기에서는 원본 생성 기록에 연결하지 않습니다.";
    const label = document.getElementById("statusText");
    if (label) label.textContent = "화면 미리보기 준비 완료 · 로그인과 생성 기능은 아직 연결되지 않았습니다.";
  }
  if (document) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", clarifyPreview, { once: true });
    else clarifyPreview();
  }
  return Object.freeze(api);
});
