'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, net, protocol, nativeImage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const auth = require('./lib/chatgpt-auth.cjs');
const claudeAuth = require('./lib/claude-auth.cjs');
const codex = require('./lib/codex.cjs');
const claude = require('./lib/claude.cjs');
const prompt = require('./lib/prompt.cjs');
const store = require('./lib/store.cjs');
const LLMErrors = require('./lib/llm-errors.cjs');
const videoPipeline = require('./lib/video/pipeline.cjs');
const videoRender = require('./lib/video/render.cjs');
const videoCompose = require('./lib/video/compose.cjs');
const ffmpegLib = require('./lib/video/ffmpeg.cjs');
const { mediaResponse } = require('./lib/video/media-response.cjs');
const { withImageFallback } = require('./lib/video/llm-fallback.cjs');

const PROVIDER_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude' };

function normalizeProvider(value) {
  return String(value) === 'claude' ? 'claude' : 'chatgpt';
}

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const IMAGE_SCHEME = 'studio-image';
const VIDEO_SCHEME = 'studio-video';
const SMOKE = process.argv.includes('--smoke');
// 테스트 모드는 단일 인스턴스 락을 쓰지 않는다 — 사용자가 앱을 켜 둔 상태에서도
// 검증이 막히지 않고, 사용자의 실행 중인 창을 건드리지 않는다.
const ISOLATED_MODE = SMOKE;

let mainWindow = null;
let currentRun = null;

// 포터블 exe(electron-builder portable)는 exe 옆 폴더에 로그인·기록을 둔다.
// 어느 PC에서든 로그아웃 상태로 시작하고, 데이터가 exe 와 함께 다닌다(토큰은 OS 보안 저장소로
// 암호화되어 다른 PC·다른 Windows 계정에서는 풀리지 않는다).
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR;
if (PORTABLE_DIR) app.setPath('userData', path.join(PORTABLE_DIR, '모션보드 스튜디오 데이터'));

if (SMOKE) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: VIDEO_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

function userData() {
  return app.getPath('userData');
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('studio:progress', payload);
  }
}

function progressFor(run) {
  return (payload) => sendProgress({ runId: run.id, ...payload });
}

function fail(error) {
  return { ok: false, error: LLMErrors.userMessage(error), code: error?.code || '' };
}

function entrySummary(entry) {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt || entry.createdAt,
    topic: entry.input?.topic || '',
    title: entry.title,
    provider: entry.provider || 'chatgpt',
    mode: entry.mode,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    imageModel: entry.imageModel || '',
    imageNote: entry.imageNote || '',
    hasImage: Boolean(entry.imagePath),
    imageUrl: entry.imagePath ? store.imageUrlForPath(entry.imagePath) : '',
    imageError: entry.imageError || '',
    fallbackReason: entry.fallbackReason || '',
    hasVideo: Boolean(entry.videoPath && fs.existsSync(entry.videoPath)),
    videoUrl: entry.videoPath ? store.videoUrlFor(entry.videoPath, userData()) : '',
    posterUrl: entry.posterPath ? store.videoUrlFor(entry.posterPath, userData()) : '',
    videoError: entry.videoError || '',
    videoModel: entry.videoModel || '',
    videoProvider: entry.videoProvider || '',
    videoMeta: entry.videoMeta || null
  };
}

function publicEntry(entry) {
  return { ...entrySummary(entry), input: entry.input, concept: entry.concept, yaml: entry.yaml, imagePrompt: entry.imagePrompt, notes: entry.notes || [] };
}

function normalizeMode(value) {
  return ['full', 'image_only', 'spec_only'].includes(String(value)) ? String(value) : 'full';
}

