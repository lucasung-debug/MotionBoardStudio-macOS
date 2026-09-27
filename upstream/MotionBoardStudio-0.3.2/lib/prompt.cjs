'use strict';

const fs = require('fs');
const path = require('path');

// 주제형 모션그래픽 올인원 가이드(MD)를 시스템 지침으로 만들고,
// 사용자가 입력한 주제를 가이드가 요구하는 입력 형식으로 조립한다.

const GUIDE_ENV = 'MOTION_BOARD_GUIDE';

function pickGuideFile(promptsDir) {
  const override = String(process.env[GUIDE_ENV] || '').trim();
  if (override) {
    const resolved = path.isAbsolute(override) ? override : path.join(promptsDir, override);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`가이드 파일을 찾을 수 없습니다: ${resolved}`);
  }
  if (!fs.existsSync(promptsDir)) throw new Error(`가이드 폴더가 없습니다: ${promptsDir}`);
  const files = fs.readdirSync(promptsDir).filter((name) => name.toLowerCase().endsWith('.md')).sort();
  if (!files.length) throw new Error(`가이드 MD 파일이 없습니다: ${promptsDir}`);
  return path.join(promptsDir, files[0]);
}

function loadGuide(promptsDir) {
  const file = pickGuideFile(promptsDir);
  const content = fs.readFileSync(file, 'utf8').trim();
  if (!content) throw new Error(`가이드 파일이 비어 있습니다: ${file}`);
  return { file, name: path.basename(file), content };
}

const APP_PREAMBLE = [
  '=== 모션보드 스튜디오 실행 모드 ===',
  '너는 데스크톱 앱 "모션보드 스튜디오" 안에서 실행되는 모션그래픽 디렉터다. 위 가이드의 규칙(주제 해석, 고정할 것/새로 설계할 것, 독창성, 팩트·음악 상태 표기, 16패널 구성, 8장 이미지 지시문 구조)을 전부 그대로 따른다.',
  '앱은 너의 답변을 코드로 파싱한다. 대화체 설명, 인사말, 도구 호출 대신 아래 계약에 정의된 JSON 객체 "하나만" 출력한다. 마크다운 코드블록으로 감싸지 않는다.',
  '이미지 생성 호출은 앱이 담당한다. 너는 가이드 8장 형식의 완성된 이미지 지시문(image_prompt)만 작성한다.',
  '확인하지 못한 음악 BPM·라이선스·실제 데이터는 가이드대로 provisional / SAMPLE DATA 상태를 표기하고, 그 한계를 notes에 적는다. 그럴듯한 수치를 만들어 넣지 않는다.'
].join('\n');

const FULL_CONTRACT = [
  '=== 출력 계약 (full: 제작 명세 + 보드 이미지 지시문) ===',
  '아래 키만 가진 JSON 객체 하나를 출력한다.',
  '{',
  '  "title": "주제에 맞는 작품명",',
  '  "concept": "콘셉트와 비주얼 방향 3~5문장 (가이드 9장 서론에 해당)",',
  '  "yaml": "가이드 9장 구조를 모두 채운 YAML 제작 명세 전체. 실제 줄바꿈이 있는 문자열",',
  '  "image_prompt": "가이드 8장 \'생성에 사용할 통합 지시문 구조\'를 실제 주제 값으로 전부 채운 완성 지시문",',
  '  "notes": ["사용자에게 알릴 사실·검증 한계 (0~4개, 선택)"]',
  '}',
  '규칙:',
  '- yaml은 project/concept/visual_system/music/scenes(01~12 전부)/key_visuals(13~15)/loop_frame(16)/originality/facts/avoid 를 포함하고, 장면을 생략 기호로 줄이지 않는다.',
  '- image_prompt는 [대괄호] 플레이스홀더를 남기지 않는다. 4열×4행 16패널, 각 패널의 타임코드/이름/구체적 키프레임, 팔레트, 타이포그래피, 공통 오브젝트, 13~15 KEY VISUAL 표기(가짜 타임코드 없음), 16 LOOP FRAME 표기, 브라우저·워터마크·요청하지 않은 로고 금지를 명시한다.',
  '- image_prompt는 yaml의 장면 순서·색·소재와 일치해야 한다.',
  '- 실제 사실이 필요한 주제라면 가이드 11장에 따라 예시 데이터 여부를 표시한다.'
].join('\n');

