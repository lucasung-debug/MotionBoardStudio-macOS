'use strict';

const $ = (id) => document.getElementById(id);
const api = typeof window === 'undefined' ? null : window.studio;
const FORM_KEY = 'motion-board-studio.form.v1';
const FORM_FIELDS = ['topic', 'provider', 'claudeEffort', 'mood', 'style', 'copy', 'avoid', 'aspect', 'duration', 'dataNote', 'mode', 'extra', 'musicSource', 'quality', 'engine', 'imageVideoMusicSource'];
const FORM_CHECKS = ['withImage', 'withVideo', 'review'];
const PROVIDER_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude' };
const CLAUDE_SOURCE_LABELS = { oauth: '', env: ' (환경변수 토큰)' };
const CLAUDE_EFFORT_LABELS = { low: '빠르게', medium: '균형', high: '깊게', xhigh: '더 깊게', max: '최대' };
let requestState = '';

const PHASE_LABELS = {
  prepare: '준비',
  request: '요청',
  stream: '수신',
  parse: '해석',
  spec_repair: '명세 형식 보정',
  spec_repaired: '명세 형식 복구',
  spec_done: '명세 완료',
  image_prepare: '이미지 준비',
  image_stream: '이미지',
  image_done: '이미지 완료',
  ffmpeg: 'ffmpeg',
  video_prepare: '영상 준비',
  music_search: '음악 탐색',
  music_analyze: '음악 분석',
  music_pick: '음악 선택',
  timing: '비트 그리드',
  compose: '모션 코드',
  direct: '연출',
  script_fix: '연출 수정',
  code_stream: '모션 코드',
  validate: '코드 검증',
  repair: '코드 수정',
  review: '프레임 점검',
  audio: '오디오',
  render: '렌더',
  video_done: '영상 완료'
};

let current = null;
let busy = false;
let streamedChars = 0;
let authState = { loggedIn: false };
let claudeState = { loggedIn: false };
let envInfo = null;
let musicFile = '';
let creationMode = 'motion_graphics';
let imageMusicFile = '';
let imageProviders = [];
let imageProvidersError = '';
let imageDraft = null;
let imageDraftDirty = false;
let selectedShotId = null;
const IMAGE_PENDING_STATUSES = new Set(['submitting', 'pending', 'uncertain']);
const IMAGE_STATUS_LABELS = { draft: '준비', submitting: '요청 전송 중', pending: '생성 중', succeeded: '완료', failed: '실패', uncertain: '결과 확인 필요' };

function setStatus(text) {
  $('statusText').textContent = text;
}

function appendLog(text) {
  const log = $('log');
  log.textContent += text;
  if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-40000);
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  $('log').textContent = '';
  streamedChars = 0;
  requestState = '';
  $('requestDetail').hidden = true;
}

// 이번 실행에서 보드 이미지를 만들지: ChatGPT 는 전체/이미지 모드에서 항상, Claude 는 체크했을 때만(선택).
function wantsBoardImage(provider, mode, withImage) {
  if (!(mode === 'full' || mode === 'image_only')) return false;
  return provider !== 'claude' || mode === 'image_only' || withImage;
}

function runLabel() {
  if (creationMode === 'image_video') return '명세 · 보드 생성 후 장면 준비';
  const parts = [$('mode').value === 'image_only' ? '지시문' : '명세'];
  if (wantsBoardImage($('provider').value, $('mode').value, $('withImage').checked)) parts.push('보드');
  if ($('withVideo').checked) parts.push('영상');
  return `${parts.join(' + ')} 생성`;
}

function setBusy(value) {
  busy = value;
  $('runBtn').disabled = value;
  $('cancelBtn').disabled = !value;
  $('spinner').hidden = !value;
  $('makeVideoBtn').disabled = value;
  $('provider').disabled = value;
  $('claudeEffort').disabled = value;
  $('runBtn').textContent = value ? '생성 중…' : runLabel();
  if (!value) { hideProgress(); $('requestDetail').hidden = true; requestState = ''; }
  refreshImageControls();
}

function applyFfmpeg(found) {
  $('ffmpegHint').textContent = found
    ? `ffmpeg ${found.version || ''} 사용 · 렌더는 이 PC에서 진행됩니다(30초 영상 최종 품질 렌더 약 2~4분 + 모델 작성 시간).`
    : '이 PC에 ffmpeg가 없어 영상을 만들 수 없습니다. 아래 버튼으로 한 번만 설치하세요.';
  $('installFfmpegBtn').hidden = Boolean(found);
}

function showProgress(fraction) {
  $('progressBar').hidden = false;
  $('progressFill').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function hideProgress() {
  $('progressBar').hidden = true;
  $('progressFill').style.width = '0%';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    return ok;
  }
}

function setTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const body of document.querySelectorAll('.tab-body')) {
    body.classList.toggle('active', body.dataset.body === name);
  }
}

function collectInput() {
  return {
    topic: $('topic').value.trim(),
    provider: $('provider').value,
    claudeEffort: selectedClaudeEffort(),
    mood: $('mood').value.trim(),
    style: $('style').value.trim(),
    copy: $('copy').value.trim(),
    avoid: $('avoid').value.trim(),
    aspectRatio: $('aspect').value,
    durationSeconds: Number($('duration').value) || 30,
    dataNote: $('dataNote').value.trim(),
    mode: creationMode === 'image_video' ? 'full' : $('mode').value,
    withImage: creationMode === 'image_video' || $('withImage').checked,
    extra: $('extra').value.trim(),
    withVideo: creationMode === 'motion_graphics' && $('withVideo').checked,
    musicSource: $('musicSource').value,
    musicFile,
    quality: $('quality').value,
    review: $('review').checked,
    engine: $('engine').value
  };
}

function videoOptions(input) {
  return {
    provider: input.provider,
    musicSource: input.musicSource,
    musicFile: input.musicFile,
    quality: input.quality,
    review: input.review,
    engine: input.engine
  };
}

function saveForm() {
  const data = {};
  for (const field of FORM_FIELDS) data[field] = $(field).value;
  for (const check of FORM_CHECKS) data[check] = $(check).checked;
  data.musicFile = musicFile;
  data.creationMode = creationMode;
  data.imageMusicFile = imageMusicFile;
  try { localStorage.setItem(FORM_KEY, JSON.stringify(data)); } catch {}
}

function restoreForm() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(FORM_KEY) || 'null'); } catch {}
  if (!data) return;
  for (const field of FORM_FIELDS) {
    if (data[field] !== undefined && $(field)) $(field).value = data[field];
  }
  $('withImage').checked = Boolean(data.withImage);
  if (data.withVideo !== undefined) $('withVideo').checked = Boolean(data.withVideo);
  if (data.review !== undefined) $('review').checked = Boolean(data.review);
  musicFile = String(data.musicFile || '');
  imageMusicFile = String(data.imageMusicFile || '');
  creationMode = data.creationMode === 'image_video' ? 'image_video' : 'motion_graphics';
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop();
}

