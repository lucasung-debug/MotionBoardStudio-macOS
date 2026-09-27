"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const failure = (code, message, started = false) => Object.assign(new Error(message), { code, started });

// CLI processes get only the OS/session variables they need. Provider API keys,
// agent configuration overrides and debugging options are never inherited.
function cliEnvironment(executable, overrides = {}) {
  const environment = {};
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.HOME ||= os.homedir();
  environment.PATH = [...new Set([path.dirname(executable), path.dirname(process.execPath),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(path.delimiter);
  environment.NO_COLOR = "1";
  environment.GROK_DISABLE_API_KEY_AUTH = "1";
  // Keep connection checks independent of the CLI's remote marketplace rollout.
  environment.GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER = "0";
  for (const name of ["GROK_HOME", "GROK_DISABLE_API_KEY_AUTH"]) {
    if (typeof overrides[name] === "string") environment[name] = overrides[name];
  }
  return environment;
}

async function findCLI(provider, selectedPath) {
  if (!["grok", "kling"].includes(provider)) throw failure("UNKNOWN_VIDEO_PROVIDER", "지원하지 않는 영상 서비스입니다.");
  const home = os.homedir();
  const candidates = selectedPath ? [selectedPath] : [
    path.join(home, ".grok/bin", provider), path.join(home, ".local/bin", provider),
    path.join(home, ".npm-global/bin", provider), "/opt/homebrew/bin/" + provider,
    "/usr/local/bin/" + provider
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate || "") || /[\0\r\n]/.test(candidate)) continue;
    try {
      const real = await fs.realpath(candidate), stat = await fs.stat(real);
      if (!stat.isFile()) continue;
      await fs.access(real, require("node:fs").constants.X_OK);
      return candidate;
    } catch { /* Try the next known install location; never search the cwd. */ }
  }
  return null;
}

function runCLI(executable, args, { signal, timeoutMs = 30000, cwd, env, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(failure("CANCELLED", "CLI 실행을 취소했습니다."));
  if (!path.isAbsolute(executable || "") || !Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) {
    return Promise.reject(failure("CLI_START_FAILED", "CLI 실행 경로와 인자를 확인해 주세요."));
  }
  return new Promise((resolve, reject) => {
    let child, started = false, settled = false, size = 0, output = [], errors = [], timer, killTimer, interruption;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(result);
    };
    const stop = error => {
      if (settled || interruption) return;
      interruption = error;
      if (!started || !child?.pid) return finish(error);
      // Each invocation owns a process group. Never signal another CLI session.
      const kill = value => { try { process.kill(-child.pid, value); } catch { try { child.kill(value); } catch {} } };
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1500); killTimer.unref();
    };
    const cancel = () => stop(failure("CANCELLED", "CLI 실행을 취소했습니다.", started));
    const receive = destination => chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) return stop(failure("CLI_OUTPUT_LIMIT", "CLI 응답이 앱의 처리 한도를 넘었습니다.", started));
      destination.push(chunk);
    };
    try {
      child = spawn(executable, args, { cwd: cwd || os.tmpdir(), env: cliEnvironment(executable, env),
        shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      // spawn() can already have created the process before its asynchronous
      // 'spawn' event. A cancellation in that gap must still terminate it and
      // must never be classified as a request that definitely did not start.
      started = Boolean(child.pid);
    } catch { return finish(failure("CLI_START_FAILED", "영상 CLI를 시작하지 못했습니다.")); }
    child.once("spawn", () => { started = true; if (signal?.aborted) cancel(); });
    child.once("error", () => finish(failure("CLI_START_FAILED", "영상 CLI를 시작하지 못했습니다.", started)));
    child.stdout.on("data", receive(output)); child.stderr.on("data", receive(errors));
    child.once("close", (code, terminationSignal) => finish(interruption, {
      stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8"),
      exitCode: Number.isInteger(code) ? code : 1, signal: terminationSignal || null
    }));
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => stop(failure("CLI_TIMEOUT", "영상 CLI 응답 시간이 초과되었습니다.", started)), timeoutMs);
    timer.unref();
  });
}

module.exports = { cliEnvironment, findCLI, runCLI };
