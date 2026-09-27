'use strict';

// Mixkit 음악 자동 탐색. 페이지에 들어 있는 JSON-LD(ItemList → MusicRecording)에서
// 곡명·아티스트·길이·라이선스·mp3 주소를 읽는다. "Mixkit Stock Music Free License" 곡만 쓴다.
// 곡 전체가 아니라 앞부분(기본 2.5MB, 128kbps 기준 약 2분 40초)만 받아 캐시한다.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const BASE = 'https://mixkit.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MotionBoardStudio/0.2';
const HEAD_BYTES = 2.5 * 1024 * 1024;
const LICENSE_URL = 'https://mixkit.co/license/#musicFree';
const FALLBACK_PAGES = ['/free-stock-music/cinematic/', '/free-stock-music/corporate-music/', '/free-stock-music/electronic/', '/free-stock-music/ambient/'];

function isoDurationSec(value) {
  const m = String(value || '').match(/^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

// HTML 에서 MusicRecording 목록을 뽑는다.
function parseListing(html, pageUrl = '') {
  const tracks = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const nodes = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
    for (const node of nodes) {
      if (node?.['@type'] !== 'ItemList' || !Array.isArray(node.itemListElement)) continue;
      for (const item of node.itemListElement) {
        if (item?.['@type'] !== 'MusicRecording') continue;
        const url = String(item.url || '');
        const id = (url.match(/\/music\/(\d+)\/\1\.mp3$/) || [])[1];
        if (!id) continue;
        tracks.push({
          id,
          title: String(item.name || '').trim(),
          artist: String(item.byArtist?.name || item.byArtist || '').trim(),
          genre: String(item.genre || '').trim(),
          durationSec: isoDurationSec(item.duration),
          mp3: url,
          license: String(item.copyrightNotice || '').trim(),
          licenseUrl: String(item.license || LICENSE_URL),
          page: pageUrl
        });
      }
    }
  }
  return tracks;
}

function isFreeLicense(track) {
  return /free license/i.test(track.license) && !/restricted/i.test(track.license);
}

// 제작 명세 YAML 의 music.search_terms 를 읽는다(인라인 배열/블록 목록 모두).
function searchTermsFromYaml(yaml) {
  const text = String(yaml || '');
  const inline = text.match(/search_terms:\s*\[([^\]]*)\]/);
  const terms = [];
  if (inline) {
    for (const part of inline[1].split(',')) {
      const v = part.trim().replace(/^["']|["']$/g, '').trim();
      if (v) terms.push(v);
    }
  } else {
    const block = text.match(/search_terms:\s*\n((?:\s+-\s+.*\n?)+)/);
    if (block) {
      for (const line of block[1].split('\n')) {
        const v = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '').trim();
        if (v) terms.push(v);
      }
    }
  }
  return terms.filter((t) => /[a-z]/i.test(t)).slice(0, 6);
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pagesForTerms(terms) {
  const pages = [];
  const push = (p) => { if (p && !pages.includes(p)) pages.push(p); };
  for (const term of terms) push(`/free-stock-music/discover/${slug(term)}/`);
  for (const term of terms) {
    for (const word of slug(term).split('-')) if (word.length >= 3) push(`/free-stock-music/discover/${word}/`);
  }
  for (const page of FALLBACK_PAGES) push(page);
  return pages;
}

async function fetchText(url, { signal, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Mixkit 페이지 요청 실패 (${res.status}): ${url}`);
  return res.text();
}

async function search(terms, { minDurationSec = 0, limit = 18, maxPages = 8, signal, fetchImpl, onPage } = {}) {
  const seen = new Map();
  let fetched = 0;
  for (const page of pagesForTerms(terms)) {
    if (seen.size >= limit || fetched >= maxPages) break;
    const url = BASE + page;
    let html;
    try {
      html = await fetchText(url, { signal, fetchImpl });
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    } finally {
      fetched += 1;
    }
    const found = parseListing(html, url).filter((t) => isFreeLicense(t) && t.durationSec >= minDurationSec);
    try { onPage?.({ url, count: found.length }); } catch {}
    for (const track of found) if (!seen.has(track.id)) seen.set(track.id, track);
  }
  return [...seen.values()].slice(0, limit);
}

// 앞부분만 받는다(Range). 서버가 Range 를 무시하면 필요한 만큼 읽고 끊는다.
async function downloadHead(track, cacheDir, { bytes = HEAD_BYTES, signal, fetchImpl = fetch } = {}) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `mixkit-${track.id}.mp3`);
  const meta = `${file}.json`;
  if (fs.existsSync(file) && fs.statSync(file).size > 64 * 1024) return file;
  const res = await fetchImpl(track.mp3, { headers: { 'user-agent': UA, range: `bytes=0-${bytes - 1}` }, signal });
  if (!res.ok && res.status !== 206) throw new Error(`음악 다운로드 실패 (${res.status}): ${track.title}`);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < bytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    Promise.resolve(reader.cancel()).catch(() => {});
  }
  const tmp = `${file}.part`;
  await fsp.writeFile(tmp, Buffer.concat(chunks).subarray(0, bytes));
  await fsp.rename(tmp, file);
  await fsp.writeFile(meta, JSON.stringify(track, null, 2)).catch(() => {});
  return file;
}

// 후보 점수: 비트 명료도 × 템포 선호(90~140 BPM 우대) × 지터 페널티.
function scoreCandidate(analysis) {
  if (!analysis || !Number.isFinite(analysis.bpm)) return -1;
  const bpm = analysis.bpm;
  const tempo = bpm >= 90 && bpm <= 140 ? 1 : bpm >= 80 && bpm <= 160 ? 0.85 : 0.6;
  const jitter = Number.isFinite(analysis.jitterMs) ? Math.max(0.4, 1 - Math.max(0, analysis.jitterMs - 3) / 20) : 0.4;
  return analysis.clarity * tempo * jitter;
}

module.exports = {
  BASE,
  LICENSE_URL,
  HEAD_BYTES,
  isoDurationSec,
  parseListing,
  isFreeLicense,
  searchTermsFromYaml,
  pagesForTerms,
  search,
  downloadHead,
  scoreCandidate
};
