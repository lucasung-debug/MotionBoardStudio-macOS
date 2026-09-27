'use strict';

// 연출 스크립트(LLM 이 쓰는 JSON) 정규화·검증과 엔진 셸 HTML 조립(electron 비의존).
// 모델은 장면 종류·카피·색·박자·전환만 정하고, 나머지는 엔진이 결정한다.
// 여기서 고치는 것: 박자 배분(루프 길이에 정확히 맞춤), 글꼴(허용 목록), 색(형식), 카피 길이(자동 줄바꿈),
// 금지 문구(로고·자리표시·스토리보드 라벨)는 문제로 보고해 모델에 수정을 요청한다.

const fs = require('fs');
const path = require('path');
const compose = require('./compose.cjs');

const ENGINE_FILE = path.join(__dirname, 'engine.js');
const DIRECTION_GUIDE = path.join(__dirname, '..', '..', 'prompts', 'video', 'direction', '모션_연출_가이드.md');

const TYPES = ['title', 'slam', 'stack', 'number', 'marquee', 'split', 'motif', 'pattern', 'bars', 'quote', 'end'];
const TRANSITIONS = ['cut', 'wipe', 'iris', 'push', 'zoom', 'morph'];
const WIPE_DIRS = ['left', 'right', 'up', 'down'];
const MOTIFS = ['circle', 'pill', 'square', 'diamond'];
const PATTERNS = ['stripes', 'dots', 'checker', 'chevrons'];
const MOODS = ['energetic', 'playful', 'calm', 'elegant', 'tech'];
const PALETTE_KEYS = ['bg', 'surface', 'ink', 'accent', 'accent2'];

// Google Fonts 에 있는 글꼴만 쓴다(한글 글리프 여부 포함).
const FONTS = {
  'Black Han Sans': { ko: true, weights: [400] },
  'Do Hyeon': { ko: true, weights: [400] },
  Jua: { ko: true, weights: [400] },
  'Gothic A1': { ko: true, weights: [400, 500, 700, 800, 900] },
  'Noto Sans KR': { ko: true, weights: [400, 500, 700, 900] },
  'IBM Plex Sans KR': { ko: true, weights: [400, 500, 700] },
  'Nanum Myeongjo': { ko: true, weights: [400, 700, 800] },
  'Gowun Batang': { ko: true, weights: [400, 700] },
  Anton: { weights: [400] },
  'Archivo Black': { weights: [400] },
  'Bebas Neue': { weights: [400] },
  'Inter Tight': { weights: [500, 700, 800, 900] },
  'Space Grotesk': { weights: [500, 700] },
  'Playfair Display': { weights: [700, 900] },
  'DM Serif Display': { weights: [400] },
  Geist: { weights: [400, 500, 600, 700, 800] },
  Unbounded: { weights: [600, 800] },
  Syne: { weights: [700, 800] }
};
const MOOD_DEFAULTS = {
  energetic: { display: 'Black Han Sans', latin: 'Anton', text: 'Noto Sans KR', palette: { bg: '#0B1B3F', surface: '#F4F2EC', ink: '#FFFFFF', accent: '#E4172D', accent2: '#9CC2FF' }, motif: 'circle' },
  playful: { display: 'Jua', latin: 'Unbounded', text: 'Gothic A1', palette: { bg: '#FFF4E0', surface: '#FFFFFF', ink: '#1E1B18', accent: '#FF5A36', accent2: '#3D7BFF' }, motif: 'pill' },
  calm: { display: 'Gothic A1', latin: 'Inter Tight', text: 'Noto Sans KR', palette: { bg: '#EDEBE6', surface: '#FFFFFF', ink: '#1C1C1A', accent: '#2F5D50', accent2: '#C9B79C' }, motif: 'circle' },
  elegant: { display: 'Nanum Myeongjo', latin: 'Playfair Display', text: 'Noto Sans KR', palette: { bg: '#141210', surface: '#F3EEE6', ink: '#F3EEE6', accent: '#C8A46A', accent2: '#6E5B43' }, motif: 'square' },
  tech: { display: 'Gothic A1', latin: 'Space Grotesk', text: 'IBM Plex Sans KR', palette: { bg: '#0A0C10', surface: '#E9EDF2', ink: '#E9EDF2', accent: '#C8F031', accent2: '#5B8CFF' }, motif: 'square' }
};

