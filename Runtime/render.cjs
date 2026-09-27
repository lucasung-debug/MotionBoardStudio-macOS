"use strict";

// macOS adaptation of the supplied 0.3.2 render pipeline. WebKit owns isolated
// pages and pixel capture; the original FFmpeg timing and encoding remain here.
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const SHUTTER = 0.5;

function cancelled() {
  return Object.assign(new Error("생성이 취소되었습니다."), { code: "CANCELLED" });
}
function checkAbort(signal) { if (signal?.aborted) throw cancelled(); }

function temporaryOutput(target, label) {
  const extension = path.extname(target);
  return path.join(path.dirname(target), `.${path.basename(target, extension)}-${randomUUID()}.${label}${extension}`);
}

async function commitOutputs(outputs, signal) {
  const prepared = [], committed = [], keepBackups = new Set();
  try {
    for (const output of outputs) {
      checkAbort(signal);
      if (!(await fsp.stat(output.staged)).isFile()) throw new Error("완성된 영상 파일이 없습니다.");
      const item = { ...output, backup: temporaryOutput(output.target, "rollback"), existed: false };
      prepared.push(item);
      try {
        // A same-directory hard link retains the old bytes without copying a
        // potentially large movie. No old output changes before the commit.
        await fsp.link(item.target, item.backup);
        item.existed = true;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        if (!["EPERM", "EOPNOTSUPP", "ENOTSUP"].includes(error.code)) throw error;
        await fsp.copyFile(item.target, item.backup, fs.constants.COPYFILE_EXCL);
        item.existed = true;
      }
    }
    checkAbort(signal);
    // These are only same-filesystem metadata operations. A synchronous commit
    // prevents cancellation from interleaving between the poster/movie swaps.
    for (const item of prepared) {
      fs.renameSync(item.staged, item.target);
      committed.push(item);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      try {
        if (item.existed) fs.renameSync(item.backup, item.target);
        else fs.unlinkSync(item.target);
      } catch (restoreError) {
        keepBackups.add(item.backup);
        error.message += ` 복구 파일을 보존했습니다: ${item.backup} (${restoreError.code || "restore failed"})`;
      }
    }
    throw error;
  } finally {
    await Promise.all(prepared.filter(item => !keepBackups.has(item.backup)).map(item => fsp.unlink(item.backup).catch(() => {})));
  }
}