const IMAGE_ONLY_CONTRACT = [
  '=== 출력 계약 (image_only: 디자인 보드 이미지 지시문만) ===',
  '긴 제작 명세를 생략하고, 아래 키만 가진 JSON 객체 하나를 출력한다.',
  '{',
  '  "title": "주제에 맞는 작품명",',
  '  "concept": "한두 문장 콘셉트 요약",',
  '  "image_prompt": "가이드 8장 \'생성에 사용할 통합 지시문 구조\'를 실제 주제 값으로 전부 채운 완성 지시문"',
  '}',
  '규칙:',
  '- image_prompt는 [대괄호] 플레이스홀더를 남기지 않는다. 4열×4행 16패널의 구체적 키프레임, 팔레트, 타이포그래피, 공통 오브젝트, 패널 라벨(01 OPENING 00:00 형식), 13~15 KEY VISUAL, 16 LOOP FRAME, 금지 요소를 명시한다.',
  '- yaml·notes 등 다른 키는 넣지 않는다.'
].join('\n');

function buildInstructions({ guide, mode = 'full' }) {
  const contract = mode === 'image_only' ? IMAGE_ONLY_CONTRACT : FULL_CONTRACT;
  return `${guide}\n\n---\n\n${APP_PREAMBLE}\n\n${contract}`;
}

const OUTPUT_LABELS = {
  full: '제작 명세 + 4×4 디자인 보드 (전체)',
  image_only: '이미지만',
  spec_only: '프롬프트만'
};

function buildUserMessage(input = {}) {
  const topic = String(input.topic || '').trim();
  if (!topic) throw new Error('주제를 입력해 주세요.');
  const lines = [`주제: ${topic}`];
  const optional = [
    ['분위기', input.mood],
    ['스타일', input.style],
    ['강조 문구', input.copy],
    ['화면비', input.aspectRatio],
    ['길이', input.durationSeconds ? `${input.durationSeconds}초` : ''],
    ['피할 요소', input.avoid],
    ['데이터', input.dataNote]
  ];
  for (const [label, value] of optional) {
    const text = String(value || '').trim();
    if (text) lines.push(`${label}: ${text}`);
  }
  lines.push(`출력: ${OUTPUT_LABELS[input.mode] || OUTPUT_LABELS.full}`);
  const extra = String(input.extra || '').trim();
  if (extra) lines.push('', `[추가 요청] ${extra}`);
  return lines.join('\n');
}

// LLM이 문자열 안에 "\n" 리터럴로 줄바꿈을 넣은 경우 실제 줄바꿈으로 되돌린다.
function unescapeNewlines(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.includes('\n')) return text;
  return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function normalizeResult(raw, { mode = 'full' } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('제작 명세 응답이 비어 있습니다.');
  const title = String(raw.title || '').trim();
  const concept = String(raw.concept || '').trim();
  const imagePrompt = String(raw.image_prompt || raw.imagePrompt || '').trim();
  const yaml = unescapeNewlines(raw.yaml).trim();
  const notes = Array.isArray(raw.notes)
    ? raw.notes.map((note) => String(note || '').trim()).filter(Boolean).slice(0, 4)
    : [];
  if (!title) throw new Error('응답에 작품명(title)이 없습니다.');
  if (mode === 'image_only') {
    if (!imagePrompt) throw new Error('응답에 이미지 지시문(image_prompt)이 없습니다.');
    return { title, concept, yaml: '', imagePrompt, notes };
  }
  if (!yaml) throw new Error('응답에 YAML 제작 명세가 없습니다.');
  if (!imagePrompt) throw new Error('응답에 이미지 지시문(image_prompt)이 없습니다.');
  return { title, concept, yaml, imagePrompt, notes };
}

function sanitizeFileName(name, fallback = 'design-board') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

module.exports = {
  GUIDE_ENV,
  loadGuide,
  buildInstructions,
  buildUserMessage,
  normalizeResult,
  sanitizeFileName,
  unescapeNewlines,
  OUTPUT_LABELS
};
