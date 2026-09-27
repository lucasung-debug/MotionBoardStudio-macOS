// Small platform wording adaptations; the preserved upstream interface is intact.
(() => {
  'use strict';
  const flow = window.__studioFlow;
  const originalSetBusy = window.setBusy, originalSetStatus = window.setStatus;
  window.setStatus = text => originalSetStatus(flow.active && flow.cancelled
    ? '생성 취소 요청을 처리하고 있습니다…' : text);
  window.setBusy = value => {
    if (value) flow.begin();
    originalSetBusy(value);
    if (!value && flow.finish()) {
      originalSetStatus('생성을 취소했습니다. 이미 완성된 결과는 보존했습니다.');
    }
  };
  window.applyFfmpeg = found => {
    const hint = document.getElementById('ffmpegHint');
    const button = document.getElementById('installFfmpegBtn');
    if (hint) hint.textContent = found
      ? `ffmpeg ${found.version || ''} 사용 · 영상과 음악은 이 Mac에서 렌더링합니다.`
      : '영상 제작에 필요한 ffmpeg를 찾지 못했습니다. 설치 안내를 보거나 설치한 실행 파일을 연결해 주세요.';
    if (button) { button.hidden = Boolean(found); button.textContent = 'ffmpeg 연결 / 설치 안내'; }
  };
  window.studio.env().then(result => {
    if (result.ok) window.applyFfmpeg(result.ffmpeg);
  }).catch(() => {});
})();
