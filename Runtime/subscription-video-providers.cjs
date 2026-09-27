"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { findCLI, runCLI } = require("./video-cli.cjs");
const grok = require("./grok-subscription.cjs");
const kling = require("./kling-subscription.cjs");

const PROVIDERS = Object.freeze({ grok: grok.CATALOG, kling: kling.CATALOG });
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fail = message => Object.assign(new Error(message), { code: "VIDEO_PROVIDER_UNCONFIGURED" });
const CONNECTION_ERRORS = Object.freeze({
  CLI_PROFILE_INVALID: "앱 전용 Grok 설정을 읽거나 검증하지 못했습니다. 앱과 Grok CLI의 설정 호환성을 확인해 주세요.",
  CLI_UNSUPPORTED: "설치된 Grok CLI에서 필요한 연결 기능을 확인하지 못했습니다. 공식 CLI를 업데이트해 주세요.",
  CLI_SUBSCRIPTION_REQUIRED: "Grok 연결이 구독 로그인으로 제한되지 않아 중단했습니다. 앱 전용 연결 설정을 확인해 주세요.",
  CLI_TIMEOUT: "CLI 연결 확인 시간이 초과되었습니다. 네트워크를 확인한 뒤 상태를 새로고침해 주세요.",
  CLI_START_FAILED: "CLI를 시작하지 못했습니다. 실행 파일 경로와 실행 권한을 확인해 주세요.",
  CLI_EXITED: "CLI가 연결 확인 중 종료되었습니다. 상태를 새로고침해 주세요.",
  GROK_REQUEST_FAILED: "Grok 로그인 확인에 실패했습니다. 앱 전용 로그인과 구독 상태를 확인해 주세요.",
  PROVIDER_RESPONSE_INVALID: "CLI의 연결 상태 응답을 해석하지 못했습니다. 공식 CLI를 업데이트한 뒤 다시 확인해 주세요."
});

