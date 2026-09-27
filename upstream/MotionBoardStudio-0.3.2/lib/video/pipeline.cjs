'use strict';

// 영상 한 번에 만들기: 음악 → 비트 그리드 → LLM 모션 코드 → 실행 검증/자동 수정 → 비트 프레임 점검
// → 모션 블러 렌더 → 효과음 믹스 → MP4. LLM 호출·이미지 로드·렌더러는 호출자가 주입한다.

const fsp = require('fs/promises');
const path = require('path');
const audio = require('./audio.cjs');
const compose = require('./compose.cjs');
const direction = require('./script.cjs');
const mixkit = require('./mixkit.cjs');
const ffmpeg = require('./ffmpeg.cjs');
const { extractJson } = require('../codex.cjs');

const FPS = 60;
const DEFAULT_BPM = 120;
const MAX_REPAIRS = 2;
const FALLBACK_TERMS = ['cinematic', 'uplifting', 'corporate'];

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('생성이 취소되었습니다.');
    error.code = 'CANCELLED';
    throw error;
  }
}

// Mixkit 후보 몇 곡의 앞부분을 받아 실측하고, 비트가 가장 또렷한 곡을 고른다.
async function pickMixkitTrack({ entry, durationSec, cacheDir, signal, progress, fetchImpl }) {
  const terms = mixkit.searchTermsFromYaml(entry.yaml);
  const useTerms = terms.length ? terms : FALLBACK_TERMS;
  progress({ phase: 'music_search', message: `Mixkit에서 음악 후보를 찾는 중… (검색어: ${useTerms.join(', ')})` });
  const candidates = await mixkit.search(useTerms, { minDurationSec: durationSec + 25, signal, fetchImpl });
  if (!candidates.length) throw new Error('Mixkit에서 조건(무료 라이선스·충분한 길이)에 맞는 곡을 찾지 못했습니다.');
  const evaluated = [];
  for (const track of candidates.slice(0, 5)) {
    checkAbort(signal);
    progress({ phase: 'music_analyze', message: `후보 분석 중: "${track.title}" — ${track.artist || ''}` });
    try {
      const file = await mixkit.downloadHead(track, cacheDir, { signal, fetchImpl });
      const analysis = await audio.analyzeFile(file, { signal });
      evaluated.push({ track, file, analysis, score: mixkit.scoreCandidate(analysis) });
    } catch (error) {
      if (signal?.aborted) throw error;
      progress({ phase: 'music_analyze', message: `  건너뜀(${track.title}): ${error.message}` });
    }
  }
  if (!evaluated.length) throw new Error('음악 후보를 내려받거나 분석하지 못했습니다.');
  evaluated.sort((a, b) => b.score - a.score);
  const best = evaluated[0];
  progress({
    phase: 'music_pick',
    message: `음악 선택: "${best.track.title}" (${best.analysis.bpm.toFixed(2)} BPM, 비트 지터 ${best.analysis.jitterMs.toFixed(1)}ms) — 후보 ${evaluated.length}곡 중 비트가 가장 또렷한 곡`
  });
  return {
    file: best.file,
    analysis: best.analysis,
    meta: {
      source: 'mixkit', title: best.track.title, artist: best.track.artist, genre: best.track.genre,
      mp3: best.track.mp3, page: best.track.page, license: best.track.license, licenseUrl: best.track.licenseUrl,
      bpm: best.analysis.bpm, jitterMs: best.analysis.jitterMs, candidates: evaluated.map((e) => ({ title: e.track.title, bpm: Number(e.analysis.bpm.toFixed(2)), score: Number(e.score.toFixed(2)) }))
    }
  };
}

async function prepareMusic({ entry, options, durationSec, cacheDir, signal, progress, fetchImpl }) {
  const source = options.musicSource || 'mixkit';
  if (source === 'none') return null;
  if (source === 'file') {
    if (!options.musicFile) throw new Error('사용할 음악 파일을 선택해 주세요.');
    progress({ phase: 'music_analyze', message: `음악 파일 분석 중: ${path.basename(options.musicFile)}` });
    const analysis = await audio.analyzeFile(options.musicFile, { signal });
    return {
      file: options.musicFile,
      analysis,
      meta: { source: 'file', title: path.basename(options.musicFile), artist: '', license: '사용자 제공 파일 — 사용 권한은 직접 확인', bpm: analysis.bpm, jitterMs: analysis.jitterMs }
    };
  }
  try {
    return await pickMixkitTrack({ entry, durationSec, cacheDir, signal, progress, fetchImpl });
  } catch (error) {
    if (signal?.aborted) throw error;
    progress({ phase: 'music_pick', message: `음악 자동 선택 실패 — 효과음만으로 진행합니다: ${error.message}` });
    return { failed: error.message };
  }
}

