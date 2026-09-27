"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createImageVideoMedia } = require("../Runtime/image-video-media.cjs");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "upstream/MotionBoardStudio-0.3.2");
const BUNDLED = path.join(ROOT, "dist/MotionBoard Studio 0.3.2-mac.3.app/Contents/MacOS/ffmpeg");
const binary = process.env.MOTION_BOARD_TEST_FFMPEG || BUNDLED;
const available = fs.existsSync(binary) && fs.existsSync(path.join(path.dirname(binary), "ffprobe"));
const digest = async file => createHash("sha256").update(await fsp.readFile(file)).digest("hex");

test("image video media rejects unsafe encoder and invalid local destinations", async () => {
  assert.throws(() => createImageVideoMedia({ sourceRoot: SOURCE, h264Encoder: "invalid" }), /인코더/);
  const media = createImageVideoMedia({ sourceRoot: SOURCE });
  await assert.rejects(media.prepareBoard({ entryId: "../escape", imagesDir: "/tmp/unused", boardPath: "/tmp/unused.png" }), /ID/);
  await assert.rejects(media.prepareBoard({ entryId: "entry", imagesDir: "relative", boardPath: "/tmp/unused.png" }), /절대/);
  await assert.rejects(media.probeClip("https://example.invalid/private.mp4"), /로컬/);
  await assert.rejects(media.assemble({ clips: [], workDir: "/tmp/unused" }), /1개/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.assemble({ clips: [{ path: "/tmp/unused.mp4" }], workDir: "/tmp/unused", signal: controller.signal }), { code: "CANCELLED" });
});

