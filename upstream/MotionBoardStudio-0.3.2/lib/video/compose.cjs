'use strict';

// 영상 코드 단계: LLM 지시문·사용자 메시지 조립, 태그 출력 파싱, 합성 HTML(셸) 생성.
// electron 비의존 — 테스트에서 그대로 검증한다.

const fs = require('fs');
const path = require('path');

const KIT_FILE = path.join(__dirname, 'kit.js');
const GUIDE_DIR = path.join(__dirname, '..', '..', 'prompts', 'video');

// 가이드 6장 기본 시간표(30초 기준). 명세에서 12개 장면 시각을 읽지 못하면 이 비율을 쓴다.
const DEFAULT_CUTS = [0, 2, 4, 6.5, 9, 11.5, 14.5, 17.5, 20, 22.5, 25, 28, 30];
const DEFAULT_TITLES = ['OPENING', 'SIGNATURE', 'BUILD', 'EXPAND', 'FOCUS', 'TURN', 'CLIMAX', 'HERO', 'DETAIL', 'CONNECT', 'RESOLVE', 'CLOSING'];

const CANVAS = { '1:1': [1440, 1440], '16:9': [1920, 1080], '9:16': [1080, 1920] };

function canvasFor(aspect) {
  return CANVAS[String(aspect || '1:1').replace(/\s+/g, '')] || CANVAS['1:1'];
}

function loadGuide() {
  const files = fs.readdirSync(GUIDE_DIR).filter((n) => n.toLowerCase().endsWith('.md')).sort();
  if (!files.length) throw new Error(`영상 코드 가이드가 없습니다: ${GUIDE_DIR}`);
  return fs.readFileSync(path.join(GUIDE_DIR, files[0]), 'utf8').trim();
}

function loadKit() {
  return fs.readFileSync(KIT_FILE, 'utf8');
}

