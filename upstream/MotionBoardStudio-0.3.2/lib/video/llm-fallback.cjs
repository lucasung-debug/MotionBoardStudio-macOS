'use strict';

// 영상 코드 요청에 붙인 보드 이미지가 거부되면(예: 백엔드가 이미지 입력을 받지 않음)
// 영상이 실패하지 않도록 명세(텍스트)만으로 한 번 다시 요청한다.
// - 로그인 만료·사용량 한도 같은 종료성 오류와 사용자 취소는 그대로 전달한다.
// - 첫 설계 요청(자유 코드 compose, 연출 direct)에만 적용한다. 프레임 점검(review)은 이미지가 핵심이라 재시도하지 않는다.

const NO_IMAGE_LINE = '디자인 보드 이미지 없음: 명세만으로 비주얼을 설계한다.';

function withImageFallback(ask, { isTerminal = () => false, isCancelled = () => false, onFallback = () => {} } = {}) {
  return async (args) => {
    try {
      return await ask(args);
    } catch (error) {
      if (!args?.images?.length || !['compose', 'direct'].includes(args.phase) || isCancelled() || isTerminal(error)) throw error;
      try { onFallback(error); } catch {}
      const userText = String(args.userText || '').replace(/^첨부 이미지: .*$/m, NO_IMAGE_LINE);
      return ask({ ...args, images: [], userText });
    }
  };
}

module.exports = { NO_IMAGE_LINE, withImageFallback };