function createRenderer({ sourceRoot, nativeCall, ffmpeg: injectedFFmpeg }) {
  const ffmpeg = injectedFFmpeg || require(path.join(sourceRoot, "lib/video/ffmpeg.cjs"));
  const pages = new Set();
  async function call(method, params, signal, timeout = 60000) {
    checkAbort(signal);
    let timer, abort;
    try {
      return await Promise.race([
        nativeCall(method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("네이티브 렌더 응답 시간이 초과되었습니다: " + method)), timeout);
          abort = () => reject(cancelled());
          signal?.addEventListener("abort", abort, { once: true });
        })
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function openPage(htmlPath, { W, H, signal }) {
    checkAbort(signal);
    let opened, closePromise, abandoned = false;
    const open = Promise.resolve(nativeCall("render.open", { path: htmlPath, W, H }));
    // If cancellation wins while WebKit is opening, release the eventual page.
    open.then(result => {
      if ((abandoned || signal?.aborted) && result?.pageId) Promise.resolve().then(() => nativeCall("render.close", { pageId: result.pageId })).catch(() => {});
    }, () => {});
    let timer, abort;
    try {
      opened = await Promise.race([open, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("영상 페이지 초기화 시간이 초과되었습니다.")), 65000);
        abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
      })]);
    } catch (error) { abandoned = true; throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    if (!opened?.pageId) throw new Error("네이티브 렌더 페이지 ID가 없습니다.");
    const pageId = opened.pageId;
    const close = () => {
      if (!closePromise) {
        signal?.removeEventListener("abort", onAbort);
        pages.delete(page);
        closePromise = Promise.resolve().then(() => nativeCall("render.close", { pageId })).catch(() => {});
      }
      return closePromise;
    };
    const onAbort = () => { void close(); };
    const page = {
      ready: Boolean(opened.ready),
      errors: () => Array.isArray(opened.errors) ? opened.errors.map(String) : [],
      eval: code => call("render.eval", { pageId, code }, signal),
      async capture(time, { format = "png" } = {}) {
        if (!Number.isFinite(time) || !["png", "jpeg"].includes(format)) throw new Error("잘못된 프레임 캡처 요청입니다.");
        const shot = await call("render.capture", { pageId, time, format }, signal);
        checkAbort(signal);
        if (!shot?.data || typeof shot.data !== "string") throw new Error("렌더된 프레임 데이터가 없습니다.");
        return Buffer.from(shot.data, "base64");
      },
      close
    };
    pages.add(page);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { await close(); throw cancelled(); }
    return page;
  }

  async function frameSpread(png, { signal } = {}) {
    const result = await call("image.spread", { data: png.toString("base64") }, signal);
    if (!Number.isFinite(result?.spread)) throw new Error("프레임 밝기 분산을 계산하지 못했습니다.");
    return result.spread;
  }

  async function validate(htmlPath, timing, { signal } = {}) {
    const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal });
    try {
      const problems = page.errors();
      if (!page.ready) {
        if (!problems.length) problems.push("MK.boot()가 실패했습니다(MK.define 누락 또는 build 오류).");
        return { ok: false, problems, sfx: [], slowMs: 0, spreads: [] };
      }
      const probe = await page.eval(`(() => {
        const bad = []; let slow = 0; const step = ${Number(timing.beat) / 2};
        for (let t = 0; t < MK.T; t += step) {
          const start = performance.now();
          if (!MK.seek(t)) bad.push(t.toFixed(3));
          slow = Math.max(slow, performance.now() - start);
        }
        return { bad, slow, errors: MK.errors(), sfx: MK.sfxList() };
      })()`);
      for (const error of probe.errors || []) if (!problems.includes(error)) problems.push(error);
      if (probe.bad?.length) problems.push(`render(t)가 ${probe.bad.length}개 시각에서 실패했습니다 (예: ${probe.bad.slice(0, 4).join(", ")})`);
      if (probe.slow > 250) problems.push(`render(t) 한 번에 ${Math.round(probe.slow)}ms가 걸립니다. DOM 생성은 build()로 옮겨 주세요.`);
      const spreads = [];
      if (!problems.length) {
        for (const fraction of [0.15, 0.5, 0.85]) spreads.push(await frameSpread(await page.capture(timing.T * fraction), { signal }));
        if (spreads.every(value => value < 1.5)) problems.push("렌더된 화면이 거의 단색입니다. 요소 위치·크기·색·가시성을 확인하세요.");
      }
      return { ok: problems.length === 0, problems, sfx: probe.sfx || [], slowMs: probe.slow, spreads };
    } finally { await page.close(); }
  }

  async function contactSheet(htmlPath, timing, outFile, { times, cols = 6, signal } = {}) {
    const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal });
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mbs-sheet-"));
    try {
      for (let i = 0; i < times.length; i += 1) {
        const time = times[i];
        await page.eval(`MK.debugLabel(${JSON.stringify(time.toFixed(2) + "s")})`);
        await fsp.writeFile(path.join(directory, `s_${String(i).padStart(3, "0")}.png`), await page.capture(time));
      }
      await page.eval("MK.debugLabel(null)");
      await ffmpeg.run(["-y", "-framerate", "1", "-i", path.join(directory, "s_%03d.png"), "-vf",
        `scale=${Math.round(timing.W / 4)}:-2,tile=${cols}x${Math.ceil(times.length / cols)}:padding=6:color=white`,
        "-frames:v", "1", "-q:v", "3", outFile], { signal });
      return outFile;
    } finally {
      await page.close();
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }

  async function renderVideo(htmlPath, timing, { outFile, audioFile, posterFile, quality = "final", workers = 2, signal, onProgress } = {}) {
    checkAbort(signal);
    if (typeof outFile !== "string" || !outFile || (posterFile && path.resolve(posterFile) === path.resolve(outFile))) throw new Error("잘못된 영상 저장 경로입니다.");
    const stagedVideo = temporaryOutput(outFile, "partial");
    const stagedPoster = posterFile ? temporaryOutput(posterFile, "partial") : null;
    const fps = quality === "draft" ? 30 : timing.fps;
    const subframes = quality === "draft" ? 1 : 4;
    const frames = Math.round(timing.T * fps);
    if (!Number.isInteger(frames) || frames < 1 || !Number.isFinite(fps) || fps <= 0) throw new Error("잘못된 영상 길이 또는 프레임 속도입니다.");
    const count = Math.max(1, Math.min(Math.floor(workers) || 2, 2, frames));
    const offsets = Array.from({ length: subframes }, (_, sample) => subframes === 1 ? 0 : ((sample + 0.5) / subframes - 0.5) * SHUTTER / fps);
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mbs-render-"));
    const bounds = Array.from({ length: count + 1 }, (_, k) => Math.round(frames * k / count));
    const local = new AbortController();
    const relay = () => local.abort();
    signal?.addEventListener("abort", relay, { once: true });
    if (signal?.aborted) local.abort();
    let done = 0, lastReport = 0;
    const filter = subframes > 1 ? ["-vf", `tmix=frames=${subframes}:weights='${Array(subframes).fill(1).join(" ")}',select='eq(mod(n\\,${subframes})\\,${subframes - 1})',setpts=N/(${fps}*TB)`] : [];
    async function segment(index) {
      let page, encoder;
      const file = path.join(directory, `seg_${String(index).padStart(2, "0")}.mkv`);
      try {
        page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal: local.signal });
        encoder = ffmpeg.pipe(["-y", "-f", "image2pipe", "-framerate", String(fps * subframes), "-c:v", "mjpeg", "-i", "-", ...filter,
          "-r", String(fps), "-c:v", "ffv1", "-pix_fmt", "rgb24", file], { signal: local.signal });
        for (let frame = bounds[index]; frame < bounds[index + 1]; frame += 1) {
          for (const offset of offsets) {
            const time = ((frame / fps + offset) % timing.T + timing.T) % timing.T;
            await encoder.write(await page.capture(time, { format: "jpeg" }));
          }
          done += 1;
          if (Date.now() - lastReport >= 400 || done === frames) {
            lastReport = Date.now();
            try { onProgress?.({ done, frames }); } catch {}
          }
        }
        await encoder.end();
        return file;
      } catch (error) {
        encoder?.kill(); local.abort();
        throw signal?.aborted ? cancelled() : error;
      } finally { if (page) await page.close(); }
    }
    try {
      const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => segment(i)));
      const failed = results.find(result => result.status === "rejected" && result.reason?.code !== "CANCELLED")
        || results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      checkAbort(signal);
      if (posterFile) {
        const page = await openPage(htmlPath, { W: timing.W, H: timing.H, signal });
        try { await fsp.writeFile(stagedPoster, await page.capture(timing.scenes?.[7]?.start ?? timing.T * 0.55), { flag: "wx" }); }
        finally { await page.close(); }
      }
      const list = path.join(directory, "segments.txt");
      await fsp.writeFile(list, results.map(result => `file '${result.value.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
      const audioArgs = audioFile ? ["-i", audioFile, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "256k", "-shortest"] : ["-map", "0:v"];
      await ffmpeg.run(["-y", "-f", "concat", "-safe", "0", "-i", list, ...audioArgs,
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-profile:v", "high",
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-r", String(fps), "-movflags", "+faststart", stagedVideo], { signal });
      await commitOutputs([
        ...(posterFile ? [{ staged: stagedPoster, target: posterFile }] : []),
        { staged: stagedVideo, target: outFile }
      ], signal);
      return { frames, fps, subframes, workers: count };
    } finally {
      signal?.removeEventListener("abort", relay);
      await Promise.all([stagedVideo, stagedPoster].filter(Boolean).map(file => fsp.unlink(file).catch(() => {})));
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }

  return { SHUTTER, openPage, frameSpread, validate, contactSheet, renderVideo,
    shutdown: () => Promise.allSettled(Array.from(pages, page => page.close())) };
}

module.exports = { createRenderer, SHUTTER };