// YAML 의 scenes 에서 id "01"~"12" 와 time: [a, b], title 을 읽는다(라이브러리 없이 관대한 정규식).
function scenesFromYaml(yaml) {
  const text = String(yaml || '');
  const block = text.split(/\n(?=key_visuals:|loop_frame:|originality:|facts:|avoid:)/)[0];
  const parts = block.split(/\n\s*-\s+id:\s*/).slice(1);
  const scenes = [];
  for (const part of parts) {
    const id = (part.match(/^["']?(\d{1,2})["']?/) || [])[1];
    const time = part.match(/time:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
    const title = (part.match(/\btitle:\s*["']?([^"'\n]+)["']?/) || [])[1];
    if (!id || !time) continue;
    scenes.push({ id: id.padStart(2, '0'), start: Number(time[1]), end: Number(time[2]), title: (title || '').trim() });
  }
  const main = scenes.filter((s) => Number(s.id) >= 1 && Number(s.id) <= 12).sort((a, b) => Number(a.id) - Number(b.id));
  const ok = main.length === 12 && main.every((s, i) => s.end > s.start && (i === 0 || s.start >= main[i - 1].start));
  return ok ? main : null;
}

// 장면 시간표를 실제 루프 길이로 늘이고 박에 스냅한다(각 장면 최소 2박).
function sceneWindows({ yaml, loopSec, beatSec }) {
  const parsed = scenesFromYaml(yaml);
  const total = parsed ? parsed[11].end : DEFAULT_CUTS[12];
  const cuts = parsed ? [...parsed.map((s) => s.start), parsed[11].end] : DEFAULT_CUTS.slice();
  const totalBeats = Math.round(loopSec / beatSec);
  const beats = cuts.map((c) => Math.round((c / total) * totalBeats));
  beats[0] = 0;
  beats[12] = totalBeats;
  for (let i = 1; i < 12; i += 1) beats[i] = Math.max(beats[i], beats[i - 1] + 2);
  for (let i = 11; i >= 1; i -= 1) beats[i] = Math.min(beats[i], beats[i + 1] - 2);
  return Array.from({ length: 12 }, (_, i) => ({
    id: String(i + 1).padStart(2, '0'),
    title: (parsed && parsed[i].title) || DEFAULT_TITLES[i],
    startBeat: beats[i],
    endBeat: beats[i + 1],
    start: Number((beats[i] * beatSec).toFixed(4)),
    end: Number((beats[i + 1] * beatSec).toFixed(4))
  }));
}

function timingBlock(timing) {
  return {
    T: timing.T, FPS: timing.fps, W: timing.W, H: timing.H,
    BPM: timing.bpm, BEAT: timing.beat, BARS: timing.bars,
    SCENES: timing.scenes.map((s) => ({ id: s.id, title: s.title, start: s.start, end: s.end }))
  };
}

const OUTPUT_DIRECTIVE = '지금 바로 모션 코드 가이드의 출력 형식대로 <mk-fonts>, <mk-css>, <mk-html>, <mk-js>, <mk-notes> 태그 블록만 출력하세요. 태그 밖에 설명을 쓰지 말고, 태그 안에 ``` 코드블록을 쓰지 마세요.';

function buildComposeUserMessage({ entry, timing, music, hasImage }) {
  const lines = [];
  lines.push('[영상 제작 입력]');
  lines.push(`작품명: ${entry.title || ''}`);
  if (entry.input?.topic) lines.push(`주제: ${entry.input.topic}`);
  if (entry.concept) lines.push(`콘셉트: ${entry.concept}`);
  lines.push(`캔버스: ${timing.W}×${timing.H}px, 길이 T=${timing.T.toFixed(3)}초, ${timing.fps}fps, 루프(마지막 프레임 = 첫 프레임)`);
  if (music) {
    lines.push(`음악: "${music.title}" — ${music.artist || '아티스트 미상'} (${music.license || '라이선스 확인 필요'})`);
    lines.push(`실측 템포: ${timing.bpm.toFixed(3)} BPM (박 간격 ${timing.beat.toFixed(4)}초, 비트 지터 ${Number.isFinite(music.jitterMs) ? music.jitterMs.toFixed(1) : '?'}ms), ${timing.bars}마디. t=0이 다운비트.`);
  } else {
    lines.push(`음악: 없음(효과음만). 고정 템포 ${timing.bpm} BPM 그리드(박 간격 ${timing.beat.toFixed(4)}초), ${timing.bars}마디를 편집 리듬으로 사용.`);
  }
  lines.push('');
  lines.push('장면 시간표 (비트에 스냅됨 — 이 구간을 따를 것):');
  for (const s of timing.scenes) {
    lines.push(`  ${s.id} ${s.title}: ${s.start.toFixed(3)}–${s.end.toFixed(3)}s  (MK.beat(${s.startBeat})–MK.beat(${s.endBeat}))`);
  }
  lines.push('');
  if (hasImage) lines.push('첨부 이미지: 같은 명세로 만든 4×4 디자인 보드 시안. 색·소재·구도·타이포를 참고하되, 16패널 격자 자체를 영상에 넣지 않는다.');
  else lines.push('디자인 보드 이미지 없음: 명세만으로 비주얼을 설계한다.');
  const extra = String(entry.input?.extra || '').trim();
  if (extra) lines.push(`추가 요청: ${extra}`);
  lines.push('');
  lines.push('[제작 명세 YAML]');
  lines.push(entry.yaml || '(명세 없음 — 콘셉트와 이미지 지시문을 기준으로 설계)');
  if (!entry.yaml && entry.imagePrompt) {
    lines.push('');
    lines.push('[이미지 지시문]');
    lines.push(entry.imagePrompt);
  }
  return lines.join('\n');
}

function buildRepairMessage({ code, errors }) {
  return [
    '[코드 오류 수정 요청]',
    '아래 코드를 앱의 렌더러(Chromium)에서 실행했더니 다음 오류가 났다. 원인을 고친 "전체" 코드를 같은 태그 형식으로 다시 출력하라. 디자인은 유지한다.',
    '',
    '오류:',
    ...errors.slice(0, 12).map((e) => `- ${e}`),
    '',
    '[현재 코드]',
    serializeParts(code)
  ].join('\n');
}

function buildReviewMessage({ code, samples, timing }) {
  return [
    '[비트 프레임 점검]',
    `첨부 이미지는 방금 코드를 실제로 렌더한 프레임 시트다(왼쪽 위 라벨 = 시각). 캔버스 ${timing.W}×${timing.H}, T=${timing.T.toFixed(3)}초, ${timing.bpm.toFixed(2)} BPM.`,
    `샘플 시각: ${samples.map((s) => s.toFixed(2)).join(', ')}`,
    '다음을 점검하라: 글자 겹침·잘림, 화면 밖으로 나간 요소, 빈 화면이나 너무 작은 주인공, 읽기 어려운 대비, 장면 시간표와 어긋난 전환, 루프 연결(마지막 → 처음), 명세와 다른 색·소재.',
    '고칠 것이 있으면 수정한 "전체" 코드를 같은 태그 형식으로 출력하라. 고칠 것이 없으면 <mk-ok/> 만 출력하라.',
    '',
    '[현재 코드]',
    serializeParts(code)
  ].join('\n');
}

function stripFence(text) {
  let s = String(text || '').trim();
  const fenced = s.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) s = fenced[1].trim();
  return s;
}

function tag(text, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
  const m = String(text || '').match(re);
  return m ? stripFence(m[1]) : null;
}

function parseCompose(text) {
  const raw = String(text || '');
  if (/<mk-ok\s*\/?>/i.test(raw) && !/<mk-js>/i.test(raw)) return { ok: true };
  const js = tag(raw, 'mk-js');
  if (!js) throw new Error('응답에 <mk-js> 코드가 없습니다.');
  if (!/MK\.define\s*\(/.test(js)) throw new Error('<mk-js>에 MK.define({ build, render }) 호출이 없습니다.');
  return {
    fonts: tag(raw, 'mk-fonts') || '',
    css: tag(raw, 'mk-css') || '',
    html: tag(raw, 'mk-html') || '',
    js,
    notes: (tag(raw, 'mk-notes') || '').split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 6)
  };
}

function serializeParts(parts) {
  return [
    `<mk-fonts>\n${parts.fonts || ''}\n</mk-fonts>`,
    `<mk-css>\n${parts.css || ''}\n</mk-css>`,
    `<mk-html>\n${parts.html || ''}\n</mk-html>`,
    `<mk-js>\n${parts.js || ''}\n</mk-js>`
  ].join('\n');
}

// "Geist:400,500" / "Noto Sans KR:400;700" → Google Fonts css2 URL + document.fonts.load 목록
function parseFonts(spec) {
  const families = [];
  for (const line of String(spec || '').split(/\n|\|/)) {
    const m = line.trim().match(/^([A-Za-z][A-Za-z0-9 ]{1,40})(?::\s*([\d,;\s]+))?$/);
    if (!m) continue;
    const name = m[1].trim();
    const weights = [...new Set(String(m[2] || '400').split(/[,;\s]+/).map(Number).filter((w) => w >= 100 && w <= 900 && w % 100 === 0))].sort((a, b) => a - b);
    if (!families.some((f) => f.name === name)) families.push({ name, weights: weights.length ? weights : [400] });
  }
  if (!families.length) families.push({ name: 'Noto Sans KR', weights: [400, 700] });
  const query = families.map((f) => `family=${encodeURIComponent(f.name).replace(/%20/g, '+')}:wght@${f.weights.join(';')}`).join('&');
  const url = `https://fonts.googleapis.com/css2?${query}&display=block`;
  const loads = families.flatMap((f) => f.weights.map((w) => `${w} 32px "${f.name}"`));
  return { families, url, loads };
}

const safeScript = (s) => String(s || '').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeStyle = (s) => String(s || '').replace(/<\/style/gi, '<\\/style');

function buildShell({ parts, timing, kit = loadKit() }) {
  const fonts = parseFonts(parts.fonts);
  const t = timingBlock(timing);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:">
<title>${String(timing.title || 'motion').replace(/[<&>]/g, '')}</title>
<link rel="stylesheet" href="${fonts.url}">
<style>
html,body{margin:0;padding:0;background:#000;overflow:hidden}
#stage{position:relative;width:${timing.W}px;height:${timing.H}px;overflow:hidden;-webkit-font-smoothing:antialiased}
*,*::before,*::after{transition:none!important;animation:none!important}
</style>
<style>
${safeStyle(parts.css)}
</style>
</head><body>
<div id="stage">${parts.html || ''}</div>
<script>window.MK_TIMING=${JSON.stringify(t)};window.MK_FONTS=${JSON.stringify(fonts.loads)};</script>
<script>
${safeScript(kit)}
</script>
<script>
try {
${safeScript(parts.js)}
} catch (e) { MK.fail(e); }
</script>
<script>window.MK_READY = MK.boot();</script>
</body></html>
`;
}

module.exports = {
  DEFAULT_CUTS,
  CANVAS,
  OUTPUT_DIRECTIVE,
  canvasFor,
  loadGuide,
  loadKit,
  scenesFromYaml,
  sceneWindows,
  timingBlock,
  buildComposeUserMessage,
  buildRepairMessage,
  buildReviewMessage,
  parseCompose,
  serializeParts,
  parseFonts,
  buildShell
};
