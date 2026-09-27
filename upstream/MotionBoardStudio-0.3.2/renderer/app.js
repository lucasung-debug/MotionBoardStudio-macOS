'use strict';

const $ = (id) => document.getElementById(id);
const api = window.studio;
const FORM_KEY = 'motion-board-studio.form.v1';
const FORM_FIELDS = ['topic', 'provider', 'mood', 'style', 'copy', 'avoid', 'aspect', 'duration', 'dataNote', 'mode', 'extra', 'musicSource', 'quality', 'engine'];
const FORM_CHECKS = ['withImage', 'withVideo', 'review'];
const PROVIDER_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude' };
const CLAUDE_SOURCE_LABELS = { oauth: '', env: ' (환경변수 토큰)' };

const PHASE_LABELS = {
  prepare: '준비',
  request: '요청',
  stream: '수신',
  parse: '해석',
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
}

// 이번 실행에서 보드 이미지를 만들지: ChatGPT 는 전체/이미지 모드에서 항상, Claude 는 체크했을 때만(선택).
function wantsBoardImage(provider, mode, withImage) {
  if (!(mode === 'full' || mode === 'image_only')) return false;
  return provider !== 'claude' || mode === 'image_only' || withImage;
}

function runLabel() {
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
  $('runBtn').textContent = value ? '생성 중…' : runLabel();
  if (!value) hideProgress();
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
    mood: $('mood').value.trim(),
    style: $('style').value.trim(),
    copy: $('copy').value.trim(),
    avoid: $('avoid').value.trim(),
    aspectRatio: $('aspect').value,
    durationSeconds: Number($('duration').value) || 30,
    dataNote: $('dataNote').value.trim(),
    mode: $('mode').value,
    withImage: $('withImage').checked,
    extra: $('extra').value.trim(),
    withVideo: $('withVideo').checked,
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
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop();
}

// Claude는 이미지 생성 기능이 없다. 보드 이미지는 GPT 이미지로 "선택"하고, 끄면 명세로 바로 영상을 만든다.
function updateImageChoice() {
  $('withImageRow').hidden = $('provider').value !== 'claude';
  $('videoOptions').hidden = !$('withVideo').checked;
  $('musicFileRow').hidden = $('musicSource').value !== 'file';
  $('musicFileName').textContent = musicFile ? baseName(musicFile) : '선택된 파일 없음';
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
      ? `이미지 생성 실패: ${entry.imageError}  — "이미지만 다시 생성"으로 재시도할 수 있습니다.`
      : '보드 이미지가 아직 없습니다. 아래 "외부 이미지 가져오기"로 다른 도구(GPT 웹 등)에서 만든 이미지를 붙이거나, ChatGPT 로그인 후 "이미지만 다시 생성"을 사용하세요.';
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
  sub.textContent = `${providerLabel} · ${entry.topic || ''} · ${formatDate(entry.createdAt)}${entry.hasVideo ? ' · 영상' : ''}${entry.imageError ? ' · 이미지 실패' : ''}${entry.videoError && !entry.hasVideo ? ' · 영상 실패' : ''}`;
  info.append(title, sub);

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'btn mini';
  openBtn.type = 'button';
  openBtn.textContent = '열기';
  openBtn.addEventListener('click', async () => {
    const res = await api.historyGet(entry.id);
    if (res.ok) {
      renderEntry(res.entry, { focus: 'concept' });
      setStatus(`기록 불러옴 — ${res.entry.title}`);
    } else {
      setStatus(res.error);
    }
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'btn mini danger';
  delBtn.type = 'button';
  delBtn.textContent = '삭제';
  delBtn.addEventListener('click', async () => {
    const res = await api.historyRemove(entry.id);
    if (res.ok) {
      if (current?.id === entry.id) current = null;
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
    ? `${envInfo.claudeModel} · effort ${envInfo.claudeEffort}`
    : `${envInfo.model} · ${envInfo.reasoningEffort === 'xhigh' ? '초고추론(xhigh)' : envInfo.reasoningEffort}`;
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

    if (input.withVideo) {
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
  if (!(await ensureLogin())) return;
  setBusy(true);
  setStatus('보드 이미지를 다시 생성하는 중…');
  try {
    const res = await api.board({ id: current.id, aspectRatio: current.input?.aspectRatio });
    if (!res.ok) {
      current.imageError = res.error;
      renderImage(current);
      setStatus(`이미지 재생성 실패: ${res.error}`);
    } else {
      renderEntry(res.entry, { focus: 'image' });
      setStatus('보드 이미지를 다시 생성했습니다.');
    }
    await refreshHistory();
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
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
  api.onProgress((payload) => {
    if (payload.kind === 'reasoning') {
      appendLog(payload.text);
      return;
    }
    if (payload.kind === 'text') {
      streamedChars += payload.text.length;
      setStatus(payload.phase === 'code_stream'
        ? `모델이 영상 연출을 작성하는 중… ${streamedChars.toLocaleString()}자 수신`
        : `명세 작성 중… ${streamedChars.toLocaleString()}자 수신`);
      return;
    }
    if (payload.phase === 'render' && payload.total) {
      showProgress(payload.done / payload.total);
      setStatus(payload.message);
      return;
    }
    if (['compose', 'repair', 'review', 'direct', 'script_fix'].includes(payload.phase)) streamedChars = 0;
    if (payload.message) {
      const label = PHASE_LABELS[payload.phase] || payload.phase;
      appendLog(`\n[${label}] ${payload.message}\n`);
      setStatus(payload.message);
    }
  });
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
}

init();