function extractCode(text) {
  return compose.parseCompose(text);
}

async function askCode({ llm, instructions, userText, images, phase, progress, signal }) {
  checkAbort(signal);
  const result = await llm({ instructions, userText, images, phase, directive: compose.OUTPUT_DIRECTIVE });
  return { parsed: extractCode(result.content), model: result.model };
}

/* ---------------- 디자인 엔진 방식(기본): 모델은 연출 스크립트만, 렌더는 엔진 ---------------- */

async function askScript({ llm, instructions, userText, images, phase, signal }) {
  checkAbort(signal);
  const result = await llm({ instructions, userText, images, phase, directive: direction.DIRECTION_DIRECTIVE });
  let raw;
  try {
    raw = extractJson(result.content);
  } catch {
    const error = new Error('연출 스크립트(JSON)를 응답에서 찾지 못했습니다.');
    error.code = 'SCRIPT_PARSE';
    throw error;
  }
  return { raw, model: result.model };
}

// 스크립트 정규화 → 금지 문구·구조 문제는 모델에 돌려보내 고친다(최대 MAX_REPAIRS 회).
async function settleScript({ raw, timing, llm, instructions, progress, signal }) {
  let current = raw;
  for (let attempt = 0; ; attempt += 1) {
    let normalized;
    try {
      normalized = direction.normalizeScript(current, { T: timing.T, beat: timing.beat });
    } catch (error) {
      normalized = { fatal: error.message, problems: [error.message] };
    }
    if (!normalized.fatal && !normalized.problems.length) return { ...normalized, raw: current, repairs: attempt };
    progress({ phase: 'script_fix', message: `연출 스크립트 문제 ${normalized.problems.length}건: ${normalized.problems[0]}` });
    if (attempt >= MAX_REPAIRS) {
      if (!normalized.fatal) return { ...normalized, raw: current, repairs: attempt, unresolved: normalized.problems };
      throw new Error(`연출 스크립트를 만들지 못했습니다: ${normalized.problems.slice(0, 2).join(' / ')}`);
    }
    const fixed = await askScript({ llm, instructions, userText: direction.buildScriptRepairMessage({ raw: current, problems: normalized.problems }), phase: 'script_fix', signal });
    current = fixed.raw;
  }
}

// 금지 문구가 끝까지 남으면 해당 필드를 비워 화면에 나오지 않게 한다(마지막 안전장치).
function scrubForbidden(script) {
  const bad = (s) => direction.FORBIDDEN.some((f) => f.re.test(String(s || '')));
  for (const sh of script.shots) {
    for (const key of ['kicker', 'sub', 'caption', 'by']) if (bad(sh[key])) sh[key] = '';
    for (const key of ['lines', 'words', 'items', 'labels']) if (Array.isArray(sh[key])) sh[key] = sh[key].filter((s) => !bad(s));
    for (const key of ['text', 'a', 'b']) if (bad(sh[key])) sh[key] = sh.type === 'marquee' || sh.type === 'pattern' ? script.title || ' ' : ' ';
  }
  script.shots = script.shots.filter((sh) => !['lines', 'words', 'items'].some((k) => Array.isArray(sh[k]) && !sh[k].length));
  return script;
}

async function writeEngineComposition(workDir, script, timing) {
  const htmlPath = path.join(workDir, 'composition.html');
  await fsp.writeFile(htmlPath, direction.buildEngineShell({ script, timing }), 'utf8');
  await fsp.writeFile(path.join(workDir, 'direction.json'), JSON.stringify(script, null, 2), 'utf8');
  return htmlPath;
}

