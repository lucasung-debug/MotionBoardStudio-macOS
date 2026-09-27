'use strict';

// ffmpeg 위치 탐색과 실행 도우미. 앱은 ffmpeg 를 번들하지 않고 시스템 설치본을 찾는다.
// 우선순위: 환경변수 MOTION_BOARD_FFMPEG → PATH → Windows 흔한 설치 위치(winget, C:\ffmpeg).

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV_KEY = 'MOTION_BOARD_FFMPEG';
let cached = null;

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function works(bin) {
  try {
    execFileSync(bin, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function fromPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function wingetCandidates() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const root = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  const found = [];
  try {
    for (const pkg of fs.readdirSync(root)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const pkgDir = path.join(root, pkg);
      for (const sub of fs.readdirSync(pkgDir)) {
        const bin = path.join(pkgDir, sub, 'bin', exe('ffmpeg'));
        if (fs.existsSync(bin)) found.push(bin);
      }
    }
  } catch {}
  return found;
}

function locate({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const candidates = [];
  if (process.env[ENV_KEY]) candidates.push(process.env[ENV_KEY]);
  candidates.push(...fromPath());
  if (process.platform === 'win32') {
    candidates.push(...wingetCandidates());
    candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  } else {
    candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  }
  for (const bin of candidates) {
    if (bin && fs.existsSync(bin) && works(bin)) {
      cached = { ffmpeg: bin, version: version(bin) };
      return cached;
    }
  }
  cached = null;
  return null;
}

function version(bin) {
  try {
    const out = execFileSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return (out.match(/ffmpeg version (\S+)/) || [])[1] || '';
  } catch {
    return '';
  }
}

const WINGET_ID = 'Gyan.FFmpeg.Essentials';

// winget 으로 ffmpeg(Gyan Essentials 빌드, GPL)를 설치한다. Windows 10/11 에 기본 포함된 winget 을 쓴다.
// 이미 설치돼 있어도(winget 이 오류 코드를 내도) 마지막에 실제 위치를 다시 찾아 판단한다.
function installWithWinget({ onLine, signal } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('자동 설치는 Windows에서만 지원합니다. ffmpeg를 직접 설치해 주세요.'));
  return new Promise((resolve, reject) => {
    const child = spawn('winget', ['install', '--id', WINGET_ID, '-e', '--source', 'winget',
      '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'], { windowsHide: true });
    let tail = '';
    const onData = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
      const line = chunk.toString().split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && /[A-Za-z가-힣]/.test(l)).pop();
      if (line) { try { onLine?.(line.slice(0, 160)); } catch {} }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => { try { child.kill(); } catch {} };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (error) => {
      signal?.removeEventListener?.('abort', onAbort);
      reject(error.code === 'ENOENT'
        ? new Error('winget을 찾지 못했습니다. Microsoft Store의 "앱 설치 관리자"를 설치하거나 ffmpeg를 직접 설치해 주세요.')
        : error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort);
      const found = locate({ refresh: true });
      if (found) return resolve(found);
      reject(new Error(`ffmpeg 설치에 실패했습니다 (winget 종료 코드 ${code}): ${tail.trim().split(/[\r\n]+/).slice(-2).join(' ')}`));
    });
  });
}

function require_() {
  const found = locate();
  if (!found) {
    const error = new Error('영상 제작에 필요한 ffmpeg를 찾지 못했습니다. 영상 옵션의 "ffmpeg 설치" 버튼을 누르거나, PowerShell에서 "winget install Gyan.FFmpeg.Essentials"로 설치해 주세요. (다른 위치에 있다면 환경변수 MOTION_BOARD_FFMPEG에 ffmpeg.exe 경로를 지정)');
    error.code = 'FFMPEG_MISSING';
    throw error;
  }
  return found.ffmpeg;
}

// ffmpeg 를 실행해 stdout 을 Buffer 로 모은다. signal 로 취소하면 프로세스를 종료한다.
function run(args, { input, signal, maxBuffer = 1 << 30 } = {}) {
  const bin = require_();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-v', 'error', ...args], { windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) { onAbort(); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', (error) => { signal?.removeEventListener?.('abort', onAbort); reject(error); });
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) {
        const error = new Error('생성이 취소되었습니다.');
        error.code = 'CANCELLED';
        return reject(error);
      }
      if (code !== 0) return reject(new Error(`ffmpeg 실패 (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      resolve(Buffer.concat(chunks));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

// stdin 으로 프레임을 계속 밀어 넣는 장기 실행용. write() 는 백프레셔를 기다린다.
function pipe(args, { signal } = {}) {
  const bin = require_();
  const child = spawn(bin, ['-hide_banner', '-v', 'error', ...args], { windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) {
        const error = new Error('생성이 취소되었습니다.');
        error.code = 'CANCELLED';
        return reject(error);
      }
      if (code !== 0) return reject(new Error(`ffmpeg 실패 (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      resolve();
    });
  });
  // ffmpeg 가 먼저 끝나면(오류) drain 을 영원히 기다리지 않도록 종료와 경쟁시킨다.
  const endedEarly = done.then(() => { throw new Error('ffmpeg가 입력을 다 받기 전에 종료되었습니다.'); });
  endedEarly.catch(() => {});
  return {
    write(buffer) {
      const written = new Promise((resolve, reject) => {
        if (child.stdin.destroyed) return reject(new Error('ffmpeg 입력이 닫혔습니다.'));
        if (child.stdin.write(buffer)) resolve();
        else child.stdin.once('drain', resolve);
      });
      return Promise.race([written, endedEarly]);
    },
    end() {
      child.stdin.end();
      return done;
    },
    kill: onAbort,
    done
  };
}

module.exports = { ENV_KEY, WINGET_ID, locate, installWithWinget, require: require_, run, pipe };