// 화면에 나오면 안 되는 문구: 로고/자리표시/스토리보드 라벨/타임코드
const FORBIDDEN = [
  { re: /로고|logo|워드마크|엠블럼|emblem/i, why: '로고·엠블럼 자리(공식 마크는 영상에 넣지 않는다)' },
  { re: /영역|placeholder|자리표시|TODO|TBD|합성|insert|삽입|\[[^\]]*\]|\{[^}]*\}|<[^>]*>/i, why: '자리표시·편집용 문구' },
  { re: /\b(OPENING|SIGNATURE|BUILD|EXPAND|FOCUS|TURN|CLIMAX|HERO|DETAIL|CONNECT|RESOLVE|CLOSING|KEY VISUAL|LOOP FRAME)\b/, why: '스토리보드 패널 라벨' },
  { re: /\b\d{2}:\d{2}\b|패널\s*\d+|panel\s*\d+/i, why: '타임코드·패널 번호' }
];

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const graphemes = (s) => [...str(s)].length;

function normHex(v) {
  const s = str(v);
  if (HEX.test(s)) return s.toUpperCase();
  const short = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase() : null;
}

// 긴 줄은 공백 기준으로 maxChars 이하로 나눈다(한 단어가 길면 그대로 둔다 — 엔진이 크기를 줄여 맞춘다).
function wrapLines(lines, maxChars, maxLines) {
  const out = [];
  for (const line of lines.map(str).filter(Boolean)) {
    if (graphemes(line) <= maxChars) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && graphemes(next) > maxChars) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
  }
  return out.slice(0, maxLines);
}

function pickFont(name, { needKo, fallback }) {
  const key = Object.keys(FONTS).find((f) => f.toLowerCase() === str(name).toLowerCase());
  if (key && (!needKo || FONTS[key].ko)) return key;
  return fallback;
}
const heaviest = (name) => Math.max(...FONTS[name].weights);
const nearest = (name, w) => FONTS[name].weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));

