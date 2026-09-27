"use strict";

// Local media work only. This module neither creates AI motion nor sends media
// to a provider: it preserves board pixels and assembles supplied video clips.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const CANVAS = { "1:1": [1440, 1440], "16:9": [1920, 1080], "9:16": [1080, 1920] };
const LOCAL_PROTOCOLS = ["-protocol_whitelist", "file,pipe"];

function cancelled() { return Object.assign(new Error("생성이 취소되었습니다."), { code: "CANCELLED" }); }
function checkAbort(signal) { if (signal?.aborted) throw cancelled(); }
function rate(value) {
  const parts = String(value || "").split("/").map(Number);
  const result = parts.length === 2 ? parts[0] / parts[1] : parts[0];
  return Number.isFinite(result) && result > 0 ? result : 0;
}
function report(progress, event) { try { progress?.(event); } catch {} }
async function localFile(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw new Error(`${label}의 로컬 파일 경로가 필요합니다.`);
  const stat = await fsp.stat(file);
  if (!stat.isFile() || !stat.size) throw new Error(`${label} 파일이 비어 있거나 읽을 수 없습니다.`);
  return file;
}

function createImageVideoMedia({ sourceRoot, ffmpeg: injectedFFmpeg,
  h264Encoder = process.env.MOTION_BOARD_H264_ENCODER || "libx264" }) {
  if (!["libx264", "h264_videotoolbox"].includes(h264Encoder)) throw new Error("지원하지 않는 H.264 인코더입니다.");
  const ffmpeg = injectedFFmpeg || require(path.join(sourceRoot, "lib/video/ffmpeg.cjs"));

  async function metadata(file, signal) {
    checkAbort(signal);
    await localFile(file, "미디어");
    const bin = ffmpeg.require();
    // Pair ffprobe with the selected FFmpeg rather than finding a different
    // installation on PATH. Bundled builds always provide both helpers.
    const ffprobe = path.join(path.dirname(bin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    await fsp.access(ffprobe, fs.constants.X_OK);
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, ["-v", "error", ...LOCAL_PROTOCOLS, "-show_streams", "-show_format", "-of", "json", file],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      let bytes = 0, failure = null, stderr = "";
      const stop = () => child.kill("SIGKILL");
      const timer = setTimeout(() => { failure = new Error("미디어 정보를 확인하는 시간이 초과되었습니다."); stop(); }, 30000);
      timer.unref?.();
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { failure = new Error("미디어 정보가 허용 크기를 초과했습니다."); stop(); }
        else chunks.push(chunk);
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
      child.on("error", error => { clean(); reject(signal?.aborted ? cancelled() : error); });
      child.on("close", code => {
        clean();
        if (signal?.aborted) return reject(cancelled());
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(`미디어 정보를 읽지 못했습니다: ${stderr.trim().slice(-500)}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("미디어 정보 형식이 잘못되었습니다.")); }
      });
    });
  }

  async function run(args, signal) {
    checkAbort(signal);
    const result = await ffmpeg.run(["-nostdin", ...args], { signal, maxBuffer: 1024 * 1024 });
    checkAbort(signal);
    return result;
  }

  async function prepareBoard({ boardPath, imagesDir, entryId, signal }) {
    checkAbort(signal);
    if (typeof entryId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(entryId)) throw new Error("잘못된 기록 ID입니다.");
    if (!path.isAbsolute(imagesDir || "")) throw new Error("이미지 저장 폴더의 절대 경로가 필요합니다.");
    const info = await metadata(boardPath, signal);
    const stream = info.streams?.find(item => item.codec_type === "video");
    const width = Number(stream?.width), height = Number(stream?.height);
    if (![width, height].every(value => Number.isInteger(value) && value >= 4 && value <= 16384)
      || width * height > 100_000_000 || !["png", "mjpeg", "webp", "bmp", "tiff"].includes(stream?.codec_name)) {
      throw new Error("지원하는 정지 보드 이미지(PNG, JPEG, WebP 등)가 필요합니다.");
    }
    await fsp.mkdir(imagesDir, { recursive: true });
    const shots = [], created = [], runId = randomUUID();
    try {
      for (let index = 0; index < 16; index += 1) {
        checkAbort(signal);
        const column = index % 4, row = Math.floor(index / 4);
        const x = Math.floor(width * column / 4), y = Math.floor(height * row / 4);
        const originalWidth = Math.floor(width * (column + 1) / 4) - x;
        const originalHeight = Math.floor(height * (row + 1) / 4) - y;
        const scale = Math.max(1, 512 / Math.min(originalWidth, originalHeight));
        const outputWidth = Math.round(originalWidth * scale), outputHeight = Math.round(originalHeight * scale);
        if (Math.max(outputWidth, outputHeight) > 8192) throw new Error("보드 장면의 가로세로 비율이 너무 큽니다.");
        const imagePath = path.join(imagesDir, `${entryId}-${runId}-shot-${String(index + 1).padStart(2, "0")}.png`);
        // Reserve the filename exclusively before allowing FFmpeg to fill it.
        // RGBA preserves transparency and avoids chroma rounding of odd cells.
        const handle = await fsp.open(imagePath, "wx", 0o600);
        await handle.close();
        created.push(imagePath);
        const filters = `format=rgba,crop=${originalWidth}:${originalHeight}:${x}:${y}:exact=1,scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1`;
        await run(["-y", ...LOCAL_PROTOCOLS, "-noautorotate", "-i", boardPath, "-map", "0:v:0", "-vf", filters,
          "-frames:v", "1", "-c:v", "png", "-update", "1", imagePath], signal);
        shots.push({ index, imagePath, width: outputWidth, height: outputHeight, originalWidth, originalHeight,
          upscaled: scale > 1, rect: { x, y, width: originalWidth, height: originalHeight } });
      }
      checkAbort(signal);
      return { width, height, shots };
    } catch (error) {
      // Only this invocation's new UUID filenames are eligible for cleanup.
      await Promise.all(created.map(file => fsp.unlink(file).catch(() => {})));
      throw error;
    }
  }

  async function probeClip(file, { signal } = {}) {
    const info = await metadata(file, signal);
    const stream = info.streams?.find(item => item.codec_type === "video" && !item.disposition?.attached_pic);
    let width = Number(stream?.width), height = Number(stream?.height);
    const streamDuration = Number(stream?.duration);
    const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(info.format?.duration);
    const fps = rate(stream?.avg_frame_rate) || rate(stream?.r_frame_rate);
    if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= 8192)
      || !Number.isFinite(duration) || duration < 0.05 || duration > 600 || fps < 1 || fps > 240) {
      throw new Error("재생 가능한 영상이 필요합니다 (최대 10분, 8192px, 240fps).");
    }
    // A container header alone is not evidence that its frames decode. Keep
    // inputs local even when a selected file is a playlist in disguise.
    await run(["-xerror", "-err_detect", "explode", ...LOCAL_PROTOCOLS, "-i", file,
      "-map", `0:${stream.index}`, "-an", "-f", "null", "-"], signal);
    const rotation = Number(stream.side_data_list?.find(item => Number.isFinite(item.rotation))?.rotation || stream.tags?.rotate || 0);
    if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
    const audio = info.streams.find(item => item.codec_type === "audio");
    return { width, height, duration, fps, hasAudio: Boolean(audio), videoStreamIndex: stream.index, audioStreamIndex: audio?.index ?? null };
  }

  async function assemble({ clips, aspectRatio = "1:1", quality = "final", musicFile, workDir, signal, progress }) {
    checkAbort(signal);
    if (!Array.isArray(clips) || clips.length < 1 || clips.length > 64) throw new Error("합칠 영상은 1개 이상 64개 이하여야 합니다.");
    if (!path.isAbsolute(workDir || "")) throw new Error("영상 작업 폴더의 절대 경로가 필요합니다.");
    const canvas = CANVAS[String(aspectRatio).replace(/\s+/g, "")];
    if (!canvas) throw new Error("영상 화면비는 1:1, 16:9, 9:16 중에서 선택해 주세요.");
    const [W, H] = canvas, fps = quality === "draft" ? 30 : 60;
    const plan = [];
    let frames = 0;
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      const source = await probeClip(clip?.path, { signal });
      const requestedDuration = clip.duration === undefined ? source.duration : Number(clip.duration);
      if (!Number.isFinite(requestedDuration) || requestedDuration <= 0 || requestedDuration > 600) throw new Error("장면 길이가 올바르지 않습니다.");
      const clipFrames = Math.floor(Math.min(requestedDuration, source.duration) * fps + 0.00001);
      if (clipFrames < 1) throw new Error("장면 길이가 한 프레임보다 짧습니다.");
      plan.push({ index, path: clip.path, source, requestedDuration, start: frames / fps, frames: clipFrames, duration: clipFrames / fps });
      frames += clipFrames;
      if (frames / fps > 3600) throw new Error("합성 영상의 길이는 1시간을 넘을 수 없습니다.");
      report(progress, { phase: "image_video_probe", done: index + 1, total: clips.length,
        message: `영상 확인 ${index + 1}/${clips.length}` });
    }
    const T = frames / fps;
    if (musicFile) {
      const music = await metadata(musicFile, signal);
      if (!music.streams?.some(item => item.codec_type === "audio")) throw new Error("음악 파일에 재생할 오디오가 없습니다.");
    }
    checkAbort(signal);
    await fsp.mkdir(workDir, { recursive: true });
    // Every result gets its own directory: a failed/cancelled rerun cannot
    // replace a previous finished video, poster, or composition.
    const outputDir = await fsp.mkdtemp(path.join(workDir, "image-video-"));
    const videoPath = path.join(outputDir, "video.mp4"), posterPath = path.join(outputDir, "poster.png");
    const compositionPath = path.join(outputDir, "composition.json");
    const stagedVideo = path.join(outputDir, ".video-in-progress.mp4");
    const stagedPoster = path.join(outputDir, ".poster-in-progress.png");
    let completed = false;
    try {
      const args = ["-n", "-filter_complex_threads", "2"];
      for (const clip of plan) args.push(...LOCAL_PROTOCOLS, "-threads", "2", "-i", clip.path);
      if (musicFile) args.push("-stream_loop", "-1", ...LOCAL_PROTOCOLS, "-i", musicFile);
      const filters = [];
      for (const clip of plan) {
        const i = clip.index, duration = clip.duration;
        // SAR correction preserves display geometry; scaling/padding never
        // crops subjects or stretches a portrait clip into a landscape canvas.
        filters.push(`[${i}:${clip.source.videoStreamIndex}]setpts=PTS-STARTPTS,scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1,` +
          `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `fps=${fps},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${clip.frames},setpts=N/(${fps}*TB),format=yuv420p[v${i}]`);
        filters.push(clip.source.hasAudio
          ? `[${i}:${clip.source.audioStreamIndex}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration},atrim=duration=${duration}[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`);
      }
      filters.push(plan.map(clip => `[v${clip.index}][a${clip.index}]`).join("") + `concat=n=${plan.length}:v=1:a=1[video][sourceAudio]`);
      let audioLabel = "sourceAudio";
      if (musicFile) {
        const hasSourceAudio = plan.some(clip => clip.source.hasAudio);
        filters.push(`[${plan.length}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=whole_dur=${T},atrim=duration=${T},volume=${hasSourceAudio ? 0.65 : 1}[music]`);
        filters.push(`[sourceAudio]volume=${hasSourceAudio ? 0.35 : 1}[quietSource]`);
        filters.push("[quietSource][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixedAudio]");
        audioLabel = "mixedAudio";
      }
      const videoArgs = h264Encoder === "h264_videotoolbox"
        ? ["-c:v", h264Encoder, "-allow_sw", "1", "-b:v", String(Math.max(2_000_000, Math.round(W * H * fps * (quality === "draft" ? 0.08 : 0.18)))), "-profile:v", "high"]
        : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high"];
      args.push("-filter_complex", filters.join(";"), "-map", "[video]", "-map", `[${audioLabel}]`, ...videoArgs,
        "-pix_fmt", "yuv420p", "-r", String(fps), "-frames:v", String(frames), "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", String(T), "-map_metadata", "-1", "-movflags", "+faststart", stagedVideo);
      report(progress, { phase: "image_video_assemble", done: 0, frames,
        message: `원본 장면 ${plan.length}개를 ${fps}fps 파일로 합치는 중…` });
      await run(args, signal);
      await run(["-n", ...LOCAL_PROTOCOLS, "-i", stagedVideo, "-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-update", "1", stagedPoster], signal);
      const meta = { W, H, T, fps, frames, kind: "image_video", sourceFPS: plan.map(clip => clip.source.fps),
        frameRateConversion: "sample_or_repeat", fit: "contain", clipCount: plan.length,
        audio: musicFile ? "music_and_source" : plan.some(clip => clip.source.hasAudio) ? "source" : "silence" };
      const composition = { version: 1, kind: "image_video", meta, clips: plan, musicFile: musicFile || null,
        encoder: h264Encoder, note: "Output fps resamples supplied frames. It does not generate additional AI motion." };
      await fsp.writeFile(compositionPath, JSON.stringify(composition, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      checkAbort(signal);
      fs.renameSync(stagedVideo, videoPath);
      fs.renameSync(stagedPoster, posterPath);
      completed = true;
      report(progress, { phase: "image_video_done", done: frames, frames, message: "이미지 활용 영상 합성 완료" });
      return { videoPath, posterPath, compositionPath, meta };
    } finally {
      if (!completed) {
        for (const file of [stagedVideo, stagedPoster, compositionPath, videoPath, posterPath]) await fsp.unlink(file).catch(() => {});
        await fsp.rmdir(outputDir).catch(() => {});
      }
    }
  }

  return { prepareBoard, probeClip, assemble };
}

module.exports = { createImageVideoMedia };