test("bundled FFmpeg crops actual board pixels and assembles actual animated clips", {
  skip: available ? false : "Bundled FFmpeg/ffprobe are unavailable; set MOTION_BOARD_TEST_FFMPEG to run local media integration.",
  timeout: 120000
}, async t => {
  const oldPath = process.env.MOTION_BOARD_FFMPEG;
  process.env.MOTION_BOARD_FFMPEG = binary;
  const ffmpeg = require(path.join(SOURCE, "lib/video/ffmpeg.cjs"));
  ffmpeg.locate({ refresh: true });
  t.after(() => {
    if (oldPath === undefined) delete process.env.MOTION_BOARD_FFMPEG;
    else process.env.MOTION_BOARD_FFMPEG = oldPath;
    ffmpeg.locate({ refresh: true });
  });
  const media = createImageVideoMedia({ sourceRoot: SOURCE, ffmpeg, h264Encoder: "h264_videotoolbox" });
  await fsp.mkdir(path.join(ROOT, ".local"), { recursive: true });
  const directory = await fsp.mkdtemp(path.join(ROOT, ".local/image-video-media-"));
  const imagesDir = path.join(directory, "images"), workDir = path.join(directory, "assembly");
  const receipt = { binary, directory, syntheticOnly: true, networkUsed: false, checks: [] };
  let passed = true;
  const verify = (name, action) => t.test(name, async () => {
    try { await action(); } catch (error) { passed = false; throw error; }
  });
  t.diagnostic(`Retained local media evidence: ${directory}`);
  const run = (args, options = {}) => ffmpeg.run(["-nostdin", ...args], options);
  const pixel = async (file, x, y, time) => [...await run([
    ...(time === undefined ? [] : ["-ss", String(time)]), "-i", file,
    "-vf", `format=rgb24,crop=1:1:${x}:${y}:exact=1`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"
  ])];
  const closeColor = (actual, expected, tolerance = 8) => {
    assert.equal(actual.length, 3);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${actual} differs from ${expected}`));
  };
  const boardPath = path.join(directory, "synthetic-board.png");
  const width = 1029, height = 773;
  const colors = Array.from({ length: 16 }, (_, i) => [30 + 11 * i, 210 - 7 * i, 50 + 5 * i]);
  const boardPixels = Buffer.alloc(width * height * 3);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const color = colors[row * 4 + column];
      for (let y = Math.floor(height * row / 4); y < Math.floor(height * (row + 1) / 4); y += 1) {
        for (let x = Math.floor(width * column / 4); x < Math.floor(width * (column + 1) / 4); x += 1) boardPixels.set(color, (y * width + x) * 3);
      }
    }
  }
  await run(["-n", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", "pipe:0",
    "-frames:v", "1", "-c:v", "png", "-update", "1", boardPath], { input: boardPixels });
  const boardHash = await digest(boardPath);
  let board;
  await verify("all 16 odd-sized cells retain row-major source pixels and immutable filenames", async () => {
    board = await media.prepareBoard({ boardPath, imagesDir, entryId: "synthetic-entry" });
    assert.equal(board.width, width); assert.equal(board.height, height); assert.equal(board.shots.length, 16);
    assert.equal(board.shots.reduce((sum, shot) => sum + shot.originalWidth * shot.originalHeight, 0), width * height);
    for (const shot of board.shots) {
      assert.ok(path.basename(shot.imagePath).startsWith("synthetic-entry-"));
      assert.ok(shot.width >= 512 && shot.height >= 512); assert.equal(shot.upscaled, true);
      assert.ok(Math.abs(shot.width / shot.height - shot.originalWidth / shot.originalHeight) < 0.003);
      closeColor(await pixel(shot.imagePath, Math.floor(shot.width / 2), Math.floor(shot.height / 2)), colors[shot.index], 0);
    }
    assert.equal(await digest(boardPath), boardHash);
    receipt.board = board;
    receipt.checks.push("16 actual crops, odd-dimension coverage, original pixels, 512px minimum, original preservation");
  });
  await verify("in-flight crop cancellation removes only the new run's files", async () => {
    const previous = await digest(board.shots[0].imagePath), controller = new AbortController();
    const cancelFFmpeg = { ...ffmpeg, run: async (args, options) => {
      const pending = ffmpeg.run(args, options), timer = setTimeout(() => controller.abort(), 2);
      try { return await pending; } finally { clearTimeout(timer); }
    } };
    const cancelling = createImageVideoMedia({ sourceRoot: SOURCE, ffmpeg: cancelFFmpeg, h264Encoder: "h264_videotoolbox" });
    await assert.rejects(cancelling.prepareBoard({ boardPath, imagesDir, entryId: "cancel-entry", signal: controller.signal }), { code: "CANCELLED" });
    assert.equal((await fsp.readdir(imagesDir)).filter(name => name.startsWith("cancel-entry-")).length, 0);
    assert.equal(await digest(board.shots[0].imagePath), previous); assert.equal(await digest(boardPath), boardHash);
    receipt.checks.push("actual crop cancellation preserves previous board/crops");
  });
  await verify("large transparent boards keep cell dimensions, alpha, and prior versions", async () => {
    const large = path.join(directory, "large-transparent-board.png");
    const rgba = Buffer.alloc(2048 * 2048 * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([50, 100, 150, 127], offset);
    await run(["-n", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "2048x2048", "-i", "pipe:0",
      "-frames:v", "1", "-c:v", "png", "-update", "1", large], { input: rgba });
    const previous = await digest(board.shots[0].imagePath);
    const next = await media.prepareBoard({ boardPath: large, imagesDir, entryId: "synthetic-entry" });
    for (const shot of next.shots) {
      assert.deepEqual([shot.width, shot.height, shot.originalWidth, shot.originalHeight, shot.upscaled], [512, 512, 512, 512, false]);
      assert.notEqual(shot.imagePath, board.shots[shot.index].imagePath);
    }
    const center = await run(["-i", next.shots[0].imagePath, "-vf", "format=rgba,crop=1:1:256:256:exact=1", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
    assert.deepEqual([...center], [50, 100, 150, 127]);
    assert.equal(await digest(board.shots[0].imagePath), previous);
    receipt.checks.push("large board retains dimensions/transparency, repeated preparation keeps earlier version");
  });
  async function animatedClip(name, W, H, background, foreground, audio) {
    const frames = [];
    for (let frame = 0; frame < 12; frame += 1) {
      const pixels = Buffer.alloc(W * H * 3), left = Math.round((W - 40) * frame / 11);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) pixels.set(x >= left && x < left + 36 && y >= 20 && y < 56 ? foreground : background, (y * W + x) * 3);
      }
      frames.push(pixels);
    }
    const file = path.join(directory, name + ".mp4");
    await run(["-n", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-framerate", "12", "-i", "pipe:0",
      ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []),
      "-map", "0:v:0", ...(audio ? ["-map", "1:a:0", "-c:a", "aac"] : ["-an"]),
      "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "1000000", "-pix_fmt", "yuv420p", "-t", "1", file
    ], { input: Buffer.concat(frames) });
    return file;
  }
  const firstClip = await animatedClip("portrait-red", 192, 288, [220, 30, 30], [30, 220, 40], true);
  const secondClip = await animatedClip("landscape-blue", 320, 120, [30, 40, 220], [230, 220, 30], false);
  let assembled;
  await verify("draft preserves moving subjects, clip order, letterboxing, trims and source audio", async () => {
    const progress = [];
    assembled = await media.assemble({ clips: [{ path: firstClip, duration: 0.5 }, { path: secondClip, duration: 0.5 }],
      aspectRatio: "1:1", quality: "draft", workDir, progress: value => progress.push(value) });
    const info = await media.probeClip(assembled.videoPath);
    assert.deepEqual([info.width, info.height, info.fps, info.hasAudio], [1440, 1440, 30, true]);
    assert.ok(Math.abs(info.duration - 1) < 0.01);
    assert.deepEqual([assembled.meta.frames, assembled.meta.T, assembled.meta.kind], [30, 1, "image_video"]);
    closeColor(await pixel(assembled.videoPath, 40, 720, 0.2), [0, 0, 0]);
    closeColor(await pixel(assembled.videoPath, 700, 720, 0.2), [220, 30, 30]);
    closeColor(await pixel(assembled.videoPath, 700, 40, 0.7), [0, 0, 0]);
    closeColor(await pixel(assembled.videoPath, 700, 900, 0.7), [30, 40, 220]);
    closeColor(await pixel(assembled.videoPath, 320, 180, 0), [30, 220, 40]);
    closeColor(await pixel(assembled.videoPath, 320, 180, 0.4), [220, 30, 30]);
    assert.equal(progress.at(-1).phase, "image_video_done");
    const composition = JSON.parse(await fsp.readFile(assembled.compositionPath, "utf8"));
    assert.deepEqual(composition.clips.map(clip => clip.source.fps), [12, 12]);
    assert.equal(composition.meta.frameRateConversion, "sample_or_repeat");
    const audio = await run(["-i", assembled.videoPath, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);
    const energy = (from, to) => {
      let sum = 0, count = 0;
      for (let offset = from * 48000 * 2; offset < Math.min(audio.length, to * 48000 * 2); offset += 2) { sum += audio.readInt16LE(offset) ** 2; count += 1; }
      return Math.sqrt(sum / count);
    };
    assert.ok(energy(0.1, 0.3) > 500); assert.ok(energy(0.7, 0.9) < 5);
    receipt.draft = { ...assembled, probe: info };
    receipt.checks.push("actual 30fps H264/AAC MP4, moving pixels, clip order, contain geometry, trims, source audio then silence");
  });
  await verify("final exports 60fps with honest source rates and loops local music", async () => {
    const musicFile = path.join(directory, "short-music.wav");
    await run(["-n", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "0.3", "-c:a", "pcm_s16le", musicFile]);
    const final = await media.assemble({ clips: [{ path: firstClip, duration: 0.25 }, { path: secondClip, duration: 2 }],
      aspectRatio: "16:9", quality: "final", musicFile, workDir });
    const info = await media.probeClip(final.videoPath);
    assert.deepEqual([info.width, info.height, info.fps, info.hasAudio], [1920, 1080, 60, true]);
    assert.equal(final.meta.T, 1.25); assert.equal(final.meta.frames, 75);
    assert.deepEqual(final.meta.sourceFPS, [12, 12]); assert.equal(final.meta.frameRateConversion, "sample_or_repeat");
    assert.notEqual(final.videoPath, assembled.videoPath);
    const audio = await run(["-ss", "0.8", "-i", final.videoPath, "-t", "0.1", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);
    let energy = 0;
    for (let offset = 0; offset < audio.length; offset += 2) energy += audio.readInt16LE(offset) ** 2;
    assert.ok(Math.sqrt(energy / (audio.length / 2)) > 500);
    receipt.final = { ...final, probe: info };
    receipt.checks.push("actual 60fps VideoToolbox, source fps recorded, short music loops, overlong trim clamps to source");
  });
  await verify("in-flight assembly cancellation preserves completed results and unrelated files", async () => {
    const oldVideo = await digest(assembled.videoPath), oldPoster = await digest(assembled.posterPath), existing = await fsp.readdir(workDir);
    const sentinel = path.join(workDir, "video.mp4"); await fsp.writeFile(sentinel, "prior user output", { flag: "wx" });
    const controller = new AbortController(); let timer;
    await assert.rejects(media.assemble({ clips: [{ path: firstClip, duration: 1 }], aspectRatio: "9:16", quality: "final", workDir,
      signal: controller.signal, progress: event => { if (event.phase === "image_video_assemble") timer = setTimeout(() => controller.abort(), 2); }
    }), { code: "CANCELLED" });
    clearTimeout(timer);
    assert.equal(await digest(assembled.videoPath), oldVideo); assert.equal(await digest(assembled.posterPath), oldPoster);
    assert.equal(await fsp.readFile(sentinel, "utf8"), "prior user output");
    assert.deepEqual((await fsp.readdir(workDir)).sort(), [...existing, "video.mp4"].sort());
    receipt.checks.push("actual in-flight assembly cancellation, completed/unrelated files preserved, partial run removed");
  });
  await verify("invalid video fails before producing an assembly", async () => {
    const invalid = path.join(directory, "invalid.mp4"); await fsp.writeFile(invalid, "not a video", { flag: "wx" });
    await assert.rejects(media.probeClip(invalid), /미디어/);
    receipt.checks.push("invalid container rejected by paired ffprobe");
  });
  receipt.passed = passed;
  await fsp.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
});