function normalizeShot(raw, i, problems) {
  const type = TYPES.includes(str(raw?.type)) ? str(raw.type) : null;
  if (!type) { problems.push(`장면 ${i + 1}: 알 수 없는 type "${raw?.type}" — 제외했습니다.`); return null; }
  const sh = {
    type,
    beats: Math.max(1, Math.round(Number(raw.beats) || 4)),
    bg: str(raw.bg) || 'bg',
    fg: str(raw.fg) || '',
    transition: TRANSITIONS.includes(str(raw.transition)) ? str(raw.transition) : '',
    wipeDir: WIPE_DIRS.includes(str(raw.wipeDir)) ? str(raw.wipeDir) : ['left', 'up', 'right', 'down'][i % 4],
    kicker: str(raw.kicker).slice(0, 32)
  };
  const need = (cond, what) => { if (!cond) problems.push(`장면 ${i + 1}(${type}): ${what}`); return cond; };
  switch (type) {
    case 'title':
      sh.lines = wrapLines(arr(raw.lines ?? raw.text), 10, 3);
      sh.sub = str(raw.sub).slice(0, 44);
      if (!need(sh.lines.length, 'lines(제목 줄)이 비어 있습니다.')) return null;
      break;
    case 'slam':
      sh.words = arr(raw.words ?? raw.text).map(str).filter(Boolean).slice(0, 6);
      if (!need(sh.words.length, 'words가 비어 있습니다.')) return null;
      break;
    case 'stack':
      sh.items = arr(raw.items).map(str).filter(Boolean).slice(0, 5);
      if (!need(sh.items.length >= 2, 'items는 2~5개가 필요합니다.')) return null;
      break;
    case 'number':
      sh.value = str(raw.value);
      sh.from = Number(raw.from) || 0;
      sh.caption = str(raw.caption).slice(0, 24);
      if (!need(/\d/.test(sh.value), 'value에 숫자가 없습니다.')) return null;
      break;
    case 'marquee':
      sh.text = str(raw.text).slice(0, 28);
      sh.caption = str(raw.caption).slice(0, 14);
      if (!need(sh.text, 'text가 비어 있습니다.')) return null;
      break;
    case 'split':
      sh.a = str(raw.a ?? raw.left);
      sh.b = str(raw.b ?? raw.right);
      sh.bg2 = str(raw.bg2);
      if (!need(sh.a && sh.b, 'a·b 두 단어가 모두 필요합니다.')) return null;
      break;
    case 'motif':
      sh.labels = arr(raw.labels ?? raw.words).map(str).filter(Boolean).slice(0, 4);
      sh.shapes = arr(raw.shapes).map(str).filter((s) => MOTIFS.includes(s)).slice(0, 4);
      break;
    case 'pattern':
      sh.pattern = PATTERNS.includes(str(raw.pattern)) ? str(raw.pattern) : 'stripes';
      sh.text = str(raw.text).slice(0, 12);
      sh.patternColor = str(raw.patternColor);
      if (!need(sh.text, 'text가 비어 있습니다.')) return null;
      break;
    case 'bars': {
      sh.values = arr(raw.values).map(Number).filter((v) => Number.isFinite(v) && v >= 0).slice(0, 7);
      sh.labels = arr(raw.labels).map((l) => str(l).slice(0, 8)).slice(0, sh.values.length);
      sh.sample = raw.sample !== false;
      sh.format = str(raw.format).includes('{v}') ? str(raw.format).slice(0, 12) : '';
      if (!need(sh.values.length >= 3, 'values는 3~7개 숫자가 필요합니다.')) return null;
      break;
    }
    case 'quote':
      sh.lines = wrapLines(arr(raw.lines ?? raw.text), 16, 3);
      sh.highlight = arr(raw.highlight).map(str).filter(Boolean).slice(0, 3);
      sh.by = str(raw.by).slice(0, 28);
      if (!need(sh.lines.length, 'lines가 비어 있습니다.')) return null;
      break;
    case 'end':
      sh.lines = wrapLines(arr(raw.lines ?? raw.text), 10, 2);
      sh.sub = str(raw.sub).slice(0, 36);
      if (!need(sh.lines.length, 'lines가 비어 있습니다.')) return null;
      break;
    default:
  }
  return sh;
}

function visibleStrings(sh) {
  return [sh.kicker, sh.sub, sh.caption, sh.text, sh.a, sh.b, sh.by, sh.value, ...(sh.lines || []), ...(sh.words || []), ...(sh.items || []), ...(sh.labels || [])]
    .map(str).filter(Boolean);
}