async function runSpec(input) {
  if (currentRun) throw new Error('이미 생성이 진행 중입니다. 완료되거나 취소된 뒤에 다시 시도해 주세요.');
  const run = { id: crypto.randomUUID(), controller: new AbortController() };
  currentRun = run;
  const progress = progressFor(run);
  const provider = normalizeProvider(input?.provider);
  try {
    progress({ phase: 'prepare', message: `${PROVIDER_LABELS[provider]} 로그인과 가이드를 확인하는 중…` });
    const guide = prompt.loadGuide(PROMPTS_DIR);
    const mode = normalizeMode(input.mode);
    const contractMode = mode === 'image_only' ? 'image_only' : 'full';
    const instructions = prompt.buildInstructions({ guide: guide.content, mode: contractMode });
    const userText = prompt.buildUserMessage({ ...input, mode });
    let result;
    if (provider === 'claude') {
      const { token } = await claudeAuth.getAuth();
      progress({ phase: 'request', message: `Claude ${claude.DEFAULT_MODEL} (effort ${claude.DEFAULT_EFFORT})에 제작 명세를 요청했습니다. 깊은 추론에는 몇 분이 걸릴 수 있습니다…` });
      result = await claude.chat({
        token,
        instructions,
        userText,
        model: claude.DEFAULT_MODEL,
        effort: claude.DEFAULT_EFFORT,
        signal: run.controller.signal,
        onDelta: (delta) => progress({ phase: 'stream', kind: delta.kind, text: delta.text, message: delta.kind === 'status' ? delta.text : undefined })
      });
      result = { content: result.content, model: result.model, requestedModel: claude.DEFAULT_MODEL, reasoningEffort: result.effort, fallbackReason: '' };
    } else {
      const { accessToken, accountId } = await auth.getAuth();
      progress({ phase: 'request', message: `GPT-6 Astra (xhigh)에 제작 명세를 요청했습니다. 깊은 추론에는 몇 분이 걸릴 수 있습니다…` });
      result = await codex.chat({
        accessToken,
        accountId,
        instructions,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] }],
        model: codex.DEFAULT_MODEL,
        reasoningEffort: codex.DEFAULT_REASONING,
        signal: run.controller.signal,
        onDelta: (delta) => progress({ phase: 'stream', kind: delta.kind, text: delta.text, message: delta.kind === 'status' ? delta.text : undefined })
      });
    }
    progress({ phase: 'parse', message: '응답을 해석해 제작 명세를 정리하는 중…' });
    let parsed;
    try {
      parsed = prompt.normalizeResult(codex.extractJson(result.content), { mode: contractMode });
    } catch (error) {
      const rawFile = path.join(store.baseDir(userData()), `failed-response-${Date.now()}.txt`);
      await fsp.mkdir(path.dirname(rawFile), { recursive: true }).catch(() => {});
      await fsp.writeFile(rawFile, [
        `provider: ${provider}`,
        `model: ${result.model || ''}`,
        `stopReason: ${result.stopReason || result.reasoningEffort || ''}`,
        '',
        result.content
      ].join('\n')).catch(() => {});
      progress({ phase: 'parse', message: `응답 해석에 실패해 원문을 저장했습니다: ${rawFile}` });
      throw error;
    }
    const entry = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      input: { ...input, mode },
      provider,
      title: parsed.title,
      concept: parsed.concept,
      yaml: parsed.yaml,
      imagePrompt: parsed.imagePrompt,
      notes: parsed.notes,
      model: result.model,
      requestedModel: result.requestedModel,
      reasoningEffort: result.reasoningEffort,
      fallbackReason: result.fallbackReason || '',
      guideName: guide.name,
      imagePath: '',
      imageModel: '',
      imageNote: '',
      imageError: ''
    };
    await store.addEntry(userData(), entry);
    progress({ phase: 'spec_done', message: `명세 생성 완료 — ${entry.title}`, entryId: entry.id });
    return entry;
  } finally {
    currentRun = null;
  }
}