async function directWithEngine({ entry, timing, music, images, workDir, renderer, llm, loadImage, options, progress, signal, notes }) {
  const instructions = direction.loadDirectionGuide();
  progress({ phase: 'direct', message: images.length ? '보드 이미지와 명세로 연출 스크립트를 짜는 중…' : '명세로 바로 연출 스크립트를 짜는 중…' });
  const userText = direction.buildDirectionMessage({ entry, timing, music: music ? music.meta : null, hasImage: images.length > 0 });
  let first;
  try {
    first = await askScript({ llm, instructions, userText, images, phase: 'direct', signal });
  } catch (error) {
    if (error.code !== 'SCRIPT_PARSE') throw error;
    progress({ phase: 'direct', message: '응답 형식 오류 — 한 번 더 요청합니다.' });
    first = await askScript({ llm, instructions, userText: `${userText}\n\n[주의] 직전 응답에 JSON이 없었다. JSON 객체 하나만 출력하라.`, images, phase: 'direct', signal });
  }
  let settled = await settleScript({ raw: first.raw, timing, llm, instructions, progress, signal });
  if (settled.unresolved) notes.push(`일부 문구를 자동으로 비웠습니다: ${settled.unresolved.slice(0, 2).join(' / ')}`);
  let script = scrubForbidden(settled.script);
  let htmlPath = await writeEngineComposition(workDir, script, timing);
  progress({ phase: 'validate', message: `엔진 렌더 검증 중… (장면 ${script.shots.length}개: ${script.shots.map((s) => s.type).join(' → ')})` });
  let check = await renderer.validate(htmlPath, timing, { signal });
  if (!check.ok) throw new Error(`디자인 엔진 검증 실패: ${check.problems.slice(0, 3).join(' / ')}`);

  let reviewed = false;
  if (options.review !== false) {
    checkAbort(signal);
    progress({ phase: 'review', message: '엔진으로 비트 프레임을 렌더해 모델이 연출을 점검하는 중…' });
    const times = reviewTimes(timing);
    const sheet = path.join(workDir, 'review-sheet.jpg');
    await renderer.contactSheet(htmlPath, timing, sheet, { times, signal });
    try {
      const answer = await askScript({
        llm, instructions,
        userText: direction.buildScriptReviewMessage({ script, samples: times, timing }),
        images: [await loadImage(sheet)],
        phase: 'review', signal
      });
      if (answer.raw && answer.raw.ok === true && !Array.isArray(answer.raw.shots)) {
        progress({ phase: 'review', message: '점검 결과 연출을 그대로 유지합니다.' });
      } else {
        const next = direction.normalizeScript(answer.raw, { T: timing.T, beat: timing.beat });
        if (next.problems.length) {
          notes.push(`점검 수정본에 문제가 있어 이전 연출을 유지: ${next.problems[0]}`);
        } else {
          const candidate = scrubForbidden(next.script);
          const candidatePath = await writeEngineComposition(workDir, candidate, timing);
          const candidateCheck = await renderer.validate(candidatePath, timing, { signal });
          if (candidateCheck.ok) {
            script = candidate; htmlPath = candidatePath; check = candidateCheck; reviewed = true;
            progress({ phase: 'review', message: `점검 결과를 반영했습니다 (장면 ${script.shots.length}개).` });
          } else {
            await writeEngineComposition(workDir, script, timing);
            notes.push('점검 수정본이 검증을 통과하지 못해 이전 연출을 유지했습니다.');
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      notes.push(`연출 점검 단계 건너뜀: ${error.message}`);
    }
  }
  return {
    htmlPath, check, reviewed, repairs: settled.repairs, model: first.model,
    notesFromCode: [],
    summary: { engine: 'direct', title: script.title, mood: script.mood, shots: script.shots.map((s) => s.type), fonts: script.fonts, palette: script.palette }
  };
}

async function writeComposition(workDir, parts, timing) {
  const html = compose.buildShell({ parts, timing });
  const htmlPath = path.join(workDir, 'composition.html');
  await fsp.writeFile(htmlPath, html, 'utf8');
  await fsp.writeFile(path.join(workDir, 'composition.parts.json'), JSON.stringify(parts, null, 2), 'utf8');
  return htmlPath;
}

// 실행 검증 → 오류면 LLM 에 돌려보내 수정(최대 MAX_REPAIRS 회).
async function validateAndRepair({ parts, timing, workDir, renderer, llm, instructions, progress, signal }) {
  let current = parts;
  for (let attempt = 0; ; attempt += 1) {
    const htmlPath = await writeComposition(workDir, current, timing);
    progress({ phase: 'validate', message: attempt ? `수정된 코드를 다시 검증하는 중… (${attempt}/${MAX_REPAIRS})` : '영상 코드를 실행해 검증하는 중…' });
    const check = await renderer.validate(htmlPath, timing, { signal });
    if (check.ok) return { parts: current, htmlPath, check, repairs: attempt };
    progress({ phase: 'validate', message: `검증 문제 ${check.problems.length}건: ${check.problems[0]}` });
    if (attempt >= MAX_REPAIRS) {
      const error = new Error(`영상 코드가 검증을 통과하지 못했습니다: ${check.problems.slice(0, 3).join(' / ')}`);
      error.problems = check.problems;
      throw error;
    }
    progress({ phase: 'repair', message: '오류를 모델에 돌려보내 코드를 고치는 중…' });
    const fixed = await askCode({ llm, instructions, userText: compose.buildRepairMessage({ code: current, errors: check.problems }), phase: 'repair', progress, signal });
    if (fixed.parsed.ok) throw new Error('수정 요청에 코드 대신 확인 응답이 왔습니다.');
    current = fixed.parsed;
  }
}

function reviewTimes(timing, count = 24) {
  const beats = Math.round(timing.T / timing.beat);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const b = Math.floor((i * beats) / count);
    out.push(Math.min(timing.T - 0.01, (b + 0.35) * timing.beat));
  }
  return out;
}

async function runVideo({ entry, options = {}, workDir, cacheDir, llm, loadImage, renderer, progress = () => {}, signal, fetchImpl }) {
  const started = Date.now();
  ffmpeg.require();
  await fsp.mkdir(workDir, { recursive: true });
  const [W, H] = compose.canvasFor(entry.input?.aspectRatio);
  const durationSec = Math.max(8, Math.min(90, Number(entry.input?.durationSeconds) || 30));
  const notes = [];

  // 1) 음악과 비트 그리드
  const music = await prepareMusic({ entry, options, durationSec, cacheDir, signal, progress, fetchImpl });
  if (music?.failed) notes.push(`음악 자동 선택 실패로 효과음만 사용: ${music.failed}`);
  const hasMusic = Boolean(music && !music.failed);
  const bpm = hasMusic ? music.analysis.bpm : Number(options.bpm) || DEFAULT_BPM;
  const bars = audio.barsFor(durationSec, bpm);
  const frames = Math.round(((bars * 4 * 60) / bpm) * FPS);
  const T = frames / FPS;
  const beat = 60 / bpm;
  const timing = { T, fps: FPS, W, H, bpm, beat, bars, title: entry.title, scenes: compose.sceneWindows({ yaml: entry.yaml, loopSec: T, beatSec: beat }) };
  progress({ phase: 'timing', message: `비트 그리드: ${bpm.toFixed(2)} BPM × ${bars}마디 = ${T.toFixed(2)}초 (${frames}프레임 @${FPS}fps)` });

  // 2) 영상 설계: 디자인 엔진(기본 — 모델은 연출 스크립트만) 또는 자유 코드(실험 — 모델이 코드 전체를 씀)
  const images = [];
  if (entry.imagePath && options.useBoardImage !== false) {
    try { images.push(await loadImage(entry.imagePath)); } catch (error) { notes.push(`보드 이미지를 참고로 첨부하지 못함: ${error.message}`); }
  }
  const engineMode = options.engine === 'code' ? 'code' : 'direct';
  const result = engineMode === 'direct'
    ? await directWithEngine({ entry, timing, music: hasMusic ? music : null, images, workDir, renderer, llm, loadImage, options, progress, signal, notes })
    : await codeWithLlm({ entry, timing, music: hasMusic ? music : null, images, workDir, renderer, llm, loadImage, options, progress, signal, notes });
  const reviewed = result.reviewed;

  // 4) 오디오: 음악 루프 + 효과음(측정 피크 정렬, 원형 믹스)
  checkAbort(signal);
  progress({ phase: 'audio', message: '음악 루프를 자르고 효과음을 합성해 믹스하는 중…' });
  let loop = null;
  if (hasMusic) loop = await audio.cutLoop(music.file, music.analysis, { loopSec: T, bars, signal });
  const mixed = audio.mixLoop({ music: loop?.samples || null, loopSec: T, sfx: result.check.sfx });
  const audioFile = path.join(workDir, 'mix.wav');
  await fsp.writeFile(audioFile, audio.wavBuffer(mixed.samples));

  // 5) 렌더 + 인코딩
  const quality = options.quality === 'draft' ? 'draft' : 'final';
  const outFile = path.join(workDir, 'video.mp4');
  const posterFile = path.join(workDir, 'poster.png');
  const renderStart = Date.now();
  progress({ phase: 'render', message: quality === 'draft' ? '미리보기 렌더(30fps) 시작…' : '최종 렌더(60fps · 4 서브프레임 모션 블러) 시작…' });
  const rendered = await renderer.renderVideo(result.htmlPath, timing, {
    outFile, audioFile, posterFile, quality, signal,
    onProgress: ({ done, frames: total }) => progress({ phase: 'render', done, total, message: `렌더 중… ${done}/${total} 프레임 (${Math.round((done / total) * 100)}%)` })
  });

  const meta = {
    width: W, height: H, T, fps: rendered.fps, frames: rendered.frames, subframes: rendered.subframes, bars, bpm,
    music: hasMusic ? { ...music.meta, loopStartSec: loop.startSec, loopStartBar: loop.startBar } : null,
    sfxCount: mixed.placed.length,
    usedBoardImage: images.length > 0,
    reviewed,
    repairs: result.repairs,
    renderSeconds: Math.round((Date.now() - renderStart) / 1000),
    totalSeconds: Math.round((Date.now() - started) / 1000),
    engine: engineMode,
    direction: result.summary || null,
    codeNotes: result.notesFromCode || [],
    notes
  };
  await fsp.writeFile(path.join(workDir, 'video.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { videoPath: outFile, posterPath: posterFile, compositionPath: result.htmlPath, meta, model: result.model };
}

/* ---------------- 자유 코드 방식(실험): 모델이 모션 코드 전체를 쓴다 ---------------- */
async function codeWithLlm({ entry, timing, music, images, workDir, renderer, llm, loadImage, options, progress, signal, notes }) {
  const instructions = compose.loadGuide();
  progress({ phase: 'compose', message: images.length ? '보드 이미지와 명세를 바탕으로 모션 코드를 작성하는 중… (수 분 걸릴 수 있음)' : '명세만으로 바로 모션 코드를 작성하는 중… (수 분 걸릴 수 있음)' });
  const userText = compose.buildComposeUserMessage({ entry, timing, music: music ? music.meta : null, hasImage: images.length > 0 });
  let first;
  try {
    first = await askCode({ llm, instructions, userText, images, phase: 'compose', progress, signal });
  } catch (error) {
    if (signal?.aborted || error.code === 'CANCELLED' || !/<mk-js>|MK\.define|코드/.test(error.message)) throw error;
    progress({ phase: 'compose', message: `출력 형식 오류 — 다시 요청합니다: ${error.message}` });
    first = await askCode({ llm, instructions, userText: `${userText}\n\n[주의] 직전 응답이 형식 오류였다(${error.message}). 태그 형식을 정확히 지켜라.`, images, phase: 'compose', progress, signal });
  }
  if (first.parsed.ok) throw new Error('모델이 코드 대신 확인 응답만 보냈습니다. 다시 시도해 주세요.');
  let result = await validateAndRepair({ parts: first.parsed, timing, workDir, renderer, llm, instructions, progress, signal });

  // 비트 프레임 점검(선택): 실제 렌더한 프레임 시트를 모델이 보고 한 번 고친다.
  let reviewed = false;
  if (options.review !== false) {
    checkAbort(signal);
    progress({ phase: 'review', message: '비트 프레임을 렌더해 모델이 점검하는 중…' });
    const times = reviewTimes(timing);
    const sheet = path.join(workDir, 'review-sheet.jpg');
    await renderer.contactSheet(result.htmlPath, timing, sheet, { times, signal });
    const answer = await askCode({
      llm, instructions,
      userText: compose.buildReviewMessage({ code: result.parts, samples: times, timing }),
      images: [await loadImage(sheet)],
      phase: 'review', progress, signal
    }).catch((error) => {
      if (signal?.aborted) throw error;
      notes.push(`프레임 점검 단계 건너뜀: ${error.message}`);
      return null;
    });
    if (answer && !answer.parsed.ok) {
      try {
        result = await validateAndRepair({ parts: answer.parsed, timing, workDir, renderer, llm, instructions, progress, signal });
        reviewed = true;
        progress({ phase: 'review', message: '점검 결과를 반영한 코드로 교체했습니다.' });
      } catch (error) {
        if (signal?.aborted) throw error;
        notes.push(`점검 후 수정본이 검증을 통과하지 못해 이전 코드를 사용: ${error.message}`);
        await writeComposition(workDir, result.parts, timing);
      }
    } else if (answer) {
      progress({ phase: 'review', message: '점검 결과 수정할 부분이 없다고 판단했습니다.' });
    }
  }
  return { htmlPath: result.htmlPath, check: result.check, reviewed, repairs: result.repairs, model: first.model, notesFromCode: result.parts.notes || [], summary: { engine: 'code' } };
}

module.exports = { FPS, DEFAULT_BPM, runVideo, reviewTimes, prepareMusic, pickMixkitTrack };