// 박자 배분: 요청 비율을 유지하며 총 박 수에 정확히 맞춘다(장면당 최소 2박).
function allocateBeats(requested, total) {
  const n = requested.length;
  const minB = 2;
  if (n * minB > total) throw new Error(`장면 수(${n})가 너무 많습니다. ${Math.floor(total / minB)}개 이하로 줄여 주세요.`);
  const sum = requested.reduce((a, b) => a + b, 0);
  const ideal = requested.map((b) => (b / sum) * total);
  const out = ideal.map((x) => Math.max(minB, Math.round(x)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  const order = () => out.map((b, i) => [i, ideal[i] - b]).sort((a, b) => (diff > 0 ? b[1] - a[1] : a[1] - b[1]));
  while (diff !== 0) {
    let moved = false;
    for (const [i] of order()) {
      if (diff > 0) { out[i] += 1; diff -= 1; moved = true; break; }
      if (out[i] > minB) { out[i] -= 1; diff += 1; moved = true; break; }
    }
    if (!moved) break;
  }
  return out;
}

function normalizeScript(raw, { T, beat, aspect } = {}) {
  const problems = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw new Error('연출 스크립트(JSON)가 비어 있습니다.');
  const mood = MOODS.includes(str(raw.mood)) ? str(raw.mood) : 'energetic';
  const def = MOOD_DEFAULTS[mood];
  const palette = {};
  const rawPal = raw.palette && typeof raw.palette === 'object' ? raw.palette : {};
  for (const key of PALETTE_KEYS) {
    const hex = normHex(rawPal[key]);
    palette[key] = hex || def.palette[key];
    if (!hex && rawPal[key] != null) warnings.push(`palette.${key} "${rawPal[key]}"를 해석하지 못해 기본값을 썼습니다.`);
  }
  const rf = raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {};
  const display = pickFont(rf.display, { needKo: true, fallback: def.display });
  const latin = pickFont(rf.latin, { needKo: false, fallback: def.latin });
  const text = pickFont(rf.text, { needKo: true, fallback: def.text });
  const fonts = {
    display, latin, text,
    weights: { display: heaviest(display), latin: heaviest(latin), text: nearest(text, 500), textBold: nearest(text, 700) }
  };
  const motif = MOTIFS.includes(str(raw.motif)) ? str(raw.motif) : def.motif;

  const shots = arr(raw.shots).map((s, i) => normalizeShot(s, i, problems)).filter(Boolean);
  if (shots.length < 3) throw new Error(`유효한 장면이 ${shots.length}개뿐입니다. 장면을 6~12개로 구성해 주세요. ${problems.slice(0, 3).join(' / ')}`);

  // 금지 문구 검사(자동으로 고치지 않고 모델에 돌려보낸다)
  shots.forEach((sh, i) => {
    for (const s of visibleStrings(sh)) {
      for (const f of FORBIDDEN) {
        if (f.re.test(s)) problems.push(`장면 ${i + 1}(${sh.type})의 "${s}": ${f.why}는 화면에 넣을 수 없습니다.`);
      }
    }
    for (const key of ['bg', 'fg', 'bg2', 'patternColor']) {
      const v = sh[key];
      if (v && !PALETTE_KEYS.includes(v) && !HEX.test(v)) { warnings.push(`장면 ${i + 1}: ${key} "${v}"는 팔레트 키가 아니어서 무시했습니다.`); sh[key] = ''; }
    }
  });

  // 전환 기본값: 에너지가 높으면 컷·와이프·푸시, 차분하면 모프·줌
  const energetic = mood === 'energetic' || mood === 'playful';
  shots.forEach((sh, i) => {
    if (!sh.transition) sh.transition = energetic ? ['cut', 'wipe', 'push', 'cut', 'iris', 'wipe'][i % 6] : ['morph', 'zoom', 'morph', 'wipe'][i % 4];
  });

  const total = Math.max(shots.length * 2, Math.round(T / beat));
  const beats = allocateBeats(shots.map((s) => s.beats), total);
  let at = 0;
  shots.forEach((sh, i) => {
    sh.beats = beats[i];
    sh.start = Number((at * beat).toFixed(6));
    at += beats[i];
  });
  shots.forEach((sh, i) => {
    const end = i === shots.length - 1 ? T : shots[i + 1].start;
    sh.dur = Number((end - sh.start).toFixed(6));
  });

  return {
    script: { title: str(raw.title).slice(0, 60), mood, motif, palette, fonts, shots, aspect },
    problems,
    warnings
  };
}

function fontLoads(fonts) {
  const families = [...new Set([fonts.display, fonts.latin, fonts.text])];
  const weightsFor = (name) => [...new Set([
    ...(name === fonts.display ? [fonts.weights.display] : []),
    ...(name === fonts.latin ? [fonts.weights.latin] : []),
    ...(name === fonts.text ? [fonts.weights.text, fonts.weights.textBold] : [])
  ])].sort((a, b) => a - b);
  return families.map((name) => ({ name, weights: weightsFor(name) }));
}

function buildEngineShell({ script, timing, kit = compose.loadKit(), engine = fs.readFileSync(ENGINE_FILE, 'utf8') }) {
  const fams = fontLoads(script.fonts);
  const fontsSpec = fams.map((f) => `${f.name}:${f.weights.join(',')}`).join('\n');
  const parts = {
    fonts: fontsSpec,
    css: `#stage{background:${script.palette.bg};font-kerning:normal;text-rendering:geometricPrecision}`,
    html: '',
    js: `window.MK_SCRIPT = ${JSON.stringify(script).replace(/</g, '\\u003c')};\n${engine}`
  };
  return compose.buildShell({ parts, timing });
}

function loadDirectionGuide() {
  return fs.readFileSync(DIRECTION_GUIDE, 'utf8').trim();
}

const DIRECTION_DIRECTIVE = '지금 바로 연출 가이드의 스키마대로 JSON 객체 하나만 출력하세요. 마크다운 코드블록·설명·인사말 없이 "{"로 시작해 "}"로 끝나야 합니다.';

function buildDirectionMessage({ entry, timing, music, hasImage }) {
  const totalBeats = Math.round(timing.T / timing.beat);
  const lines = [
    '[영상 연출 입력]',
    `작품명: ${entry.title || ''}`,
    entry.input?.topic ? `주제: ${entry.input.topic}` : '',
    entry.input?.mood ? `분위기 요청: ${entry.input.mood}` : '',
    entry.input?.style ? `스타일 요청: ${entry.input.style}` : '',
    entry.input?.copy ? `강조 문구: ${entry.input.copy}` : '',
    entry.input?.avoid ? `피할 요소: ${entry.input.avoid}` : '',
    entry.concept ? `콘셉트: ${entry.concept}` : '',
    `화면: ${timing.W}×${timing.H} (${timing.W > timing.H * 1.2 ? '가로' : timing.H > timing.W * 1.2 ? '세로' : '정사각'})`,
    music
      ? `음악: "${music.title}" ${music.artist ? `— ${music.artist}` : ''}, 실측 ${timing.bpm.toFixed(1)} BPM`
      : `음악 없음(효과음만), 편집 템포 ${timing.bpm} BPM`,
    `전체 길이: ${timing.T.toFixed(2)}초 = 정확히 ${totalBeats}박 (${timing.bars}마디). 장면 beats 합계를 ${totalBeats}에 맞추면 가장 좋다(앱이 비율대로 보정한다).`,
    hasImage ? '첨부 이미지: 같은 명세로 만든 4×4 디자인 보드 시안 — 팔레트와 카피 톤만 참고하고, 그림을 재현하려 하지 않는다.' : '',
    '',
    '[제작 명세 YAML — 카피·흐름·팔레트의 출처. 그림 묘사(인물·경기장·로고)는 엔진 장면 어휘로 번역할 것]',
    String(entry.yaml || entry.imagePrompt || '').slice(0, 14000)
  ];
  const extra = str(entry.input?.extra);
  if (extra) lines.push('', `[추가 요청] ${extra}`);
  return lines.filter((l) => l !== '').join('\n');
}

function buildScriptRepairMessage({ raw, problems }) {
  return [
    '[연출 스크립트 수정 요청]',
    '아래 스크립트에 다음 문제가 있다. 문제를 모두 고친 "전체" 스크립트 JSON 하나만 다시 출력하라.',
    ...problems.slice(0, 12).map((p) => `- ${p}`),
    '',
    JSON.stringify(raw, null, 2)
  ].join('\n');
}

function buildScriptReviewMessage({ script, samples, timing }) {
  const compact = { ...script, shots: script.shots.map(({ start, dur, index, next, prev, ...rest }) => rest) };
  return [
    '[프레임 점검]',
    `첨부 이미지는 이 스크립트를 앱 엔진으로 실제 렌더한 프레임 시트다(라벨 = 시각). ${timing.W}×${timing.H}, ${timing.T.toFixed(2)}초.`,
    `샘플 시각: ${samples.map((s) => s.toFixed(2)).join(', ')}`,
    '점검: 카피가 주제를 제대로 전달하는가, 장면 순서의 리듬(강약·반복·클라이맥스), 같은 배경색·같은 장면 종류가 연속으로 반복되지 않는가, 색 대비, 엔딩이 첫 장면으로 자연스럽게 이어지는가.',
    '레이아웃·글자 크기·겹침은 엔진이 자동 처리하므로 고치지 않는다. 고칠 것이 있으면 수정한 "전체" 스크립트 JSON을, 없으면 {"ok": true}만 출력하라.',
    '',
    JSON.stringify(compact, null, 2)
  ].join('\n');
}

module.exports = {
  TYPES, TRANSITIONS, MOODS, FONTS, MOOD_DEFAULTS, FORBIDDEN,
  ENGINE_FILE,
  DIRECTION_DIRECTIVE,
  wrapLines,
  allocateBeats,
  normalizeScript,
  fontLoads,
  buildEngineShell,
  loadDirectionGuide,
  buildDirectionMessage,
  buildScriptRepairMessage,
  buildScriptReviewMessage
};
