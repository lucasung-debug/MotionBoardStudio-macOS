'use strict';

// Electron 내장 Chromium 으로 합성 HTML 을 프레임 단위 캡처한다(Playwright 불필요).
// - 오프스크린 창 + DevTools Protocol Page.captureScreenshot (숨김 창은 렌더가 멈출 수 있어 쓰지 않는다)
// - LLM 이 쓴 코드는 신뢰하지 않는다: 전용 세션에서 file:/data: 와 Google Fonts 외 요청을 전부 차단,
//   새 창·이동·권한 요청 거부, 샌드박스·컨텍스트 격리.
// - 최종 품질: 프레임당 4 서브프레임(180° 셔터)을 ffmpeg tmix 로 평균해 모션 블러를 만든다.

const { BrowserWindow, session, nativeImage } = require('electron');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg.cjs');

const PARTITION = 'mbs-render';
const SHUTTER = 0.5;
let sessionConfigured = false;

function renderSession() {
  const ses = session.fromPartition(PARTITION, { cache: true });
  if (!sessionConfigured) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = String(details.url || '');
      const allowed = /^(file|data|blob|devtools):/i.test(url) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//i.test(url);
      callback({ cancel: !allowed });
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    sessionConfigured = true;
  }
  return ses;
}

function cancelled() {
  const error = new Error('생성이 취소되었습니다.');
  error.code = 'CANCELLED';
  return error;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function openPage(htmlPath, { W, H, signal }) {
  if (signal?.aborted) throw cancelled();
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      session: renderSession()
    }
  });
  const wc = win.webContents;
  wc.setFrameRate(240);
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const consoleErrors = [];
  wc.on('console-message', (...args) => {
    const detail = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
    const level = String(detail.level);
    if ((level === 'error' || level === '3') && consoleErrors.length < 20) consoleErrors.push(String(detail.message));
  });
  const close = () => { try { if (!win.isDestroyed()) win.destroy(); } catch {} };
  const onAbort = () => close();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    await withTimeout(win.loadFile(htmlPath), 60000, '영상 코드 페이지를 여는 데 실패했습니다(시간 초과).');
    const ready = await withTimeout(wc.executeJavaScript('Promise.resolve(window.MK_READY).then(Boolean)', true), 45000, '영상 코드 초기화(글꼴 로드·build)가 45초 안에 끝나지 않았습니다.');
    const pageErrors = await wc.executeJavaScript('window.MK ? MK.errors() : (window.MK_ERRORS || ["모션 키트가 로드되지 않았습니다."])', true);
    const dbg = wc.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    return {
      win,
      ready,
      errors: () => [...pageErrors, ...consoleErrors.filter((m) => !pageErrors.includes(m))],
      async eval(code) {
        if (signal?.aborted) throw cancelled();
        return wc.executeJavaScript(code, true);
      },
      // format 'jpeg'(품질 96)는 PNG 보다 약 3배 빠르다 — 브라우저 쪽 PNG 인코딩이 렌더 병목이다.
      // 최종 H.264(yuv420p) 대비 화질 차이는 무시할 수준이라 영상 프레임은 JPEG, 검증·시트·포스터는 PNG.
      async capture(t, { format = 'png' } = {}) {
        if (signal?.aborted) throw cancelled();
        await wc.executeJavaScript(`MK.seek(${Number(t)})`, true);
        const params = format === 'jpeg'
          ? { format: 'jpeg', quality: 96, fromSurface: true, captureBeyondViewport: false }
          : { format: 'png', fromSurface: true, captureBeyondViewport: false };
        const shot = await dbg.sendCommand('Page.captureScreenshot', params);
        return Buffer.from(shot.data, 'base64');
      },
      close() {
        signal?.removeEventListener?.('abort', onAbort);
        try { dbg.detach(); } catch {}
        close();
      }
    };
  } catch (error) {
    signal?.removeEventListener?.('abort', onAbort);
    close();
    if (signal?.aborted) throw cancelled();
    throw error;
  }
}

// 픽셀 표준편차(휘도) — 거의 단색이면 빈 화면으로 본다.
function frameSpread(png) {
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  let n = 0, sum = 0, sq = 0;
  const step = Math.max(1, Math.floor((width * height) / 40000));
  for (let i = 0; i < width * height; i += step) {
    const o = i * 4;
    const y = 0.0722 * bmp[o] + 0.7152 * bmp[o + 1] + 0.2126 * bmp[o + 2];
    sum += y; sq += y * y; n += 1;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

// 코드 실행 검증: 초기화 오류, 전 구간 seek 오류, 느린 render, 빈 화면, 효과음 목록.
async function validate(htmlPath, timing, { signal } = {}) {
  const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal });
  try {
    const problems = [...page.errors()];
    if (!page.ready && !problems.length) problems.push('MK.boot()가 실패했습니다(MK.define 누락 또는 build 오류).');
    const probe = await page.eval(`(() => {
      const bad = []; let slow = 0; const step = ${timing.beat / 2};
      for (let t = 0; t < MK.T; t += step) {
        const t0 = performance.now();
        if (!MK.seek(t)) bad.push(t.toFixed(3));
        slow = Math.max(slow, performance.now() - t0);
      }
      return { bad, slow, errors: MK.errors(), sfx: MK.sfxList() };
    })()`);
    for (const e of probe.errors) if (!problems.includes(e)) problems.push(e);
    if (probe.bad.length) problems.push(`render(t)가 ${probe.bad.length}개 시각에서 실패했습니다 (예: t=${probe.bad.slice(0, 4).join(', ')})`);
    if (probe.slow > 250) problems.push(`render(t) 한 번에 ${Math.round(probe.slow)}ms가 걸립니다. DOM 생성은 build()로 옮기고 render()에서는 스타일만 바꾸세요.`);
    let spreads = [];
    if (!problems.length) {
      for (const f of [0.15, 0.5, 0.85]) spreads.push(frameSpread(await page.capture(timing.T * f)));
      if (spreads.every((s) => s < 1.5)) problems.push('렌더된 화면이 거의 단색입니다(요소가 보이지 않음). 요소 위치·크기·색·가시성을 확인하세요.');
    }
    return { ok: problems.length === 0, problems, sfx: probe.sfx || [], slowMs: probe.slow, spreads };
  } finally {
    page.close();
  }
}