async function runBoard({ id, promptOverride, aspectRatio }) {
  if (currentRun) throw new Error('이미 생성이 진행 중입니다. 완료되거나 취소된 뒤에 다시 시도해 주세요.');
  const entries = await store.readHistory(userData());
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error('기록을 찾을 수 없습니다. 명세를 먼저 생성해 주세요.');
  const boardPrompt = String(promptOverride || entry.imagePrompt || '').trim();
  if (!boardPrompt) throw new Error('이미지 지시문이 없습니다. 명세를 다시 생성해 주세요.');

  // 이미 한도 초과가 확인된 ChatGPT 계정이면 매달리지 않고 즉시 안내한다.
  const state = await store.readState(userData()).catch(() => ({}));
  const limitUntil = Number(state.chatgptLimitUntil) || 0;
  if (limitUntil > Date.now()) {
    throw new Error(`ChatGPT 사용량 한도로 ${new Date(limitUntil).toLocaleString('ko-KR')}까지 이미지 자동 생성이 불가능합니다. 지시문을 복사해 외부 도구에서 만든 뒤 "외부 이미지 가져오기"를 사용해 주세요.`);
  }

  const run = { id: crypto.randomUUID(), controller: new AbortController() };
  currentRun = run;
  const progress = progressFor(run);
  try {
    progress({ phase: 'image_prepare', message: 'ChatGPT 이미지 생성(4×4 디자인 보드)을 준비하는 중…' });
    let chatgptAuth;
    try {
      chatgptAuth = await auth.getAuth();
    } catch {
      throw new Error('디자인 보드 이미지 생성에는 ChatGPT 로그인이 필요합니다. 상단의 "ChatGPT 로그인"을 먼저 완료해 주세요.');
    }
    const { accessToken, accountId } = chatgptAuth;
    const aspect = String(aspectRatio || entry.input?.aspectRatio || '1:1');
    const size = codex.openaiSizeFor(aspect);
    const result = await codex.generateImage({
      accessToken,
      accountId,
      prompt: boardPrompt,
      size,
      model: codex.DEFAULT_MODEL,
      signal: run.controller.signal,
      onProgress: (event) => {
        if (event.phase === 'image_partial') progress({ phase: 'image_stream', message: '보드 이미지를 그리는 중…' });
      }
    });
    const file = store.imagePathFor(userData(), entry.id);
    await store.ensureDirs(userData());
    await fsp.writeFile(file, result.buffer);
    const updated = await store.updateEntry(userData(), entry.id, {
      imagePath: file,
      imageModel: result.model,
      imageNote: result.fallbackReason || '',
      imageError: ''
    });
    progress({ phase: 'image_done', message: '디자인 보드 이미지 생성 완료', entryId: entry.id });
    return updated;
  } catch (error) {
    if (error?.code === 'LLM_USAGE_LIMIT') {
      const until = Number(error.resetAt) || Date.now() + 24 * 3600 * 1000;
      const prev = await store.readState(userData()).catch(() => ({}));
      await store.writeState(userData(), {
        ...prev,
        chatgptLimitUntil: until,
        chatgptLimitMessage: LLMErrors.userMessage(error)
      }).catch(() => {});
    }
    await store.updateEntry(userData(), entry.id, { imageError: LLMErrors.userMessage(error) }).catch(() => {});
    throw error;
  } finally {
    currentRun = null;
  }
}

// 모델에 보낼 이미지(보드·프레임 시트): 긴 변 1568px 이하 JPEG.
async function loadImageForModel(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`이미지를 읽을 수 없습니다: ${path.basename(file)}`);
  const { width, height } = img.getSize();
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : img;
  return { mediaType: 'image/jpeg', data: out.toJPEG(88).toString('base64') };
}