function createSubscriptionConnections({ store, nativeCall, run = runCLI, locate = findCLI }) {
  const profilesDir = path.join(store.baseDir, "video-connections");
  const grokHome = path.join(profilesDir, "grok-profile");
  const settingsFile = path.join(profilesDir, "connections.json");
  let settingsQueue = Promise.resolve();
  const info = provider => {
    if (!Object.hasOwn(PROVIDERS, provider)) throw fail("지원하는 영상 서비스를 선택해 주세요.");
    return PROVIDERS[provider];
  };
  async function readSettings() {
    try {
      const value = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("CLI 연결 설정을 읽지 못했습니다.");
      return value;
    } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  async function settings(provider) {
    info(provider); await settingsQueue;
    return (await readSettings())[provider] || {};
  }
  function saveSettings(provider, patch) {
    const task = settingsQueue.then(async () => {
      const state = await readSettings();
      await store.atomicWrite(settingsFile, JSON.stringify({ ...state, [provider]: { ...state[provider], ...patch } }, null, 2));
    });
    settingsQueue = task.catch(() => {});
    return task;
  }
  async function inspect(provider) {
    const catalog = info(provider), saved = await settings(provider);
    const executable = await locate(provider, saved.executable);
    if (!executable) return { ...catalog, installed: false, configured: false, statusMessage: "공식 CLI 설치가 필요합니다." };
    if (saved.enabled === false) return { ...catalog, installed: true, configured: false, statusMessage: "이 앱에서 연결을 해제했습니다." };
    try {
      const status = provider === "grok"
        ? await grok.inspectGrokSubscription({ run, executable, home: grokHome })
        : await kling.inspectKlingSubscription({ run, executable });
      return { ...catalog, ...status, installed: true,
        durations: status.durations?.length ? status.durations : catalog.durations,
        resolutions: status.resolutions?.length ? status.resolutions : catalog.resolutions,
        statusMessage: status.message || (status.configured ? "구독 계정 연결됨" : "CLI에서 구독 계정으로 로그인해 주세요.") };
    } catch (error) {
      // Never display arbitrary CLI errors: they can contain account data.
      const code = Object.hasOwn(CONNECTION_ERRORS, error?.code) ? error.code : "CONNECTION_CHECK_FAILED";
      return { ...catalog, installed: true, configured: false, errorCode: code,
        statusMessage: CONNECTION_ERRORS[code] || "구독 연결을 확인하지 못했습니다. 연결 확인을 눌러 주세요." };
    }
  }
  async function providers() { return { ok: true, providers: await Promise.all(Object.keys(PROVIDERS).map(inspect)) }; }

  async function configure({ provider }) {
    const catalog = info(provider), saved = await settings(provider);
    let executable = await locate(provider, saved.executable);
    if (!executable) {
      const choice = await nativeCall("dialog.message", { options: { message: `${catalog.label} 구독 연결`,
        detail: "공식 CLI를 설치한 뒤 실행 파일을 선택하세요. API 키는 입력하지 않습니다.",
        buttons: ["CLI 실행 파일 선택", "설치 안내 열기", "취소"], defaultId: 0, cancelId: 2 } });
      if (choice.response === 1) {
        await nativeCall("shell.openExternal", { url: catalog.setupURL });
        return { ok: true, configured: false, message: "공식 안내에 따라 CLI를 설치한 뒤 구독 연결을 눌러 주세요." };
      }
      if (choice.response !== 0) return { ok: true, canceled: true, configured: false };
      const selected = await nativeCall("dialog.open", { options: { title: `${catalog.label} CLI 실행 파일 선택`, properties: ["openFile"] } });
      if (selected.canceled || !selected.filePaths?.[0]) return { ok: true, canceled: true, configured: false };
      executable = await locate(provider, selected.filePaths[0]);
      if (!executable) throw fail("선택한 CLI 실행 파일을 확인해 주세요.");
      const version = await run(executable, ["--version"], { timeoutMs: 10000 });
      if (version.exitCode !== 0 || !new RegExp(provider, "i").test(version.stdout)) throw fail("해당 서비스의 공식 CLI 실행 파일을 선택해 주세요.");
    }
    await saveSettings(provider, { executable, enabled: true });
    const status = await inspect(provider);
    if (status.configured) return { ok: true, configured: true, message: "구독 계정 연결을 확인했습니다." };
    if (status.errorCode && !["VIDEO_AUTH_REJECTED", "GROK_REQUEST_FAILED"].includes(status.errorCode)) {
      return { ok: false, configured: false, errorCode: status.errorCode, error: status.statusMessage };
    }
    const answer = await nativeCall("dialog.message", { options: { message: `${catalog.label} 구독 계정 로그인`,
      detail: provider === "grok"
        ? "MotionBoard 전용 Grok 로그인 창을 터미널에서 엽니다. 웹 구독 계정으로 로그인한 뒤 앱에서 연결 확인을 누르세요. 기존 Grok CLI 로그인은 유지됩니다."
        : "공식 Kling CLI의 OAuth 로그인을 터미널에서 엽니다. 브라우저에서 계정을 연결한 뒤 앱에서 연결 확인을 누르세요. 현재 대화의 MCP 로그인과 앱 연결은 각각 관리됩니다.",
      buttons: ["로그인 터미널 열기", "취소"], defaultId: 0, cancelId: 1 } });
    if (answer.response !== 0) return { ok: true, canceled: true, configured: false };
    if (provider === "grok") await grok.prepareGrokHome(grokHome);
    const scriptsDir = path.join(profilesDir, "login");
    await fs.mkdir(scriptsDir, { recursive: true, mode: 0o700 });
    const scriptPath = path.join(scriptsDir, `${provider}-${crypto.randomUUID()}.command`);
    const cliPath = [path.dirname(executable), path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    const script = ["#!/bin/zsh", "unset XAI_API_KEY GROK_API_KEY GROK_API_BASE GROK_BASE_URL GROK_DEBUG GROK_LOG_FILE",
      `export PATH=${shellQuote(cliPath)}`, ...(provider === "grok" ? [
        `export GROK_HOME=${shellQuote(grokHome)}`, "export GROK_DISABLE_API_KEY_AUTH=1", "export GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER=0"
      ] : []), `cd ${shellQuote(profilesDir)}`,
      `${shellQuote(executable)} login${provider === "grok" ? " --oauth" : ""}`,
      "printf '\\n로그인이 끝나면 MotionBoard에서 연결 확인을 눌러 주세요.\\n'", ""].join("\n");
    await fs.writeFile(scriptPath, script, { flag: "wx", mode: 0o700 });
    await nativeCall("shell.openPath", { path: scriptPath });
    return { ok: true, configured: false, message: "터미널에서 구독 계정 로그인 후 연결 확인을 눌러 주세요." };
  }
  async function disconnect({ provider }) {
    info(provider); await saveSettings(provider, { enabled: false });
    return { ok: true, configured: false };
  }
  async function client(provider, { workDir, polling = false } = {}) {
    info(provider);
    const saved = await settings(provider), executable = await locate(provider, saved.executable);
    if (!executable || !polling && saved.enabled === false) throw fail("구독 계정을 먼저 연결해 주세요.");
    return provider === "grok"
      ? grok.createGrokSubscriptionProvider({ run, executable, home: grokHome, workDir })
      : kling.createKlingSubscriptionProvider({ run, executable });
  }
  return { providers, configure, disconnect, client };
}

module.exports = { PROVIDERS, createSubscriptionConnections };