// Claude는 이미지 생성 기능이 없다. 보드 이미지는 GPT 이미지로 "선택"하고, 끄면 명세로 바로 영상을 만든다.
function updateImageChoice() {
  const imageMode = creationMode === 'image_video';
  $('withImageRow').hidden = imageMode || $('provider').value !== 'claude';
  $('claudeEffortRow').hidden = $('provider').value !== 'claude';
  const effort = selectedClaudeEffort();
  $('claudeEffortHint').textContent = `같은 Opus 5.5로 작성합니다. 응답 대기 상한은 ${['xhigh', 'max'].includes(effort) ? 15 : effort === 'high' ? 10 : 5}분입니다.`;
  $('motionVideoOptions').hidden = imageMode;
  $('outputModeField').hidden = imageMode;
  $('imageCreationNote').hidden = !imageMode;
  $('creationHint').textContent = imageMode
    ? 'Grok·Kling 구독 계정으로 보드의 인물과 사물을 움직이는 영상으로 만듭니다. 최종 길이는 선택한 장면 길이의 합계입니다.'
    : '명세와 보드의 색·문구를 바탕으로 모션 그래픽을 만듭니다.';
  $('durationLabel').textContent = imageMode ? '명세 기준 길이 (초)' : '길이 (초)';
  for (const radio of document.querySelectorAll('input[name="creationMode"]')) radio.checked = radio.value === creationMode;
  $('videoOptions').hidden = !$('withVideo').checked;
  $('musicFileRow').hidden = $('musicSource').value !== 'file';
  $('musicFileName').textContent = musicFile ? baseName(musicFile) : '선택된 파일 없음';
  $('imageVideoMusicFileRow').hidden = $('imageVideoMusicSource').value !== 'file';
  $('imageVideoMusicFileName').textContent = imageMusicFile ? baseName(imageMusicFile) : '선택된 파일 없음';
  if (!busy) $('runBtn').textContent = runLabel();
}

function formatDate(ms) {
  try { return new Date(ms).toLocaleString('ko-KR'); } catch { return ''; }
}

function renderEntry(entry, { focus } = {}) {
  current = entry;
  $('conceptEmpty').hidden = true;
  $('conceptView').hidden = false;
  $('resultTitle').textContent = entry.title || '(제목 없음)';
  const meta = [];
  meta.push(PROVIDER_LABELS[entry.provider] || 'ChatGPT');
  if (entry.model) meta.push(`모델 ${entry.model}${entry.requestedModel && entry.requestedModel !== entry.model ? ` (요청 ${entry.requestedModel})` : ''}`);
  if (entry.reasoningEffort) meta.push(`추론 ${entry.reasoningEffort}`);
  if (entry.input?.mode) meta.push(`모드 ${entry.input.mode}`);
  meta.push(formatDate(entry.createdAt));
  if (entry.fallbackReason) meta.push(entry.fallbackReason);
  $('resultMeta').textContent = meta.join(' · ');
  $('conceptText').textContent = entry.concept || '';

  const notes = Array.isArray(entry.notes) ? entry.notes : [];
  $('notesBox').hidden = notes.length === 0;
  const list = $('notesList');
  list.textContent = '';
  for (const note of notes) {
    const li = document.createElement('li');
    li.textContent = note;
    list.appendChild(li);
  }

  $('promptPre').textContent = entry.imagePrompt || '(이미지 지시문 없음)';

  const hasYaml = Boolean(entry.yaml);
  $('yamlEmpty').hidden = hasYaml;
  $('yamlView').hidden = !hasYaml;
  $('yamlPre').textContent = entry.yaml || '';
  if (!hasYaml) {
    $('yamlEmpty').textContent = entry.input?.mode === 'image_only'
      ? '이미지만 모드에서는 제작 명세를 생성하지 않습니다. 필요하면 출력을 "프롬프트만" 또는 "전체"로 바꿔 다시 생성하세요.'
      : '명세를 생성하면 YAML 제작 명세가 표시됩니다.';
  }

  renderImage(entry);
  renderVideo(entry);
  renderImageVideo(entry);
  if (focus) setTab(focus);
}

function renderVideo(entry) {
  const view = $('videoView');
  const empty = $('videoEmpty');
  const player = $('videoPlayer');
  if (entry.hasVideo && entry.videoUrl) {
    const version = entry.updatedAt || entry.createdAt || 0;
    const src = `${entry.videoUrl}?v=${version}`;
    if (player.dataset.src !== src) {
      player.dataset.src = src;
      if (entry.posterUrl) player.poster = `${entry.posterUrl}?v=${version}`;
      else player.removeAttribute('poster');
      player.src = src;
    }
    view.hidden = false;
    empty.hidden = true;
    const m = entry.videoMeta || {};
    const parts = [];
    if (m.width) parts.push(`${m.width}×${m.height}`);
    if (m.T) parts.push(`${Number(m.T).toFixed(2)}초 루프`);
    if (m.fps) parts.push(`${m.fps}fps${m.subframes > 1 ? ` · 모션 블러 ${m.subframes} 서브프레임` : ''}`);
    if (m.bpm) parts.push(`${Number(m.bpm).toFixed(2)} BPM × ${m.bars}마디`);
    parts.push(`작성 모델: ${PROVIDER_LABELS[entry.videoProvider] || ''} ${entry.videoModel || ''}`.trim());
    if (m.usedBoardImage === false) parts.push('보드 이미지 없이 명세로 제작');
    $('videoMeta').textContent = parts.join(' · ');
    const notes = $('videoNotes');
    notes.textContent = '';
    const lines = [];
    if (m.music) lines.push(`음악: "${m.music.title}"${m.music.artist ? ` — ${m.music.artist}` : ''} · ${m.music.license || ''}${m.music.source === 'mixkit' ? ' (mixkit.co/license)' : ''}`);
    else lines.push('음악 없음 — 효과음만 사용');
    if (m.direction && m.direction.shots) lines.push(`연출: 디자인 엔진 · 장면 ${m.direction.shots.length}개 (${m.direction.shots.join(' → ')}) · 분위기 ${m.direction.mood}`);
    else if (m.engine === 'code') lines.push('연출: 자유 코드(실험)');
    if (m.reviewed) lines.push('비트 프레임 점검 결과를 반영했습니다.');
    if (m.repairs) lines.push(`실행 오류를 ${m.repairs}회 자동 수정했습니다.`);
    for (const note of [...(m.codeNotes || []), ...(m.notes || [])]) lines.push(note);
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      notes.appendChild(li);
    }
  } else {
    if (player.dataset.src) {
      player.removeAttribute('src');
      player.removeAttribute('poster');
      delete player.dataset.src;
      player.load();
    }
    view.hidden = true;
    empty.hidden = false;
    empty.textContent = entry.videoError
      ? `영상 생성 실패: ${entry.videoError}`
      : '영상이 아직 없습니다. 아래 버튼으로 이 명세로 영상을 만들 수 있습니다.';
  }
}

function renderImage(entry) {
  const view = $('imageView');
  const empty = $('imageEmpty');
  const img = $('boardImage');
  if (entry.imageUrl) {
    img.src = `${entry.imageUrl}?v=${entry.updatedAt || entry.createdAt || 0}`;
    view.hidden = false;
    empty.hidden = true;
    const parts = [];
    if (entry.imageModel) parts.push(`이미지 모델 ${entry.imageModel}`);
    if (entry.imageNote) parts.push(entry.imageNote);
    parts.push('4×4 디자인 보드 · JPG/PNG 저장 가능');
    $('imageMeta').textContent = parts.join(' · ');
    $('imagePathHint').textContent = entry.imagePath || '';
  } else {
    img.removeAttribute('src');
    view.hidden = true;
    empty.hidden = false;
    empty.textContent = entry.imageError
      ? `이미지 생성 실패: ${entry.imageError}  — 아래 "보드 이미지 생성"으로 재시도할 수 있습니다.`
      : '보드 이미지가 아직 없습니다. 아래 "보드 이미지 생성"으로 현재 명세의 보드를 만들거나, "외부 이미지 가져오기"로 직접 만든 보드를 붙일 수 있습니다.';
  }
}