// 영상 단계의 LLM 호출(연출 스크립트 또는 모션 코드). Claude 는 이미지 없이도(명세만으로) 바로 진행한다.
// directive: 단계별 마지막 출력 지시(연출 = JSON, 자유 코드 = 태그 블록).
function videoLlm(provider, run, progress) {
  const onDelta = (delta) => progress({ phase: 'code_stream', kind: delta.kind, text: delta.text, message: delta.kind === 'status' ? delta.text : undefined });
  if (provider === 'claude') {
    return async ({ instructions, userText, images, directive }) => {
      const { token } = await claudeAuth.getAuth();
      const result = await claude.chat({
        token, instructions, userText, images,
        finalDirective: directive || videoCompose.OUTPUT_DIRECTIVE,
        model: claude.DEFAULT_MODEL,
        effort: claude.DEFAULT_EFFORT,
        signal: run.controller.signal,
        onDelta
      });
      return { content: result.content, model: result.model };
    };
  }
  const ask = async ({ instructions, userText, images, directive }) => {
    const { accessToken, accountId } = await auth.getAuth();
    const content = [
      { type: 'input_text', text: `${userText}\n\n---\n\n${directive || videoCompose.OUTPUT_DIRECTIVE}` },
      ...(images || []).map((img) => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` }))
    ];
    const result = await codex.chat({
      accessToken, accountId, instructions,
      input: [{ type: 'message', role: 'user', content }],
      model: codex.DEFAULT_MODEL,
      reasoningEffort: codex.DEFAULT_REASONING,
      signal: run.controller.signal,
      onDelta
    });
    return { content: result.content, model: result.model };
  };
  // ChatGPT 만으로도 영상이 끝까지 나오도록: 보드 이미지 첨부가 거부되면 명세(텍스트)만으로 다시 요청한다.
  return withImageFallback(ask, {
    isTerminal: (error) => LLMErrors.isTerminal(error),
    isCancelled: () => run.controller.signal.aborted,
    onFallback: (error) => progress({ phase: 'compose', message: `보드 이미지 첨부 요청이 실패해 명세만으로 다시 요청합니다: ${LLMErrors.userMessage(error).slice(0, 160)}` })
  });
}

async function runVideo({ id, options = {} }) {
  if (currentRun) throw new Error('이미 생성이 진행 중입니다. 완료되거나 취소된 뒤에 다시 시도해 주세요.');
  const entries = await store.readHistory(userData());
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error('기록을 찾을 수 없습니다. 명세를 먼저 생성해 주세요.');
  if (!entry.yaml && !entry.imagePrompt) throw new Error('영상을 만들 제작 명세가 없습니다. 명세를 먼저 생성해 주세요.');
  const provider = normalizeProvider(options.provider || entry.provider);
  const run = { id: crypto.randomUUID(), controller: new AbortController() };
  currentRun = run;
  const progress = progressFor(run);
  const baseDir = store.videoDirFor(userData(), entry.id);
  const workDir = path.join(baseDir, `run-${Date.now()}`);
  try {
    progress({ phase: 'video_prepare', message: `영상 제작 준비 — 코드 작성 모델: ${PROVIDER_LABELS[provider]}${entry.imagePath ? ' · 보드 이미지 참고' : ' · 이미지 없이 명세로 바로'}` });
    const result = await videoPipeline.runVideo({
      entry,
      options,
      workDir,
      cacheDir: store.musicCacheDir(userData()),
      llm: videoLlm(provider, run, progress),
      loadImage: loadImageForModel,
      renderer: videoRender,
      progress,
      signal: run.controller.signal
    });
    // 새 영상이 완성된 뒤에만 이전 실행 폴더를 정리한다(실패 시 기존 영상 유지).
    for (const name of await fsp.readdir(baseDir).catch(() => [])) {
      if (name.startsWith('run-') && path.join(baseDir, name) !== workDir) {
        await fsp.rm(path.join(baseDir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
    const updated = await store.updateEntry(userData(), entry.id, {
      videoPath: result.videoPath,
      posterPath: result.posterPath,
      compositionPath: result.compositionPath,
      videoMeta: result.meta,
      videoModel: result.model || '',
      videoProvider: provider,
      videoError: ''
    });
    progress({ phase: 'video_done', message: `영상 완성 — ${result.meta.T.toFixed(2)}초 · ${result.meta.frames}프레임 · ${result.meta.totalSeconds}초 소요`, entryId: entry.id });
    return updated;
  } catch (error) {
    await store.updateEntry(userData(), entry.id, { videoError: LLMErrors.userMessage(error) }).catch(() => {});
    // 실패한 실행 폴더는 원인 확인용으로 남긴다(코드·검증 결과). 취소한 경우만 지운다.
    if (run.controller.signal.aborted) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    currentRun = null;
  }
}

function registerIpc() {
  ipcMain.handle('studio:env', () => ({
    ok: true,
    ffmpeg: ffmpegLib.locate(),
    model: codex.DEFAULT_MODEL,
    reasoningEffort: codex.DEFAULT_REASONING,
    claudeModel: claude.DEFAULT_MODEL,
    claudeEffort: claude.DEFAULT_EFFORT,
    guideName: prompt.loadGuide(PROMPTS_DIR).name,
    appVersion: app.getVersion(),
    dataDir: store.baseDir(userData())
  }));

  ipcMain.handle('studio:guide', () => {
    try {
      const guide = prompt.loadGuide(PROMPTS_DIR);
      return { ok: true, name: guide.name, content: guide.content };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:authStatus', async () => {
    try {
      return { ok: true, status: await auth.status() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:authLogin', async () => {
    try {
      return { ok: true, status: await auth.login() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:authLogout', async () => {
    try {
      return { ok: true, status: await auth.logout() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:claudeStatus', async () => {
    try {
      return { ok: true, status: await claudeAuth.status() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:claudeLoginStart', async () => {
    try {
      return { ok: true, ...(await claudeAuth.loginStart()) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:claudeLoginComplete', async (_event, { code } = {}) => {
    try {
      return { ok: true, status: await claudeAuth.loginComplete(code) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:claudeLoginCancel', () => {
    claudeAuth.cancelLogin();
    return { ok: true };
  });

  ipcMain.handle('studio:claudeLogout', async () => {
    try {
      return { ok: true, status: await claudeAuth.logout() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:spec', async (_event, input) => {
    try {
      const entry = await runSpec(input || {});
      return { ok: true, entry: publicEntry(entry) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:board', async (_event, input) => {
    try {
      const entry = await runBoard(input || {});
      return { ok: true, entry: publicEntry(entry) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:video', async (_event, input) => {
    try {
      const entry = await runVideo(input || {});
      return { ok: true, entry: publicEntry(entry) };
    } catch (error) {
      return fail(error);
    }
  });

  // ffmpeg 가 없는 PC 에서 버튼 한 번으로 설치(winget). 사용자가 확인한 뒤에만 실행한다.
  ipcMain.handle('studio:installFfmpeg', async () => {
    try {
      const existing = ffmpegLib.locate({ refresh: true });
      if (existing) return { ok: true, ffmpeg: existing };
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['설치', '취소'],
        defaultId: 0,
        cancelId: 1,
        title: 'ffmpeg 설치',
        message: '영상 제작에 필요한 ffmpeg를 설치할까요?',
        detail: `Windows 기본 도구 winget으로 "${ffmpegLib.WINGET_ID}"(Gyan.dev 빌드, GPL 라이선스)를 설치합니다. 약 100MB를 내려받고 1~3분 걸립니다. 설치하면 해당 패키지의 라이선스 조건에 동의하는 것으로 처리됩니다.`
      });
      if (answer.response !== 0) return { ok: true, canceled: true };
      sendProgress({ phase: 'ffmpeg', message: 'ffmpeg 설치 중… (winget)' });
      let last = 0;
      const found = await ffmpegLib.installWithWinget({
        onLine: (line) => {
          const now = Date.now();
          if (now - last > 700) { last = now; sendProgress({ phase: 'ffmpeg', message: `ffmpeg 설치 중… ${line}` }); }
        }
      });
      sendProgress({ phase: 'ffmpeg', message: `ffmpeg 설치 완료 — ${found.version || found.ffmpeg}` });
      return { ok: true, ffmpeg: found };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:pickMusic', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '영상에 쓸 음악 파일 선택',
        properties: ['openFile'],
        filters: [{ name: '오디오', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }]
      });
      const file = result.filePaths?.[0];
      if (result.canceled || !file) return { ok: true, canceled: true };
      return { ok: true, file };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:videoSaveAs', async (_event, { id } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      if (!entry?.videoPath || !fs.existsSync(entry.videoPath)) throw new Error('저장할 영상이 없습니다.');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '영상 저장',
        defaultPath: path.join(app.getPath('downloads'), `${prompt.sanitizeFileName(entry.title, 'motion')}_영상.mp4`),
        filters: [{ name: 'MP4 영상', extensions: ['mp4'] }]
      });
      if (result.canceled || !result.filePath) return { ok: true, saved: false };
      await fsp.copyFile(entry.videoPath, result.filePath);
      return { ok: true, saved: true, filePath: result.filePath };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:videoReveal', async (_event, { id, which } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      const target = which === 'code' ? entry?.compositionPath : entry?.videoPath;
      if (!target || !fs.existsSync(target)) throw new Error('표시할 파일이 없습니다.');
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:cancel', () => {
    if (currentRun) {
      currentRun.controller.abort(new Error('사용자가 생성을 취소했습니다.'));
      return { ok: true };
    }
    return { ok: false, error: '진행 중인 생성이 없습니다.' };
  });

  ipcMain.handle('studio:history', async () => {
    try {
      const entries = await store.readHistory(userData());
      return { ok: true, entries: entries.map(entrySummary) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:historyGet', async (_event, { id } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new Error('기록을 찾을 수 없습니다.');
      return { ok: true, entry: publicEntry(entry) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:historyRemove', async (_event, { id } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      await store.removeEntry(userData(), id, entry?.imagePath || '');
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:imageImport', async (_event, { id } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new Error('기록을 찾을 수 없습니다. 명세를 먼저 생성하거나 기록에서 불러와 주세요.');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '보드 이미지 가져오기',
        properties: ['openFile'],
        filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      });
      const source = result.filePaths?.[0];
      if (result.canceled || !source) return { ok: true, canceled: true };
      const rawExt = path.extname(source).toLowerCase();
      const ext = ['.png', '.jpg', '.jpeg', '.webp'].includes(rawExt) ? rawExt : '.png';
      await store.ensureDirs(userData());
      const target = path.join(store.imagesDir(userData()), `${entry.id}${ext}`);
      if (entry.imagePath && entry.imagePath !== target) {
        try { await fsp.rm(entry.imagePath, { force: true }); } catch {}
      }
      await fsp.copyFile(source, target);
      const updated = await store.updateEntry(userData(), entry.id, {
        imagePath: target,
        imageModel: '외부 이미지',
        imageNote: '가져온 이미지 (ChatGPT 웹 등 외부 도구에서 생성)',
        imageError: ''
      });
      return { ok: true, entry: publicEntry(updated) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:imageSaveAs', async (_event, { id } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      if (!entry?.imagePath) throw new Error('저장할 보드 이미지가 없습니다.');
      const ext = (path.extname(entry.imagePath) || '.png').replace('.', '').toLowerCase();
      const suggested = `${prompt.sanitizeFileName(entry.title)}_디자인보드.${ext}`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '디자인 보드 저장',
        defaultPath: path.join(app.getPath('downloads'), suggested),
        filters: [{ name: `${ext.toUpperCase()} 이미지`, extensions: [ext === 'jpeg' ? 'jpg' : ext] }]
      });
      if (result.canceled || !result.filePath) return { ok: true, saved: false };
      await fsp.copyFile(entry.imagePath, result.filePath);
      return { ok: true, saved: true, filePath: result.filePath };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:reveal', async (_event, { id } = {}) => {
    try {
      const entries = await store.readHistory(userData());
      const entry = entries.find((item) => item.id === id);
      if (!entry?.imagePath) throw new Error('표시할 보드 이미지가 없습니다.');
      shell.showItemInFolder(entry.imagePath);
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:openDataDir', async () => {
    try {
      await store.ensureDirs(userData());
      shell.openPath(store.baseDir(userData()));
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('studio:openExternal', async (_event, { url } = {}) => {
    try {
      const target = String(url || '');
      if (!/^https?:\/\//i.test(target)) throw new Error('허용되지 않은 주소입니다.');
      await shell.openExternal(target);
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  });
}

function buildMenu() {
  const template = [
    {
      label: '파일',
      submenu: [
        { label: '생성 기록 폴더 열기', click: () => { store.ensureDirs(userData()).then(() => shell.openPath(store.baseDir(userData()))); } },
        { type: 'separator' },
        { role: 'quit', label: '종료' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'resetZoom', label: '확대/축소 초기화' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' }
      ]
    },
    {
      label: '도움말',
      submenu: [
        {
          label: '가이드 문서 열기',
          click: () => {
            try {
              const guide = prompt.loadGuide(PROMPTS_DIR);
              shell.showItemInFolder(guide.file);
            } catch {}
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: !SMOKE,
    backgroundColor: '#0f1013',
    title: '모션보드 스튜디오',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// <video> 탐색(seek)을 위해 Range 요청을 처리한다(videos 폴더 밖 경로는 거부).
function handleVideoProtocol() {
  protocol.handle(VIDEO_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const file = store.resolveVideoFile(userData(), url.pathname);
      if (!file) return new Response('Not Found', { status: 404 });
      return await mediaResponse(file, request.headers.get('range'));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

function handleImageProtocol() {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const file = store.resolveImageFile(userData(), url.pathname);
      if (!file) return new Response('Not Found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

if (!ISOLATED_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    auth.init({
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:auth', status);
      }
    });
    claudeAuth.init({
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:claudeAuth', status);
      }
    });
    handleImageProtocol();
    handleVideoProtocol();
    if (!SMOKE) buildMenu();
    registerIpc();
    const win = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    if (SMOKE) {
      const shotArg = process.argv.find((arg) => arg.startsWith('--shot='));
      const finish = (code, message) => {
        console.log(message);
        setTimeout(() => app.exit(code), 150);
      };
      win.webContents.once('did-finish-load', async () => {
        try {
          const ok = await win.webContents.executeJavaScript(
            'Boolean(window.studio && window.studio.auth && window.studio.claude && window.studio.spec && window.studio.history && window.studio.imageImport && window.studio.video && window.studio.pickMusic)'
          );
          if (!ok) return finish(1, 'SMOKE_FAIL: preload bridge missing');
          const report = await win.webContents.executeJavaScript(`(async () => {
            const env = await window.studio.env();
            const auth = await window.studio.auth.status();
            const claude = await window.studio.claude.status();
            const history = await window.studio.history();
            const badge = document.getElementById('authBadge');
            const claudeBadge = document.getElementById('claudeBadge');
            return {
              env, auth, claude, historyCount: history.ok ? history.entries.length : -1,
              ui: {
                badge: badge?.textContent, badgeClass: badge?.className,
                claudeBadge: claudeBadge?.textContent, claudeBadgeClass: claudeBadge?.className
              }
            };
          })()`);
          console.log(`SMOKE_REPORT ${JSON.stringify(report)}`);
          if (shotArg) {
            // --shot-scroll: 입력 폼을 맨 아래(영상 옵션·생성 버튼)까지 내린 상태로 캡처한다.
            if (process.argv.includes('--shot-scroll')) {
              await win.webContents.executeJavaScript("document.querySelector('.form-panel').scrollTop = 1e6; true");
            }
            // 숨겨진 창은 렌더링이 스로틀되어 이전 프레임이 캡처될 수 있다.
            win.webContents.invalidate();
            await new Promise((resolve) => setTimeout(resolve, 400));
            const image = await win.webContents.capturePage();
            fs.writeFileSync(shotArg.slice('--shot='.length), image.toPNG());
          }
          finish(0, 'SMOKE_OK');
        } catch (error) {
          finish(1, `SMOKE_ERROR: ${error.message}`);
        }
      });
      win.webContents.once('did-fail-load', (_event, code, description) => {
        finish(1, `SMOKE_FAIL: did-fail-load ${code} ${description}`);
      });
      setTimeout(() => finish(1, 'SMOKE_FAIL: timeout'), 20000).unref?.();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