// 샘플 시각마다 라벨을 찍어 캡처하고 한 장의 시트(JPEG)로 합친다.
async function contactSheet(htmlPath, timing, outFile, { times, cols = 6, signal } = {}) {
  const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mbs-sheet-'));
  try {
    let i = 0;
    for (const t of times) {
      await page.eval(`MK.debugLabel(${JSON.stringify(`${t.toFixed(2)}s`)})`);
      await fsp.writeFile(path.join(dir, `s_${String(i).padStart(3, '0')}.png`), await page.capture(t));
      i += 1;
    }
    await page.eval('MK.debugLabel(null)');
    const rows = Math.ceil(times.length / cols);
    const tileW = Math.round(timing.W / 4);
    await ffmpeg.run(['-y', '-framerate', '1', '-i', path.join(dir, 's_%03d.png'),
      '-vf', `scale=${tileW}:-2,tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', '-q:v', '3', outFile], { signal });
    return outFile;
  } finally {
    page.close();
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 전체 렌더: 워커마다 창 하나 + ffmpeg 하나(구간 세그먼트) → concat + 오디오 mux.
async function renderVideo(htmlPath, timing, { outFile, audioFile, posterFile, quality = 'final', workers, signal, onProgress } = {}) {
  const fps = quality === 'draft' ? 30 : timing.fps;
  const sub = quality === 'draft' ? 1 : 4;
  const frames = Math.round(timing.T * fps);
  const offsets = Array.from({ length: sub }, (_, s) => (sub === 1 ? 0 : ((s + 0.5) / sub - 0.5) * SHUTTER / fps));
  const count = Math.max(1, Math.min(workers || Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))), 6));
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mbs-render-'));
  const bounds = Array.from({ length: count + 1 }, (_, k) => Math.round((frames * k) / count));
  // 한 워커가 실패하면 나머지도 즉시 멈추도록 내부 취소 신호를 둔다.
  const local = new AbortController();
  const relay = () => local.abort();
  signal?.addEventListener?.('abort', relay, { once: true });
  let done = 0;
  let lastReport = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 400 && done < frames) return;
    lastReport = now;
    try { onProgress?.({ done, frames }); } catch {}
  };
  const vf = sub > 1
    ? ['-vf', `tmix=frames=${sub}:weights='${Array(sub).fill(1).join(' ')}',select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/(${fps}*TB)`]
    : [];
  const segment = async (k) => {
    const seg = path.join(tmp, `seg_${String(k).padStart(2, '0')}.mkv`);
    const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal: local.signal });
    const enc = ffmpeg.pipe(['-y', '-f', 'image2pipe', '-framerate', String(fps * sub), '-c:v', 'mjpeg', '-i', '-', ...vf,
      '-r', String(fps), '-c:v', 'ffv1', '-pix_fmt', 'rgb24', seg], { signal: local.signal });
    try {
      for (let f = bounds[k]; f < bounds[k + 1]; f += 1) {
        for (const off of offsets) {
          const t = (((f / fps + off) % timing.T) + timing.T) % timing.T;
          await enc.write(await page.capture(t, { format: 'jpeg' }));
        }
        done += 1;
        report();
      }
      await enc.end();
    } catch (error) {
      enc.kill();
      local.abort();
      throw signal?.aborted ? cancelled() : error;
    } finally {
      page.close();
    }
    return seg;
  };
  try {
    const segs = await Promise.all(Array.from({ length: count }, (_, k) => segment(k)));
    if (posterFile) {
      const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal });
      try { await fsp.writeFile(posterFile, await page.capture(timing.scenes?.[7]?.start ?? timing.T * 0.55)); } finally { page.close(); }
    }
    const list = path.join(tmp, 'segs.txt');
    await fsp.writeFile(list, segs.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const audioArgs = audioFile ? ['-i', audioFile] : [];
    const mapArgs = audioFile ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k', '-shortest'] : ['-map', '0:v'];
    await ffmpeg.run(['-y', '-f', 'concat', '-safe', '0', '-i', list, ...audioArgs, ...mapArgs,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-profile:v', 'high',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-r', String(fps), '-movflags', '+faststart', outFile], { signal });
    return { frames, fps, subframes: sub, workers: count };
  } finally {
    signal?.removeEventListener?.('abort', relay);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { PARTITION, SHUTTER, openPage, validate, contactSheet, renderVideo, frameSpread };
