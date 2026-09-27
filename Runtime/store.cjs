"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error("생성이 취소되었습니다."), { code: "CANCELLED" });
}
async function atomicWrite(file, data, { signal } = {}) {
  checkAbort(signal);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + crypto.randomUUID();
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync(); await handle.close(); handle = null;
    checkAbort(signal);
    await fsp.rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function createStore(userData) {
  const baseDir = path.join(path.resolve(userData), "motion-board");
  const imagesDir = path.join(baseDir, "images");
  const videosDir = path.join(baseDir, "videos");
  const musicCacheDir = path.join(baseDir, "music-cache");
  const trashDir = path.join(baseDir, "Trash");
  const historyFile = path.join(baseDir, "history.json");
  const stateFile = path.join(baseDir, "state.json");
  let queue = Promise.resolve();
  function identifier(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("잘못된 기록 ID입니다.");
    return id;
  }
  async function readJSON(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw new Error("저장된 데이터를 읽을 수 없습니다: " + path.basename(file), { cause: error }); }
  }
  async function rawHistory() {
    const entries = await readJSON(historyFile, []);
    if (!Array.isArray(entries)) throw new Error("생성 기록 형식이 잘못되었습니다. 기존 파일을 보존했습니다.");
    return entries;
  }
  function transaction(action) {
    const task = queue.then(action);
    queue = task.catch(() => {});
    return task;
  }
  const ensureDirs = () => Promise.all([imagesDir, videosDir, musicCacheDir].map(directory => fsp.mkdir(directory, { recursive: true })));
  async function readHistory() { await queue; return rawHistory(); }
  function addEntry(entry, options) {
    identifier(entry.id);
    return transaction(async () => {
      const entries = await rawHistory();
      if (entries.some(item => item.id === entry.id)) throw new Error("중복된 기록 ID입니다.");
      await atomicWrite(historyFile, JSON.stringify([entry, ...entries], null, 2), options);
      return entry;
    });
  }
  function updateEntry(id, patch, options) {
    identifier(id);
    return transaction(async () => {
      const entries = await rawHistory();
      const index = entries.findIndex(entry => entry.id === id);
      if (index < 0) throw new Error("기록을 찾을 수 없습니다.");
      entries[index] = { ...entries[index], ...patch, id, updatedAt: Date.now() };
      await atomicWrite(historyFile, JSON.stringify(entries, null, 2), options);
      return entries[index];
    });
  }
  function removeEntry(id) {
    identifier(id);
    return transaction(async () => {
      const entries = await rawHistory(), entry = entries.find(item => item.id === id);
      if (!entry) throw new Error("기록을 찾을 수 없습니다.");
      const destination = path.join(trashDir, Date.now() + "-" + id + "-" + crypto.randomUUID());
      await atomicWrite(path.join(destination, "entry.json"), JSON.stringify(entry, null, 2));
      const moved = [];
      try {
        const images = (await fsp.readdir(imagesDir).catch(error => { if (error.code === "ENOENT") return []; throw error; }))
          .filter(name => name.startsWith(id + "-") || name.startsWith(id + "."));
        const candidates = [...images.map(name => path.join(imagesDir, name)), path.join(videosDir, id)];
        for (const source of candidates) {
          try {
            const target = path.join(destination, path.basename(source));
            await fsp.rename(source, target); moved.push([source, target]);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        await atomicWrite(historyFile, JSON.stringify(entries.filter(item => item.id !== id), null, 2));
        return { trashPath: destination };
      } catch (error) {
        for (const [source, target] of moved.reverse()) await fsp.rename(target, source).catch(() => {});
        throw error;
      }
    });
  }
  function imagePathFor(id, extension = ".png") {
    identifier(id);
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("지원하지 않는 이미지 형식입니다.");
    return path.join(imagesDir, id + "-" + crypto.randomUUID() + extension);
  }
  function imageUrlForPath(file) {
    if (!file || path.dirname(path.resolve(file)) !== imagesDir) return "";
    return "studio-image://local/" + encodeURIComponent(path.basename(file));
  }
  function videoUrlFor(file) {
    if (!file) return "";
    const relative = path.relative(videosDir, path.resolve(file));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? "studio-video://local/" + relative.split(path.sep).map(encodeURIComponent).join("/") : "";
  }
  function resolveMedia(url) {
    let parsed, relative;
    try { parsed = new URL(url); relative = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")); } catch { return null; }
    if (parsed.hostname !== "local" || relative.includes("\0")) return null;
    const directory = parsed.protocol === "studio-image:" ? imagesDir : parsed.protocol === "studio-video:" ? videosDir : null;
    if (!directory) return null;
    const candidate = path.resolve(directory, relative);
    if (!candidate.startsWith(directory + path.sep) || !fs.existsSync(candidate)) return null;
    const real = fs.realpathSync(candidate);
    if (!real.startsWith(fs.realpathSync(directory) + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  }
  return { baseDir, imagesDir, videosDir, musicCacheDir, trashDir, historyFile, stateFile,
    ensureDirs, readHistory, addEntry, updateEntry, removeEntry, imagePathFor, imageUrlForPath, videoUrlFor, resolveMedia,
    videoDirFor: id => path.join(videosDir, identifier(id)),
    readState: () => readJSON(stateFile, {}),
    writeState: state => transaction(() => atomicWrite(stateFile, JSON.stringify(state, null, 2))),
    atomicWrite, flush: () => queue };
}

module.exports = { createStore, atomicWrite };