function historyItem(entry) {
  const item = document.createElement('div');
  item.className = 'history-item';

  const thumb = document.createElement('div');
  thumb.className = 'history-thumb';
  const thumbUrl = entry.imageUrl || (entry.hasVideo ? entry.posterUrl : '');
  if (thumbUrl) {
    const img = document.createElement('img');
    img.src = `${thumbUrl}?v=${entry.updatedAt || entry.createdAt || 0}`;
    img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.textContent = '이미지 없음';
  }

  const info = document.createElement('div');
  info.className = 'history-info';
  const title = document.createElement('strong');
  title.textContent = entry.title || '(제목 없음)';
  const sub = document.createElement('span');
  const providerLabel = PROVIDER_LABELS[entry.provider] || 'ChatGPT';
  sub.textContent = `${providerLabel} · ${entry.topic || ''} · ${formatDate(entry.createdAt)}${entry.hasVideo ? ' · 모션 영상' : ''}${entry.hasImageVideo || entry.imageVideo?.output?.videoUrl ? ' · 이미지 영상' : entry.imageVideo ? ' · 이미지 장면' : ''}${entry.imageError ? ' · 이미지 실패' : ''}${entry.videoError && !entry.hasVideo ? ' · 영상 실패' : ''}`;
  info.append(title, sub);

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'btn mini';
  openBtn.type = 'button';
  openBtn.disabled = busy;
  openBtn.textContent = '열기';
  openBtn.addEventListener('click', async () => {
    if (busy || !(await saveImageEditsBeforeNavigation())) return;
    const res = await api.historyGet(entry.id);
    if (res.ok) {
      renderEntry(res.entry, { focus: res.entry.imageVideo ? 'image-video' : 'concept' });
      setStatus(`기록 불러옴 — ${res.entry.title}`);
    } else {
      setStatus(res.error);
    }
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'btn mini danger';
  delBtn.type = 'button';
  delBtn.disabled = busy;
  delBtn.textContent = '삭제';
  delBtn.addEventListener('click', async () => {
    if (busy) return;
    if (current?.id === entry.id && imageDraftDirty && !window.confirm('저장하지 않은 장면 설정이 있습니다. 이 기록을 삭제할까요?')) return;
    const res = await api.historyRemove(entry.id);
    if (res.ok) {
      if (current?.id === entry.id) { current = null; imageDraft = null; imageDraftDirty = false; renderImageVideo(null); }
      await refreshHistory();
      setStatus('기록을 삭제했습니다.');
    } else {
      setStatus(res.error);
    }
  });
  actions.append(openBtn, delBtn);

  item.append(thumb, info, actions);
  return item;
}

async function refreshHistory() {
  const res = await api.history();
  if (!res.ok) return;
  const list = $('historyList');
  list.textContent = '';
  $('historyCount').textContent = String(res.entries.length);
  $('historyEmpty').hidden = res.entries.length > 0;
  for (const entry of res.entries) list.appendChild(historyItem(entry));
}

function imagePlanPayload(draft) {
  return {
    id: draft.id, revision: draft.revision, provider: draft.provider, resolution: draft.resolution,
    shots: draft.shots.map(shot => ({ id: shot.id, enabled: Boolean(shot.enabled),
      title: String(shot.title || '').trim(), prompt: String(shot.prompt || '').trim(), duration: Number(shot.duration) }))
  };
}

function copyImagePlan(entry) {
  const plan = entry?.imageVideo;
  return plan ? { ...plan, id: entry.id, shots: (plan.shots || []).map((shot, index) => ({
    ...shot, index, enabled: shot.enabled === undefined ? index < 12 : Boolean(shot.enabled)
  })) } : null;
}

function imageGenerationShots(plan) {
  return (plan?.shots || []).filter(shot => shot.enabled && ['draft', 'failed'].includes(shot.status || 'draft'));
}

function imageSelection(plan) {
  const shots = (plan?.shots || []).filter(shot => shot.enabled);
  return { shots, seconds: shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    ready: shots.filter(shot => shot.status === 'succeeded' && shot.videoUrl).length };
}

function sceneSeconds(value) { return Number(Number(value).toFixed(2)); }

function imageProvider() {
  return imageProviders.find(provider => provider.id === imageDraft?.provider) || null;
}

function providerDurations(provider = imageProvider()) {
  return [...new Set((provider?.durations || []).map(Number).filter(value => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
}

function selectedImageShot() {
  return imageDraft?.shots.find(shot => shot.id === selectedShotId) || null;
}

function setOptions(select, options, value) {
  select.textContent = '';
  for (const item of options) {
    const option = document.createElement('option');
    option.value = String(item.value);
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = String(value ?? '');
}

function setVideoSource(player, url, poster) {
  if (player.dataset.src === (url || '')) return;
  player.pause();
  if (url) {
    player.src = url;
    player.dataset.src = url;
    if (poster) player.poster = poster;
    else player.removeAttribute('poster');
  } else {
    player.removeAttribute('src');
    player.removeAttribute('poster');
    delete player.dataset.src;
    player.load();
  }
}

function imageProviderURL(kind) {
  const value = imageProvider()?.[kind];
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}

async function loadImageProviders() {
  try {
    if (!api.imageVideo) throw new Error('이 앱 버전에서는 이미지 영상 기능을 연결할 수 없습니다.');
    const result = await api.imageVideo.providers();
    if (!result.ok) throw new Error(result.error || '영상 서비스 정보를 불러오지 못했습니다.');
    imageProviders = Array.isArray(result.providers) ? result.providers : [];
    imageProvidersError = '';
  } catch (error) {
    imageProvidersError = error.message;
  }
  renderImageProvider();
  refreshImageControls();
}

function renderImageProvider() {
  const options = imageProviders.map(provider => ({ value: provider.id, label: provider.label }));
  if (imageDraft && !options.some(option => option.value === imageDraft.provider)) {
    options.push({ value: imageDraft.provider, label: imageDraft.provider || '서비스 확인 중…' });
  }
  setOptions($('imageVideoProvider'), options, imageDraft?.provider);
  const provider = imageProvider();
  const resolutions = provider?.resolutions || [];
  const resolutionOptions = resolutions.map(value => ({ value, label: value }));
  if (imageDraft?.resolution && !resolutions.includes(imageDraft.resolution)) {
    resolutionOptions.push({ value: imageDraft.resolution, label: `${imageDraft.resolution} (현재 설정)` });
  }
  setOptions($('imageVideoResolution'), resolutionOptions, imageDraft?.resolution);
  const status = provider?.statusMessage || (provider?.configured ? '구독 계정 연결됨'
    : provider?.installed ? 'CLI 설치됨 · 구독 로그인 확인 필요' : '구독 연결에 사용할 CLI를 설정해 주세요.');
  const accountDetails = [];
  if (provider?.configured) {
    if (typeof provider.membership === 'string' && provider.membership.trim()) accountDetails.push(provider.membership.trim());
    if (typeof provider.credits === 'number' && Number.isFinite(provider.credits) && provider.credits >= 0) {
      accountDetails.push(`잔여 ${provider.credits.toLocaleString('ko-KR')} 크레딧`);
    }
  }
  $('imageProviderStatus').textContent = imageProvidersError || [status, ...accountDetails].join(' · ');
  $('configureImageProviderBtn').textContent = provider?.configured ? '연결 확인' : '구독 연결 / 확인';
  $('disconnectImageProviderBtn').hidden = !provider?.configured;
  $('imageProviderPricingBtn').hidden = !imageProviderURL('pricingURL');
  $('imageProviderSetupBtn').hidden = !imageProviderURL('setupURL');
  $('imageProviderHint').textContent = provider
    ? `${provider.label}${provider.model ? ` · ${provider.model}` : ''} · 장면 길이 ${providerDurations(provider).map(value => `${value}초`).join(' / ')}. 클립 가져오기와 합치기는 구독 연결 없이 사용할 수 있습니다.`
    : '클립 가져오기와 합치기는 구독 연결 없이 사용할 수 있습니다.';
}

function renderSceneGrid() {
  const grid = $('sceneGrid');
  grid.textContent = '';
  for (const shot of imageDraft?.shots || []) {
    const card = document.createElement('div');
    card.className = `scene-card${shot.id === selectedShotId ? ' is-current' : ''}${shot.enabled ? '' : ' is-excluded'}`;
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'scene-preview';
    preview.dataset.imageControl = '';
    preview.setAttribute('aria-label', `셀 ${shot.index + 1}, ${shot.title || '제목 없음'}, ${IMAGE_STATUS_LABELS[shot.status] || '준비'} — 편집`);
    preview.setAttribute('aria-pressed', String(shot.id === selectedShotId));
    if (shot.imageUrl) {
      const image = document.createElement('img');
      image.src = shot.imageUrl;
      image.alt = '';
      image.loading = 'lazy';
      preview.appendChild(image);
    } else {
      preview.textContent = `셀 ${shot.index + 1}`;
    }
    preview.addEventListener('click', () => {
      if (busy) return;
      selectedShotId = shot.id;
      renderSceneGrid(); renderSceneEditor(); refreshImageControls();
    });
    const label = document.createElement('label');
    label.className = 'scene-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = shot.enabled;
    checkbox.dataset.imageControl = '';
    checkbox.setAttribute('aria-label', `셀 ${shot.index + 1} 영상에 포함`);
    checkbox.addEventListener('change', () => {
      shot.enabled = checkbox.checked;
      card.classList.toggle('is-excluded', !shot.enabled);
      markImageDraftDirty();
    });
    const text = document.createElement('span');
    text.textContent = `${shot.index + 1}. ${shot.title || '장면'}`;
    label.append(checkbox, text);
    const status = document.createElement('small');
    status.className = 'scene-card-status';
    status.textContent = `${shot.index >= 12 ? '참고 셀 · ' : ''}${shot.imported ? '가져온 클립' : IMAGE_STATUS_LABELS[shot.status] || '준비'}`;
    card.append(preview, label, status);
    grid.appendChild(card);
  }
}

function renderSceneEditor() {
  const shot = selectedImageShot();
  $('sceneEditor').hidden = !shot;
  if (!shot) { setVideoSource($('sceneVideoPlayer'), ''); return; }
  $('sceneEditorHeading').textContent = `셀 ${shot.index + 1}${shot.index >= 12 ? ' · 참고 셀' : ''}`;
  $('sceneStatus').textContent = shot.imported ? '가져온 클립' : IMAGE_STATUS_LABELS[shot.status] || '준비';
  $('sceneStatus').dataset.status = shot.status || 'draft';
  if (shot.imageUrl) $('sceneSourceImage').src = shot.imageUrl;
  else $('sceneSourceImage').removeAttribute('src');
  $('sceneSourceImage').alt = `${shot.title || `셀 ${shot.index + 1}`} 보드 원본`;
  const hasClip = Boolean(shot.videoUrl);
  $('sceneVideoPlayer').hidden = !hasClip;
  $('sceneClipEmpty').hidden = hasClip;
  $('sceneClipEmpty').textContent = IMAGE_PENDING_STATUSES.has(shot.status) ? '상태 확인 후 클립을 불러옵니다.' : '클립을 생성하거나 가져와 주세요.';
  setVideoSource($('sceneVideoPlayer'), shot.videoUrl);
  $('sceneTitle').value = shot.title || '';
  $('scenePrompt').value = shot.prompt || '';
  const durations = providerDurations().filter(value => !shot.imported || value <= Number(shot.clipMeta?.duration || shot.duration));
  const options = durations.map(value => ({ value, label: `${value}초` }));
  if (!durations.includes(Number(shot.duration))) options.push({ value: shot.duration, label: `${shot.duration}초 (현재 설정)` });
  setOptions($('sceneDuration'), options, shot.duration);
  $('sceneError').hidden = !shot.error;
  $('sceneError').textContent = shot.error || '';
  $('scenePendingHint').hidden = !IMAGE_PENDING_STATUSES.has(shot.status);
  $('recoverSceneBtn').hidden = shot.status !== 'uncertain';
}

function renderImageVideo(entry) {
  const plan = entry?.imageVideo;
  if (imageDraft?.id !== entry?.id || !imageDraftDirty) {
    imageDraft = copyImagePlan(entry);
    imageDraftDirty = false;
  }
  if (!imageDraft?.shots.some(shot => shot.id === selectedShotId)) selectedShotId = imageDraft?.shots[0]?.id || null;
  $('imageVideoEmpty').hidden = Boolean(imageDraft);
  $('imageVideoWorkbench').hidden = !imageDraft;
  $('imageVideoEmpty').textContent = entry?.imageUrl
    ? '보드가 준비되었습니다. "보드에서 장면 준비"를 누르면 16개 셀을 확인할 수 있습니다.'
    : '기록에서 보드 이미지를 불러오거나, 왼쪽에서 이미지 활용 영상을 선택해 보드를 먼저 만들어 주세요.';
  renderImageProvider(); renderSceneGrid(); renderSceneEditor();
  const output = imageDraft?.output;
  $('imageVideoOutput').hidden = !output?.videoUrl;
  setVideoSource($('imageVideoPlayer'), output?.videoUrl, output?.posterUrl);
  const meta = output?.videoMeta || {};
  const description = [];
  if (meta.width && meta.height) description.push(`${meta.width}×${meta.height}`);
  if (meta.duration || meta.T || meta.durationSeconds) description.push(`${Number(meta.duration || meta.T || meta.durationSeconds).toFixed(1)}초`);
  if (meta.fps) description.push(`${meta.fps}fps`);
  $('imageVideoMeta').textContent = description.join(' · ');
  $('imageVideoError').hidden = !plan?.error;
  $('imageVideoError').textContent = plan?.error || '';
  refreshImageControls();
}

function refreshImageControls() {
  for (const control of document.querySelectorAll('[data-image-control]')) control.disabled = busy;
  for (const button of document.querySelectorAll('.history-actions .btn')) button.disabled = busy;
  $('regenImageBtn').disabled = busy || !current?.imagePrompt;
  $('regenImageBtn').textContent = current?.imageUrl ? '이미지만 다시 생성' : '보드 이미지 생성';
  const supported = Boolean(api.imageVideo);
  for (const id of ['prepareImageVideoBtn', 'prepareScenesBtn']) $(id).disabled = busy || !supported || !current?.imageUrl;
  const shot = selectedImageShot();
  const pending = (imageDraft?.shots || []).filter(item => IMAGE_PENDING_STATUSES.has(item.status));
  const provider = imageProvider();
  const selection = imageSelection(imageDraft);
  const eligible = imageGenerationShots(imageDraft);
  const durations = providerDurations();
  const validGeneration = eligible.every(item => String(item.prompt || '').trim() && durations.includes(Number(item.duration)))
    && (provider?.resolutions || []).includes(imageDraft?.resolution);
  $('imageVideoProvider').disabled = busy || !imageDraft || !imageProviders.length || pending.length > 0;
  $('imageVideoResolution').disabled = busy || !provider || pending.length > 0;
  $('configureImageProviderBtn').disabled = busy || !provider;
  $('refreshImageProviderBtn').disabled = busy || !supported;
  $('disconnectImageProviderBtn').disabled = busy || !provider?.configured || pending.length > 0;
  $('recoverSceneBtn').disabled = busy || shot?.status !== 'uncertain';
  for (const id of ['sceneTitle', 'scenePrompt', 'sceneDuration']) {
    $(id).disabled = busy || !shot || IMAGE_PENDING_STATUSES.has(shot.status);
  }
  $('importSceneClipBtn').disabled = busy || !shot || ['submitting', 'pending'].includes(shot.status);
  $('saveScenePlanBtn').disabled = busy || !imageDraftDirty;
  $('discardSceneEditsBtn').disabled = busy || !imageDraftDirty;
  $('generateScenesBtn').disabled = busy || !supported || !provider?.configured || Boolean(imageProvidersError) || !eligible.length || !validGeneration;
  $('refreshScenesBtn').disabled = busy || !supported || !pending.length;
  $('exportImageVideoBtn').disabled = busy || !supported || !selection.shots.length || selection.ready !== selection.shots.length;
  $('saveImageVideoBtn').disabled = busy || !imageDraft?.output?.videoUrl;
  $('revealImageVideoBtn').disabled = busy || !imageDraft?.output?.videoUrl;
  $('sceneSelectionSummary').textContent = `${selection.shots.length}개 선택 · ${sceneSeconds(selection.seconds)}초`;
  $('sceneSaveStatus').textContent = imageDraftDirty ? '저장하지 않은 변경 사항이 있습니다.' : '장면 설정이 저장되어 있습니다.';
  $('generateScenesBtn').textContent = eligible.length ? `미완료 ${eligible.length}개 장면 생성` : '생성할 미완료 장면 없음';
  const notes = [`선택한 ${selection.shots.length}개 중 클립 ${selection.ready}개 준비됨.`];
  if (eligible.length) notes.push(`새 생성 대상 ${eligible.length}개 · ${sceneSeconds(eligible.reduce((sum, item) => sum + Number(item.duration || 0), 0))}초.`);
  if (pending.length) notes.push(`확인이 필요한 요청 ${pending.length}개는 다시 전송하지 않습니다.`);
  if (eligible.length && !provider?.configured) notes.push('구독 계정을 연결하거나 직접 만든 클립을 가져오세요.');
  if (eligible.length && provider && !validGeneration) notes.push('생성할 장면의 지시문, 지원 길이, 해상도를 확인하세요.');
  $('sceneActionHint').textContent = notes.join(' ');
}

function markImageDraftDirty() {
  imageDraftDirty = true;
  refreshImageControls();
}

async function persistImagePlan() {
  if (!imageDraftDirty || !imageDraft) return true;
  const result = await api.imageVideo.savePlan(imagePlanPayload(imageDraft));
  if (!result.ok) {
    const error = result.error || '장면 설정을 저장하지 못했습니다.';
    $('imageVideoError').textContent = error;
    $('imageVideoError').hidden = false;
    setStatus(`저장 실패 — ${error} 입력한 내용은 유지했습니다.`);
    return false;
  }
  imageDraftDirty = false;
  renderEntry(result.entry);
  return true;
}

async function saveImageEditsBeforeNavigation() {
  if (!imageDraftDirty) return true;
  if (busy) return false;
  setBusy(true);
  try { return (await persistImagePlan()) && !window.__studioFlow?.cancelled; }
  catch (error) { setStatus(`저장 실패 — ${error.message} 입력한 내용은 유지했습니다.`); return false; }
  finally { setBusy(false); }
}

async function performImageAction(message, action, { save = true } = {}) {
  if (busy || !api.imageVideo) return;
  setBusy(true);
  setStatus(message);
  try {
    if (save && !(await persistImagePlan())) return;
    if (window.__studioFlow?.cancelled) return;
    const result = await action();
    if (!result) return;
    if (result.entry) { imageDraftDirty = false; renderEntry(result.entry, { focus: 'image-video' }); }
    if (result.canceled) { setStatus(result.message || '작업을 취소했습니다.'); return; }
    if (!result.ok) {
      const error = result.error || '이미지 영상 작업을 완료하지 못했습니다.';
      $('imageVideoError').textContent = error;
      $('imageVideoError').hidden = false;
      setStatus(error);
    } else if (result.message) setStatus(result.message);
    else setStatus('이미지 영상 작업을 반영했습니다.');
    await refreshHistory();
  } catch (error) {
    $('imageVideoError').textContent = error.message;
    $('imageVideoError').hidden = false;
    setStatus(`이미지 영상 작업 실패: ${error.message}`);
  } finally { setBusy(false); }
}

function bindImageVideoEvents() {
  for (const radio of document.querySelectorAll('input[name="creationMode"]')) {
    radio.addEventListener('change', () => {
      if (busy || !radio.checked) return;
      creationMode = radio.value;
      updateImageChoice(); saveForm();
      if (creationMode === 'image_video' && current) setTab('image-video');
    });
  }
  const prepare = () => performImageAction('보드에서 장면을 준비하는 중…', async () => {
    if (!current?.imageUrl) return;
    const result = await api.imageVideo.prepare({ id: current.id });
    return { ...result, message: '장면 준비 완료 — 생성할 장면을 선택하거나 클립을 가져오세요.' };
  });
  $('prepareImageVideoBtn').addEventListener('click', prepare);
  $('prepareScenesBtn').addEventListener('click', prepare);
  $('imageVideoProvider').addEventListener('change', () => {
    if (!imageDraft || busy) return;
    imageDraft.provider = $('imageVideoProvider').value;
    const provider = imageProvider();
    const durations = providerDurations(provider);
    for (const shot of imageDraft.shots) {
      if (!shot.imported && durations.length && !durations.includes(Number(shot.duration))) {
        shot.duration = durations.reduce((best, value) => Math.abs(value - shot.duration) < Math.abs(best - shot.duration) ? value : best, durations[0]);
      }
    }
    if (!(provider?.resolutions || []).includes(imageDraft.resolution)) imageDraft.resolution = provider?.resolutions?.[0] || '';
    markImageDraftDirty(); renderImageProvider(); renderSceneEditor(); refreshImageControls();
    setStatus('영상 서비스를 변경했습니다. 장면 길이와 해상도를 지원하는 값으로 맞췄습니다.');
  });
  $('imageVideoResolution').addEventListener('change', () => {
    if (!imageDraft || busy) return;
    imageDraft.resolution = $('imageVideoResolution').value; markImageDraftDirty();
  });
  for (const [id, field] of [['sceneTitle', 'title'], ['scenePrompt', 'prompt'], ['sceneDuration', 'duration']]) {
    $(id).addEventListener(field === 'duration' ? 'change' : 'input', () => {
      const shot = selectedImageShot();
      if (!shot || busy || IMAGE_PENDING_STATUSES.has(shot.status)) return;
      shot[field] = field === 'duration' ? Number($(id).value) : $(id).value;
      markImageDraftDirty();
      if (field === 'title') { renderSceneGrid(); refreshImageControls(); }
    });
  }
  $('saveScenePlanBtn').addEventListener('click', () => performImageAction('장면 설정을 저장하는 중…', async () => ({ ok: true, message: '장면 설정을 저장했습니다.' })));
  $('discardSceneEditsBtn').addEventListener('click', () => {
    if (!imageDraftDirty || !window.confirm('저장하지 않은 장면 설정을 취소할까요?')) return;
    performImageAction('저장된 장면을 불러오는 중…', async () => {
      const result = await api.historyGet(current.id);
      return { ...result, message: '저장된 장면 설정으로 되돌렸습니다.' };
    }, { save: false });
  });
  $('configureImageProviderBtn').addEventListener('click', () => performImageAction('구독 계정 연결을 확인하는 중…', async () => {
    const provider = imageDraft?.provider;
    if (!provider) return;
    const result = await api.imageVideo.configure({ provider });
    await loadImageProviders();
    return { ...result, message: result.message || (result.canceled ? '구독 연결 확인을 취소했습니다.'
      : result.configured ? '구독 계정 연결을 확인했습니다.' : '구독 계정 로그인 후 상태를 새로고침해 주세요.') };
  }, { save: false }));
  $('refreshImageProviderBtn').addEventListener('click', () => performImageAction('구독 계정 상태를 확인하는 중…', async () => {
    await loadImageProviders();
    return imageProvidersError ? { ok: false, error: imageProvidersError }
      : { ok: true, message: $('imageProviderStatus').textContent };
  }, { save: false }));
  $('disconnectImageProviderBtn').addEventListener('click', () => performImageAction('이 앱의 구독 연결을 해제하는 중…', async () => {
    const result = await api.imageVideo.disconnect({ provider: imageDraft.provider });
    await loadImageProviders();
    return { ...result, message: result.message || '이 앱의 연결을 해제했습니다. CLI 로그인과 기존 클립은 유지됩니다.' };
  }, { save: false }));
  for (const [id, kind] of [['imageProviderPricingBtn', 'pricingURL'], ['imageProviderSetupBtn', 'setupURL']]) {
    $(id).addEventListener('click', async () => {
      const url = imageProviderURL(kind);
      if (!url || busy) return;
      try { const result = await api.openExternal(url); if (!result.ok) setStatus(result.error); }
      catch (error) { setStatus(error.message); }
    });
  }
  $('generateScenesBtn').addEventListener('click', () => performImageAction('선택한 장면의 생성 요청을 준비하는 중…', async () => {
    const shotIds = imageGenerationShots(imageDraft).map(shot => shot.id);
    if (!shotIds.length) return { ok: true, message: '새로 생성할 미완료 장면이 없습니다.' };
    const result = await api.imageVideo.generate({ id: current.id, shotIds });
    return { ...result, message: '생성 요청을 반영했습니다. 진행 중인 장면은 상태 확인으로 불러오세요.' };
  }));
  $('refreshScenesBtn').addEventListener('click', () => performImageAction('진행 중인 장면의 상태를 확인하는 중…', () => api.imageVideo.refresh({ id: current.id })));
  $('recoverSceneBtn').addEventListener('click', () => performImageAction('서비스에 접수되지 않은 요청인지 확인해 주세요…', async () => {
    const shot = selectedImageShot();
    if (shot?.status !== 'uncertain') return;
    const result = await api.imageVideo.recover({ id: current.id, shotId: shot.id });
    return { ...result, message: '장면을 준비 상태로 되돌렸습니다. 새 생성은 생성 버튼을 눌러야 시작됩니다.' };
  }));
  $('importSceneClipBtn').addEventListener('click', () => performImageAction('장면에 사용할 클립을 선택해 주세요…', async () => {
    const shot = selectedImageShot();
    if (!shot) return;
    const result = await api.imageVideo.importClip({ id: current.id, shotId: shot.id });
    return { ...result, message: '선택한 장면에 클립을 가져왔습니다.' };
  }));
  $('exportImageVideoBtn').addEventListener('click', () => performImageAction('선택한 클립을 하나의 영상으로 합치는 중…', async () => {
    const musicSource = $('imageVideoMusicSource').value;
    if (musicSource === 'file' && !imageMusicFile) return { ok: false, error: '합칠 영상에 사용할 음악 파일을 먼저 선택해 주세요.' };
    return api.imageVideo.export({ id: current.id, options: {
      aspectRatio: current.input?.aspectRatio || $('aspect').value, quality: 'final', musicSource, musicFile: imageMusicFile
    } });
  }));
  $('imageVideoMusicSource').addEventListener('change', () => { updateImageChoice(); saveForm(); });
  $('pickImageMusicBtn').addEventListener('click', () => performImageAction('음악 파일을 선택해 주세요…', async () => {
    const result = await api.pickMusic();
    if (result.ok && !result.canceled) { imageMusicFile = result.file; updateImageChoice(); saveForm(); }
    return { ...result, message: '합칠 영상의 음악 파일을 선택했습니다.' };
  }));
  $('saveImageVideoBtn').addEventListener('click', () => performImageAction('이미지 영상을 저장하는 중…', async () => {
    const result = await api.videoSaveAs(current.id, 'image_video');
    return { ...result, message: result.saved ? '이미지 활용 영상을 저장했습니다.' : '저장이 취소되었습니다.' };
  }));
  $('revealImageVideoBtn').addEventListener('click', () => performImageAction('영상이 있는 폴더를 여는 중…', () => api.videoReveal(current.id, 'video', 'image_video')));
}

function applyAuth(status) {
  authState = status || { loggedIn: false };
  const badge = $('authBadge');
  const button = $('authBtn');
  if (authState.loggedIn) {
    const who = authState.email || 'ChatGPT 계정';
    const plan = authState.plan ? ` · ${authState.plan}` : '';
    badge.textContent = `로그인됨: ${who}${plan}`;
    badge.classList.add('logged');
    badge.classList.remove('logged-out');
    button.textContent = '로그아웃';
  } else {
    badge.textContent = authState.pending ? '브라우저 로그인 대기 중…' : 'ChatGPT 미로그인';
    badge.classList.remove('logged');
    badge.classList.add('logged-out');
    button.textContent = 'ChatGPT 로그인';
  }
  button.disabled = false;
}

function applyClaudeAuth(status) {
  claudeState = status || { loggedIn: false };
  const badge = $('claudeBadge');
  const button = $('claudeAuthBtn');
  if (claudeState.loggedIn) {
    const source = CLAUDE_SOURCE_LABELS[claudeState.source] ?? '';
    badge.textContent = `Claude 연결됨${source}`;
    badge.classList.add('logged');
    badge.classList.remove('logged-out');
    button.textContent = 'Claude 로그아웃';
  } else {
    badge.textContent = claudeState.pending ? 'Claude 로그인 진행 중…' : 'Claude 미로그인';
    badge.classList.remove('logged');
    badge.classList.add('logged-out');
    button.textContent = 'Claude 로그인';
  }
  button.disabled = false;
}

function updateModelBadge() {
  if (!envInfo) return;
  const provider = $('provider').value;
  $('modelBadge').textContent = provider === 'claude'
    ? `${envInfo.claudeModel} · ${CLAUDE_EFFORT_LABELS[selectedClaudeEffort()]}`
    : `${envInfo.model} · ${envInfo.reasoningEffort === 'xhigh' ? '초고추론(xhigh)' : envInfo.reasoningEffort}`;
}

function selectedClaudeEffort() {
  return Object.hasOwn(CLAUDE_EFFORT_LABELS, $('claudeEffort').value) ? $('claudeEffort').value : 'medium';
}

function updateRequestActivity(payload) {
  const seconds = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const elapsed = seconds(payload.elapsedSeconds);
  const state = ['connecting', 'accepted', 'thinking', 'writing', 'waiting'].includes(payload.state) ? payload.state : 'waiting';
  const labels = {
    connecting: 'Claude에 요청을 보내는 중…',
    accepted: 'Claude가 요청을 받았습니다. 결과를 기다리는 중…',
    thinking: 'Claude가 명세 구성을 검토하는 중…',
    writing: `명세 작성 중… ${seconds(payload.textCharacters).toLocaleString()}자 수신`,
    waiting: 'Claude 서버의 결과를 기다리는 중…'
  };
  const detail = $('requestDetail');
  detail.hidden = false;
  detail.textContent = `경과 ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초 · ` + (payload.lastActivitySeconds == null
    ? '서버 신호 수신 전' : `마지막 서버 신호 ${seconds(payload.lastActivitySeconds)}초 전`);
  if (elapsed >= 120 && !payload.textCharacters) detail.textContent += ' · 결과 본문은 아직 도착하지 않았습니다.';
  setStatus(labels[state]);
  if (state !== requestState) {
    appendLog(`\n[응답 상태] ${labels[state]}\n`);
    requestState = state;
  }
}

function handleProgress(payload) {
  if (payload.phase === 'spec_wait') { if (busy) updateRequestActivity(payload); return; }
  if (!['request', 'stream', 'spec_repair'].includes(payload.phase)) $('requestDetail').hidden = true;
  if (payload.kind === 'reasoning') { appendLog(payload.text); return; }
  if (payload.kind === 'text') {
    streamedChars += payload.text.length;
    setStatus(payload.phase === 'code_stream'
      ? `모델이 영상 연출을 작성하는 중… ${streamedChars.toLocaleString()}자 수신`
      : `명세 작성 중… ${streamedChars.toLocaleString()}자 수신`);
    return;
  }
  if (payload.phase === 'render' && payload.total) { showProgress(payload.done / payload.total); setStatus(payload.message); return; }
  if (['compose', 'repair', 'review', 'direct', 'script_fix', 'spec_repair'].includes(payload.phase)) streamedChars = 0;
  if (['request', 'spec_repair'].includes(payload.phase)) requestState = '';
  if (payload.message) {
    const label = PHASE_LABELS[payload.phase] || payload.phase;
    appendLog(`\n[${label}] ${payload.message}\n`);
    setStatus(payload.message);
  }
}

async function ensureLogin() {
  const res = await api.auth.status();
  if (res.ok) applyAuth(res.status);
  if (!res.ok || !res.status.loggedIn) {
    const hint = claudeState.loggedIn
      ? ' Claude로 생성하려면 "생성 모델"을 Claude로 바꿔 주세요.'
      : '';
    setStatus(`ChatGPT 로그인이 필요합니다. 상단의 "ChatGPT 로그인" 버튼을 눌러 주세요.${hint}`);
    return false;
  }
  return true;
}

async function ensureProviderLogin(provider) {
  if (provider === 'claude') {
    const res = await api.claude.status();
    if (res.ok) applyClaudeAuth(res.status);
    if (!res.ok || !res.status.loggedIn) {
      setStatus('Claude 로그인이 필요합니다. 상단의 "Claude 로그인" 버튼을 눌러 주세요.');
      return false;
    }
    return true;
  }
  return ensureLogin();
}

// 영상 단계(음악 → 모션 코드 → 검증·점검 → 렌더 → MP4). busy 관리는 호출자가 한다.
async function makeVideo(entry, input) {
  streamedChars = 0;
  setStatus('영상 제작 시작…');
  appendLog(`\n[영상] 코드 작성 모델: ${PROVIDER_LABELS[input.provider]} · 음악: ${input.musicSource} · 품질: ${input.quality}${entry.hasImage ? ' · 보드 이미지 참고' : ' · 이미지 없이'}\n`);
  const res = await api.video({ id: entry.id, options: videoOptions(input) });
  hideProgress();
  if (res.ok) {
    renderEntry(res.entry, { focus: 'video' });
  } else {
    appendLog(`\n[영상 실패] ${res.error}\n`);
    const got = await api.historyGet(entry.id);
    if (got.ok) renderEntry(got.entry, { focus: 'video' });
  }
  await refreshHistory();
  return res;
}

async function run() {
  if (busy) return;
  if (!(await saveImageEditsBeforeNavigation())) return;
  const imageMode = creationMode === 'image_video';
  const input = collectInput();
  if (!input.topic) {
    setStatus('주제를 입력해 주세요.');
    $('topic').focus();
    return;
  }
  if (input.withVideo && input.musicSource === 'file' && !input.musicFile) {
    setStatus('음악 파일을 선택하거나 음악 소스를 "Mixkit 자동 선택"으로 바꿔 주세요.');
    return;
  }
  if (!(await ensureProviderLogin(input.provider))) return;

  setBusy(true);
  clearLog();
  setStatus('가이드와 계정을 확인하는 중…');
  appendLog(`[입력]\n${JSON.stringify({ ...input, musicFile: input.musicFile ? baseName(input.musicFile) : '' }, null, 2)}\n\n`);
  const summary = [];

  try {
    const specRes = await api.spec(input);
    if (!specRes.ok) {
      setStatus(`실패: ${specRes.error}`);
      appendLog(`\n[실패] ${specRes.error}\n`);
      return;
    }
    let entry = specRes.entry;
    renderEntry(entry, { focus: 'concept' });
    appendLog(`\n[명세 완료] ${entry.title}\n`);
    await refreshHistory();

    // 보드 이미지: ChatGPT 는 기본, Claude 는 선택. 실패하거나 로그인이 없어도 영상 단계는 계속한다.
    if (wantsBoardImage(input.provider, input.mode, input.withImage)) {
      const chatgpt = await api.auth.status();
      if (chatgpt.ok) applyAuth(chatgpt.status);
      if (!chatgpt.ok || !chatgpt.status.loggedIn) {
        summary.push('ChatGPT 로그인이 없어 보드 이미지는 생략');
        appendLog('\n[이미지 생략] ChatGPT 로그인이 필요합니다.\n');
      } else {
        setStatus('보드 이미지 생성 중… (수 분이 걸릴 수 있습니다)');
        const boardRes = await api.board({ id: entry.id });
        if (boardRes.ok) {
          entry = boardRes.entry;
          renderEntry(entry, { focus: 'image' });
          summary.push('보드 이미지 완료');
        } else {
          renderEntry({ ...entry, imageError: boardRes.error });
          summary.push(`보드 이미지 실패(${boardRes.error})`);
          appendLog(`\n[이미지 실패] ${boardRes.error}\n`);
        }
        await refreshHistory();
      }
    }

    if (imageMode && !window.__studioFlow?.cancelled) {
      if (entry.imageUrl) {
        const prepared = await api.imageVideo.prepare({ id: entry.id });
        if (prepared.ok) {
          renderEntry(prepared.entry, { focus: 'image-video' });
          summary.push('장면 준비 완료 — 원하는 장면을 선택해 영상을 생성하세요');
        } else {
          summary.push(`장면 준비 실패: ${prepared.error}`);
        }
      } else {
        setTab('image');
        summary.push('보드 이미지를 가져오면 영상 장면을 준비할 수 있습니다');
      }
    } else if (input.withVideo) {
      const videoRes = await makeVideo(entry, input);
      summary.push(videoRes.ok ? '영상 완료' : `영상 실패: ${videoRes.error}`);
    }
    setStatus(`완료 — ${entry.title}${summary.length ? ` · ${summary.join(' · ')}` : ''}`);
  } catch (error) {
    setStatus(`예기치 않은 오류: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function remakeVideo() {
  if (busy) return;
  if (!current) {
    setStatus('영상을 만들 기록이 없습니다. 명세를 먼저 생성하거나 기록에서 불러와 주세요.');
    return;
  }
  const input = collectInput();
  if (input.musicSource === 'file' && !input.musicFile) {
    setStatus('음악 파일을 선택하거나 음악 소스를 바꿔 주세요.');
    return;
  }
  if (!(await ensureProviderLogin(input.provider))) return;
  setBusy(true);
  clearLog();
  try {
    const res = await makeVideo(current, input);
    setStatus(res.ok ? `영상 완성 — ${res.entry.title}` : `영상 실패: ${res.error}`);
  } finally {
    setBusy(false);
  }
}

async function regenerateImage() {
  if (busy || !current) return;
  if (!(await saveImageEditsBeforeNavigation())) return;
  if (!(await ensureLogin())) return;
  const isRetry = Boolean(current.imageUrl || current.imageError);
  setBusy(true);
  setStatus(isRetry ? '보드 이미지를 다시 생성하는 중…' : '현재 명세로 보드 이미지를 생성하는 중…');
  try {
    const res = await api.board({ id: current.id, aspectRatio: current.input?.aspectRatio });
    if (!res.ok) {
      current.imageError = res.error;
      renderImage(current);
      setStatus(`이미지 재생성 실패: ${res.error}`);
    } else {
      renderEntry(res.entry, { focus: 'image' });
      setStatus(isRetry ? '보드 이미지를 다시 생성했습니다.' : '보드 이미지를 생성했습니다.');
    }
    await refreshHistory();
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  bindImageVideoEvents();
  $('runBtn').addEventListener('click', run);
  $('cancelBtn').addEventListener('click', async () => {
    await api.cancel();
    setStatus('취소 요청을 보냈습니다…');
  });

  $('authBtn').addEventListener('click', async () => {
    const button = $('authBtn');
    button.disabled = true;
    if (authState.loggedIn) {
      const res = await api.auth.logout();
      if (res.ok) {
        applyAuth(res.status);
        setStatus('로그아웃했습니다.');
      } else {
        button.disabled = false;
        setStatus(res.error);
      }
      return;
    }
    button.textContent = '브라우저에서 로그인 대기…';
    setStatus('브라우저가 열립니다. ChatGPT 로그인을 완료해 주세요. (5분 내)');
    const res = await api.auth.login();
    if (res.ok) {
      applyAuth(res.status);
      setStatus(`로그인 완료 — ${res.status.email || 'ChatGPT 계정'}`);
    } else {
      applyAuth(null);
      setStatus(`로그인 실패: ${res.error}`);
    }
  });

  $('claudeAuthBtn').addEventListener('click', async () => {
    const button = $('claudeAuthBtn');
    button.disabled = true;
    if (claudeState.loggedIn) {
      const res = await api.claude.logout();
      if (res.ok) {
        applyClaudeAuth(res.status);
        setStatus('Claude 로그아웃했습니다.');
      } else {
        button.disabled = false;
        setStatus(res.error);
      }
      return;
    }
    button.textContent = '브라우저 승인 대기…';
    setStatus('브라우저에서 Claude 승인 후 표시되는 코드를 붙여넣어 주세요.');
    const res = await api.claude.loginStart();
    if (res.ok) {
      $('claudeCodeInput').value = '';
      $('claudeCodeInput').classList.remove('failed');
      $('claudeLoginBox').hidden = false;
      $('claudeCodeInput').focus();
      applyClaudeAuth({ loggedIn: false, pending: true });
      setStatus('브라우저에서 승인한 뒤 표시되는 "코드#state" 전체를 붙여넣고 확인을 누르세요. (10분 내)');
    } else {
      applyClaudeAuth(null);
      setStatus(`Claude 로그인 시작 실패: ${res.error}`);
    }
  });

  $('claudeCodeSubmit').addEventListener('click', async () => {
    const input = $('claudeCodeInput');
    const code = input.value.trim();
    if (!code) {
      input.focus();
      return;
    }
    $('claudeCodeSubmit').disabled = true;
    setStatus('Claude 토큰을 교환하는 중…');
    const res = await api.claude.loginComplete(code);
    $('claudeCodeSubmit').disabled = false;
    if (res.ok) {
      $('claudeLoginBox').hidden = true;
      applyClaudeAuth(res.status);
      if ($('provider').value !== 'claude' && !authState.loggedIn) {
        $('provider').value = 'claude';
        updateModelBadge();
        saveForm();
        setStatus('Claude 로그인 완료 — ChatGPT 로그인이 없어 생성 모델을 Claude로 전환했습니다.');
      } else {
        setStatus('Claude 로그인 완료 — 이제 Claude로 명세를 생성할 수 있습니다.');
      }
    } else {
      input.classList.add('failed');
      setStatus(`Claude 로그인 실패: ${res.error}`);
    }
  });

  $('claudeCodeCancel').addEventListener('click', async () => {
    await api.claude.loginCancel();
    $('claudeLoginBox').hidden = true;
    $('claudeCodeInput').classList.remove('failed');
    applyClaudeAuth({ loggedIn: false });
    setStatus('Claude 로그인을 취소했습니다.');
  });

  $('provider').addEventListener('change', () => {
    updateModelBadge();
    updateImageChoice();
    saveForm();
  });

  $('claudeEffort').addEventListener('change', () => { updateModelBadge(); updateImageChoice(); saveForm(); });

  for (const id of ['withImage', 'withVideo', 'review', 'musicSource', 'mode']) {
    $(id).addEventListener('change', () => {
      updateImageChoice();
      saveForm();
    });
  }

  $('pickMusicBtn').addEventListener('click', async () => {
    const res = await api.pickMusic();
    if (!res.ok) {
      setStatus(res.error);
      return;
    }
    if (res.canceled) return;
    musicFile = res.file;
    updateImageChoice();
    saveForm();
    setStatus(`음악 파일 선택: ${baseName(musicFile)} — 사용 권한은 직접 확인해 주세요.`);
  });

  $('makeVideoBtn').addEventListener('click', remakeVideo);

  $('installFfmpegBtn').addEventListener('click', async () => {
    const button = $('installFfmpegBtn');
    button.disabled = true;
    $('spinner').hidden = false;
    try {
      const res = await api.installFfmpeg();
      if (!res.ok) setStatus(`ffmpeg 설치 실패: ${res.error}`);
      else if (res.canceled) setStatus('ffmpeg 설치를 취소했습니다.');
      else {
        applyFfmpeg(res.ffmpeg);
        setStatus('ffmpeg 설치 완료 — 이제 영상을 만들 수 있습니다.');
      }
    } finally {
      button.disabled = false;
      $('spinner').hidden = !busy;
    }
  });

  $('saveVideoBtn').addEventListener('click', async () => {
    if (!current) return;
    const res = await api.videoSaveAs(current.id);
    if (res.ok && res.saved) setStatus(`영상을 저장했습니다: ${res.filePath}`);
    else if (res.ok) setStatus('저장이 취소되었습니다.');
    else setStatus(res.error);
  });

  $('revealVideoBtn').addEventListener('click', async () => {
    if (!current) return;
    const res = await api.videoReveal(current.id, 'video');
    if (!res.ok) setStatus(res.error);
  });

  $('revealCodeBtn').addEventListener('click', async () => {
    if (!current) return;
    const res = await api.videoReveal(current.id, 'code');
    if (!res.ok) setStatus(res.error);
  });

  $('dataDirBtn').addEventListener('click', () => api.openDataDir());

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  }

  $('copyYamlBtn').addEventListener('click', async () => {
    if (!current?.yaml) return;
    const ok = await copyText(current.yaml);
    setStatus(ok ? 'YAML 명세를 클립보드에 복사했습니다.' : '복사에 실패했습니다.');
  });

  $('copyPromptBtn').addEventListener('click', async () => {
    if (!current?.imagePrompt) return;
    const ok = await copyText(current.imagePrompt);
    setStatus(ok ? '이미지 지시문을 클립보드에 복사했습니다.' : '복사에 실패했습니다.');
  });

  $('saveImageBtn').addEventListener('click', async () => {
    if (!current) return;
    const res = await api.imageSaveAs(current.id);
    if (res.ok && res.saved) setStatus(`이미지를 저장했습니다: ${res.filePath}`);
    else if (res.ok) setStatus('저장이 취소되었습니다.');
    else setStatus(res.error);
  });

  $('revealBtn').addEventListener('click', async () => {
    if (!current) return;
    const res = await api.reveal(current.id);
    if (!res.ok) setStatus(res.error);
  });

  $('regenImageBtn').addEventListener('click', regenerateImage);

  $('importImageBtn').addEventListener('click', async () => {
    if (busy || !(await saveImageEditsBeforeNavigation())) return;
    if (!current) {
      setStatus('이미지를 붙일 기록이 없습니다. 명세를 먼저 생성하거나 기록에서 불러와 주세요.');
      return;
    }
    const res = await api.imageImport(current.id);
    if (!res.ok) {
      setStatus(`이미지 가져오기 실패: ${res.error}`);
      return;
    }
    if (res.canceled) return;
    renderEntry(res.entry, { focus: 'image' });
    await refreshHistory();
    setStatus('외부 이미지를 가져와 기록에 붙였습니다.');
  });

  for (const field of FORM_FIELDS) {
    const el = $(field);
    if (el) el.addEventListener('change', saveForm);
  }
}

async function init() {
  restoreForm();
  updateImageChoice();
  bindEvents();
  api.onProgress(handleProgress);
  api.onAuth((status) => applyAuth(status));
  api.onClaudeAuth((status) => applyClaudeAuth(status));

  const env = await api.env();
  if (env.ok) {
    envInfo = env;
    updateModelBadge();
  } else {
    setStatus(`가이드 로드 실패: ${env.error}`);
  }

  const res = await api.auth.status();
  if (res.ok) applyAuth(res.status);
  else applyAuth(null);
  const claudeRes = await api.claude.status();
  if (claudeRes.ok) applyClaudeAuth(claudeRes.status);
  else applyClaudeAuth(null);
  await refreshHistory();
  await loadImageProviders();
  renderImageVideo(current);
}

if (typeof module === 'object' && module.exports) {
  module.exports = { imagePlanPayload, copyImagePlan, imageGenerationShots, imageSelection };
} else {
  init();
}
