'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// 생성 기록(히스토리)과 보드 이미지를 userData 아래에 저장한다.
// history.json 은 최신 항목이 앞에 오는 배열이다.

const MAX_ENTRIES = 60;

function baseDir(userData) {
  return path.join(userData, 'motion-board');
}

function imagesDir(userData) {
  return path.join(baseDir(userData), 'images');
}

// 영상 작업 폴더: videos/<기록 id>/ (composition.html, mix.wav, video.mp4, poster.png, video.json)
function videosDir(userData) {
  return path.join(baseDir(userData), 'videos');
}

function videoDirFor(userData, id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!safe) throw new Error('잘못된 기록 id 입니다.');
  return path.join(videosDir(userData), safe);
}

function musicCacheDir(userData) {
  return path.join(baseDir(userData), 'music-cache');
}

function historyFile(userData) {
  return path.join(baseDir(userData), 'history.json');
}

async function ensureDirs(userData) {
  await fsp.mkdir(imagesDir(userData), { recursive: true });
}

async function readHistory(userData) {
  try {
    const raw = await fsp.readFile(historyFile(userData), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(userData, entries) {
  await ensureDirs(userData);
  await fsp.writeFile(historyFile(userData), JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
}

async function addEntry(userData, entry) {
  const entries = await readHistory(userData);
  entries.unshift(entry);
  await writeHistory(userData, entries);
  return entry;
}

async function updateEntry(userData, id, patch) {
  const entries = await readHistory(userData);
  const index = entries.findIndex((item) => item.id === id);
  if (index < 0) return null;
  entries[index] = { ...entries[index], ...patch, updatedAt: Date.now() };
  await writeHistory(userData, entries);
  return entries[index];
}

async function removeEntry(userData, id, imagePath = '') {
  const entries = await readHistory(userData);
  const next = entries.filter((item) => item.id !== id);
  await writeHistory(userData, next);
  const candidates = [imagePath, imagePathFor(userData, id)];
  for (const file of candidates) {
    if (!file) continue;
    try { await fsp.rm(file, { force: true }); } catch {}
  }
  try { await fsp.rm(videoDirFor(userData, id), { recursive: true, force: true }); } catch {}
}

function stateFile(userData) {
  return path.join(baseDir(userData), 'state.json');
}

async function readState(userData) {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile(userData), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(userData, state) {
  await ensureDirs(userData);
  await fsp.writeFile(stateFile(userData), JSON.stringify(state, null, 2));
}

function imagePathFor(userData, id) {
  return path.join(imagesDir(userData), `${id}.png`);
}

function imageUrlFor(id) {
  return `studio-image://local/${encodeURIComponent(`${id}.png`)}`;
}

// 저장된 실제 파일명 그대로 URL을 만든다(가져온 jpg/webp 등 확장자 유지).
function imageUrlForPath(imagePath) {
  const name = path.basename(String(imagePath || ''));
  return name ? `studio-image://local/${encodeURIComponent(name)}` : '';
}

// studio-image:// 프로토콜 요청 경로가 images 디렉터리를 벗어나지 않게 검증한다.
function resolveImageFile(userData, urlPath) {
  const decoded = decodeURIComponent(String(urlPath || '').replace(/^\/+/, ''));
  if (!decoded || decoded.includes('\0')) return null;
  const dir = imagesDir(userData);
  const resolved = path.resolve(dir, decoded);
  const boundary = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(boundary)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

// studio-video://local/<id>/<파일> 요청이 videos 폴더를 벗어나지 않게 검증한다.
function resolveVideoFile(userData, urlPath) {
  const decoded = decodeURIComponent(String(urlPath || '').replace(/^\/+/, ''));
  if (!decoded || decoded.includes('\0')) return null;
  const dir = videosDir(userData);
  const resolved = path.resolve(dir, decoded);
  const boundary = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(boundary)) return null;
  if (!/\.(mp4|png|jpg|html)$/i.test(resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function videoUrlFor(filePath, userData) {
  if (!filePath) return '';
  const rel = path.relative(videosDir(userData), filePath).split(path.sep).map(encodeURIComponent).join('/');
  return rel && !rel.startsWith('..') ? `studio-video://local/${rel}` : '';
}

module.exports = {
  MAX_ENTRIES,
  baseDir,
  imagesDir,
  videosDir,
  videoDirFor,
  musicCacheDir,
  resolveVideoFile,
  videoUrlFor,
  historyFile,
  ensureDirs,
  stateFile,
  readState,
  writeState,
  readHistory,
  writeHistory,
  addEntry,
  updateEntry,
  removeEntry,
  imagePathFor,
  imageUrlFor,
  imageUrlForPath,
  resolveImageFile
};
