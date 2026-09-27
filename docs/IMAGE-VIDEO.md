# 이미지 활용 영상

보드의 실제 이미지를 장면별로 나누고, Grok·Kling 구독 계정으로 인물과 사물이 움직이는 클립을 만든 뒤 하나의 MP4로 합치는 기능입니다. Grok은 공식 CLI의 Imagine 도구를, Kling은 공식 CLI를 통한 회원 계정 MCP를 사용합니다. 개발 중인 소스의 `StudioUI/` 화면과 `Runtime/`에 구현되어 있으며, **공개된 0.3.2-mac.3 DMG에는 아직 포함되지 않았습니다.**

새 영상 요청에는 API 키를 사용하지 않습니다. 영상 생성은 Grok 구독 사용량 또는 Kling 회원 크레딧을 사용하며, 계정의 이용 권한과 남은 한도가 필요합니다. **구독 경로의 실계정 영상 생성과 원본 대비 AI 영상의 시각적 품질은 아직 검증하지 않았습니다.** 아래 과거 검증 기록은 로컬 미디어 처리와 당시 구현의 범위를 구분해 보관합니다.

## 모션 그래픽과의 차이

| 선택 | 보드와 영상의 관계 | 적합한 작업 |
| --- | --- | --- |
| 모션 그래픽 | 보드의 색과 문구를 참고해 글자·도형을 연출 | 타이포그래피, 도형 전환, 음악에 맞춘 그래픽 |
| 이미지 활용 영상 | 보드에서 자른 이미지를 영상 모델의 입력으로 사용 | 선수의 투구, 인물의 행동, 사물 자체의 움직임 |

원작의 모션 그래픽 엔진은 보드의 인물·질감·입체물을 그대로 렌더링하지 않습니다. 그래서 보드와 완성 영상의 그림이 달라질 수 있습니다. 새 경로는 실제 장면 이미지를 전달하지만, AI가 얼굴·문구·물체를 항상 정확히 유지한다는 보장은 없습니다. 장면마다 원본과 결과를 나란히 확인한 뒤 사용할 클립을 선택하세요.

## 사용 순서

1. 왼쪽에서 **이미지 활용 영상**을 선택합니다. 명세와 보드를 새로 만들거나 기존 기록을 불러옵니다. 외부 보드 이미지를 기록에 가져올 수도 있습니다.
2. **이미지 영상** 탭의 **보드에서 장면 준비**를 누릅니다. 균등한 4×4 격자를 왼쪽 위부터 행 순서로 잘라 16개 장면을 만듭니다. 처음에는 앞 12개를 선택하고 뒤 4개는 해제합니다. 사용할 셀을 직접 바꿀 수 있습니다.
3. 각 장면의 **이름**, **움직임과 카메라 연출**, **길이**를 수정합니다. 예를 들어 “선수가 공을 던지며 팔과 몸이 자연스럽게 움직인다. 카메라는 옆에서 천천히 따라간다”처럼 피사체의 동작을 구체적으로 적습니다. 수정한 내용은 **설정 저장**으로 저장합니다.
4. Grok 또는 Kling을 선택하고 **구독 연결 / 확인**을 누릅니다. 해당 공식 CLI를 별도로 설치해야 하며, 찾지 못하면 설치 안내를 열거나 실행 파일을 선택할 수 있습니다. 로그인 안내에서 **로그인 터미널 열기**를 누르고 브라우저에서 구독 계정으로 로그인합니다. 완료 후 **연결 확인** 또는 **상태 새로고침**을 누르세요. CLI 설치만으로 로그인 완료를 표시하지 않으며, Kling은 확인된 회원 등급과 잔여 크레딧도 표시합니다.
5. **미완료 장면 생성**을 누릅니다. 실제 버튼에는 대상 개수가 표시됩니다. 확인창에서 전송할 서비스·장면 수·총 길이·해상도를 확인하고 요청합니다. 선택한 장면 이미지와 움직임 설명이 해당 서비스에 전달되며 Grok 구독 사용량 또는 Kling 회원 크레딧이 사용됩니다. 계정 상태 새로고침은 영상을 생성하지 않습니다.
6. **진행 중인 장면 상태 확인**을 눌러 생성 상태를 확인하고 완성된 클립을 가져옵니다. 현재는 사용자가 누를 때 확인하며 백그라운드에서 계속 조회하지 않습니다. 장면을 누르면 **보드 원본**과 **생성한 클립**을 나란히 비교할 수 있습니다.
7. 선택한 장면이 모두 준비되면 음악을 고릅니다. **원본 클립의 소리 유지**, **Mixkit 자동 선택**, **내 음악 파일**을 지원합니다. **선택한 클립을 MP4로 합치기**를 누르면 장면 목록 순서대로 로컬에서 합칩니다.
8. 결과를 재생해 확인하고 **이미지 영상 저장 (MP4)**으로 저장합니다. 기존 모션 그래픽 결과와 이미지 영상 결과는 같은 기록에서 별도로 유지합니다.

Grok 로그인은 앱이 관리하는 별도 `GROK_HOME`에서 `grok login --oauth`로 진행합니다. 앱의 로그인·생성 실행에는 API 키 인증을 끄며, 기존 Grok CLI의 로그인 정보를 읽어 복사하지 않습니다. Kling은 공식 CLI가 OAuth 로그인을 관리합니다. 현재 대화에 연결된 Kling MCP와 Mac 앱의 CLI 로그인은 별도이므로, 대화에서 연결했어도 앱에서 처음 로그인해야 할 수 있습니다. ChatGPT·Claude 로그인도 영상 서비스 로그인과 별개입니다.

**앱에서 연결 해제**는 MotionBoard의 연결 사용만 중지합니다. CLI에서 로그아웃하거나 회원 크레딧·기존 결과를 삭제하지 않습니다. 다시 사용하려면 **구독 연결 / 확인**을 누르세요.

공식 CLI는 앱이나 DMG에 포함하지 않습니다. [Grok Build 안내](https://docs.x.ai/build/overview)와 [Kling 공식 CLI·스킬 안내](https://github.com/klingai-tech/skills)에서 직접 설치하세요. 특히 Kling CLI npm 패키지의 라이선스가 명시되지 않아 재배포 번들에 넣지 않았습니다.

보드가 균등한 4×4 구조가 아니면 이미지나 문구가 셀 경계에서 잘릴 수 있습니다. 장면 준비 후 실제로 잘린 이미지를 먼저 확인하세요. 작은 셀은 비율을 유지하면서 짧은 변이 512px 이상이 되도록 확대합니다. 확대는 원본에 없던 세부 묘사를 복원하지 않습니다.

## API 없이 클립 가져오기

이미 보드가 있는 기록에서 장면을 선택하고 **이 장면에 클립 가져오기**를 누르세요. Grok·Kling 웹 화면이나 Higgsfield, 다른 제작 도구에서 만든 영상을 가져올 수 있습니다. 앱은 실제 디코딩 가능 여부와 길이를 검사한 뒤 자체 기록 폴더에 복사하며 원본 파일은 변경하지 않습니다.

클립 가져오기와 MP4 합성에는 영상 서비스 구독 연결이 필요하지 않습니다. **원본 클립의 소리 유지** 또는 **내 음악 파일**을 고르면 이 단계는 로컬 파일만 사용합니다. Mixkit 자동 선택은 음악 검색·다운로드를 위해 네트워크를 사용합니다.

가져온 클립은 원본 길이 안에서 사용할 길이를 정합니다. 선택한 모든 장면에 클립이 있어야 합칠 수 있으므로, 아직 준비되지 않은 장면은 선택을 해제하거나 클립을 추가하세요.

## 생성 중 취소와 결과 확인

앱에서 취소해도 이미 외부 서비스가 접수한 생성 작업이나 사용량·크레딧 차감까지 취소되는 것은 아닙니다. 저장된 작업 번호가 있으면 **진행 중인 장면 상태 확인**으로 이어서 확인할 수 있습니다.

통신이 끊겨 접수 여부를 알 수 없는 요청은 **결과 확인 필요**로 남깁니다. 앱이 같은 생성 요청을 자동 재전송하지 않습니다. 작업 번호가 없는 경우에는 서비스의 작업 내역에서 먼저 접수 여부를 확인해야 합니다. 로컬 합성 중 취소하거나 다시 내보내더라도 이전에 완성한 영상과 보드는 유지합니다.

서비스에서 미접수를 확인했다면 해당 장면의 **미접수 확인 후 재설정**을 누르고 확인창에서 다시 준비 상태로 돌릴 수 있습니다. 재설정 자체는 새 요청을 보내지 않습니다. 이미 완성된 작업이면 결과 파일을 가져오세요. 접수된 작업을 다시 생성하면 사용량·크레딧이 중복 차감될 수 있으므로 확인 없이 재설정하지 마세요.

이전 개발본에서 API로 접수한 작업은 원래 API 경로와 저장된 앱 키체인 정보를 사용해 **상태 확인만** 이어갑니다. 기존 API 작업을 구독 작업으로 바꾸거나, 새 구독 요청이 실패했을 때 API 요청으로 전환하지 않습니다. 새 생성은 구독 CLI 경로만 사용합니다.

## 합성 결과와 서비스 선택

합성은 원본 클립의 가로세로 비율을 유지하고, 선택한 1:1·16:9·9:16 화면에 맞지 않는 부분은 검정 여백으로 채웁니다. 피사체를 맞추려고 화면을 늘리거나 잘라내지 않습니다. 원본 오디오가 없는 장면에는 무음을 넣고, 음악을 고르면 원본 소리와 함께 섞습니다.

현재 앱의 이미지 영상 내보내기는 60fps 파일을 만듭니다. 내부 미디어 모듈은 30fps 초안도 지원합니다. **출력 60fps는 영상 모델이 초당 60개의 새로운 움직임을 생성했다는 뜻이 아닙니다.** 원본 클립의 프레임을 샘플링하거나 반복해 출력 속도를 맞춥니다. 원본 fps와 합성 길이는 함께 저장합니다. 모션 그래픽 경로의 4개 서브프레임 모션 블러를 이 경로에 적용하지 않습니다.

현재 앱이 제공하는 모델과 선택지는 다음과 같습니다. 서비스의 모든 모델을 자동으로 노출하지 않으며, 모델 계약을 확인한 뒤 목록을 추가합니다.

| 서비스 | 앱에서 사용하는 경로 | 장면 길이 | 선택 해상도 |
| --- | --- | --- | --- |
| Grok | 공식 CLI Imagine의 `reference_to_video` | 1~15초 | 480p·720p |
| Kling | 공식 CLI MCP의 `kling-video-v2_6` | 5초·10초 | 720p·1080p |

Grok의 범위는 설치된 공식 CLI의 `bundled/skills/imagine/SKILL.md`와 [Grok Build 안내](https://docs.x.ai/build/overview)를 기준으로 합니다. API 경로의 1080p 선택지를 CLI 경로에 적용하지 않습니다. Kling은 [공식 CLI·스킬](https://github.com/klingai-tech/skills)의 계약을 사용하고 로그인한 계정의 모델·옵션을 확인합니다. 현재 Kling 어댑터는 오디오 생성을 끈 상태(`enable_audio=false`)로 요청합니다. 위 표는 앱이 제공하는 최대 선택 범위이며, 계정에서 확인되는 옵션에 따라 줄어들 수 있습니다. 실제 생성 성공을 확인했다는 뜻은 아닙니다.

구독 연결 목록은 [`Runtime/subscription-video-providers.cjs`](../Runtime/subscription-video-providers.cjs), 서비스별 동작은 `Runtime/grok-subscription.cjs`와 `Runtime/kling-subscription.cjs`에 있습니다. `Runtime/video-providers.cjs`는 이전 API 작업의 상태 확인을 위해 남겨 둡니다.

[Remotion](https://www.remotion.dev/docs/)은 코드로 화면을 구성하고 영상·오디오를 합성하는 도구입니다. 향후 자막·오버레이·전환을 편집하는 계층으로 검토할 수 있으며, 현재 앱에는 설치하거나 연결하지 않았습니다. 현재 합성은 FFmpeg를 사용합니다. **Higgsfield 직접 연결도 아직 없으며**, 서비스 연결 방법을 확인한 뒤 별도 어댑터로 추가할 예정입니다. 현재는 외부에서 만든 클립을 가져오는 경로를 사용할 수 있습니다.

## 검증 범위

구독 CLI 검사는 모의 CLI 실행 결과를 사용합니다. 실제 로그인이나 생성 요청을 실행하지 않으므로 구독 사용량·크레딧을 소비하지 않습니다. 기존 API 검사도 이전 작업의 상태 확인 호환성을 위해 유지합니다. 자동 검사가 실제 계정의 영상 생성이나 시각적 품질을 증명하지는 않습니다.

```sh
node --test Tests/*subscription.test.cjs Tests/video-cli.test.cjs Tests/subscription-connections.test.cjs Tests/video-providers.test.cjs Tests/image-video.test.cjs Tests/studio-ui.test.cjs
```

### 2026-09-28 Grok profile compatibility — development build 10

The build 9 connection check passed before Grok added further official marketplace metadata. A later check then rejected `official_marketplace_auto_installed` and `[[marketplace.sources]]`, although every required authentication and tool-isolation setting remained unchanged. This was an incomplete compatibility fix, not evidence that the user changed authentication settings.

The validator now accepts the two known boolean bookkeeping fields and exactly one official source with the [public CLI constants](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-plugin-marketplace/src/lib.rs): `xAI Official` and `https://github.com/xai-org/plugin-marketplace.git`. Additional sources, fields, duplicate declarations, changed required settings, and symlinked profiles remain rejected. The profile and credentials are preserved. CLI and login launches also set `GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER=0`, following the [documented implementation precedence](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/config.rs). The installed binary's rollout suppression is not independently proven; accepting existing official metadata is the verified compatibility fix.

- The regression first passed authentication, added the CLI's later registration metadata, then reproduced the connection failure. It passes after the fix, including repeated checks and unchanged config/credential fixtures.
- All 57 affected Grok, Kling, process, connection, and image-video tests passed. Separate review found no blocking schema-validation issue.
- The packaged Node and Runtime checked both real OAuth connections across **three independent process starts**. All succeeded, and the existing Grok configuration hash stayed identical throughout. No video generation or image upload was requested.
- All 20 Runtime/StudioUI resources match the source. App signature, DMG checksum, and the mounted app signature passed verification.

Local artifacts: `dist/MotionBoard Studio Development 10.app` and `dist/MotionBoardStudio-development-10-arm64.dmg` (73,108,992 bytes; SHA256 `e1059e804f0a28555b8fe20ccf765022d9707bb1d0ed82a064b5ef480afb72e9`). Previous builds remain available. This is an ad-hoc signed local development package; no public release or notarization was performed.

Evidence: `.local/grok-profile-lifecycle-fix-20260928/before.log`, `final-tests.log`, `bundled-lifecycle-status.json`, and `package-receipt.json`. Real video generation and visual consistency with the source board remain unverified.

### 2026-09-28 연결 오류 수정 · 개발본 9

로그인 후에도 연결되지 않던 원인 두 가지를 수정했습니다. Grok은 CLI가 정상적으로 추가한 `marketplace.default_skills_installs_purged` 설정 때문에 앱의 파일 전체 비교에 실패했습니다. 필요한 인증·도구 제한 값은 그대로 검사하면서 해당 메타데이터와 주석·공백 변경을 허용합니다. 기존 설정과 인증 파일은 덮어쓰지 않습니다. Kling CLI 0.2.0은 긴 JSON을 출력하고 바로 종료하면서 파이프 응답이 65,536바이트에서 잘렸습니다. 공식 `--quiet` 옵션으로 완전한 compact JSON을 받도록 수정했고, 불완전한 응답은 계속 거부합니다. 설정 오류·실행 오류도 로그인 안내와 구분해 표시합니다.

- 연결·생성 어댑터·프로세스 제어·장면·UI 검사 70개 통과. 검토에서 빈 미등록 Grok 설정 섹션도 거부하도록 보완하고 관련 검사 11개를 다시 통과했습니다. Grok과 Kling의 각 원인은 수정 전 실패하는 회귀 사례로 재현했습니다.
- 패키지에 포함된 Node와 Runtime으로 두 서비스의 실제 OAuth 연결 성공을 확인했습니다. Kling 회원 등급·잔여 크레딧 조회도 성공했습니다. 이 검사는 영상 생성·이미지 업로드를 요청하지 않았습니다.
- 실제 Mac WebKit에서 구독 연결 UI, 16개 장면, 로컬 영상 재생·탐색을 검사했습니다. 해당 화면 검사는 별도 fixture를 사용하며 계정 연결 검증과 구분됩니다.
- 소스의 Runtime·StudioUI 20개 파일과 앱 번들이 일치합니다. 앱 서명·DMG 체크섬·마운트한 앱 서명 검사도 통과했습니다.

로컬 결과는 `dist/MotionBoard Studio Development 9.app`, `dist/MotionBoardStudio-development-9-arm64.dmg`입니다. DMG는 73,108,522바이트이며 SHA256은 `680cbfd47143fae8954ece8fa6a8b9f8e89faf564e640655571a5d52e7b7b54d`입니다. 기존 빌드를 보존했고 공개 릴리스는 교체하지 않았습니다. 기존과 같은 ad-hoc 서명이며 Apple 공증을 받지 않았습니다.

검증 기록은 `.local/subscription-connection-fix-20260928/`의 `tests.log`, `grok-before.log`, `grok-reviewed.log`, `bundled-live-status.json`, `native-ui/native-ui-receipt.json`, `package-receipt.json`입니다. 실계정 영상 생성과 보드 대비 품질 검증은 여전히 남아 있습니다.

### 2026-09-28 구독 연결 개발본 8

로컬 패키지는 `dist/MotionBoard Studio Development 8.app`와 `dist/MotionBoardStudio-development-8-arm64.dmg`입니다. 기존 앱과 DMG는 보존했습니다. 새 DMG는 73,107,317바이트이며 SHA256은 `a5f1d1c8c12bb883d1e1cd1612caed6edb9701158d08afd3e915239417cecbf8`입니다. 로컬 ad-hoc 서명으로, 새 공개 릴리스나 Apple 공증은 수행하지 않았습니다.

- 구독 어댑터·프로세스 제어·연결 설정·장면 작업·UI·기존 엔진/브리지 검사 105개가 통과했습니다. 이후 재시작 복구 보완과 회귀검사 1개를 추가하고 영향받는 Grok·장면 검사 23개를 다시 실행해 모두 통과했습니다. 원문은 `.local/subscription-video-20260928/tests.log`, `recovery-tests.log`입니다.
- 설치된 Grok 1.0.41로 별도 프로필의 ACP 초기화와 미로그인 상태를 확인했습니다. 모델 프롬프트·영상 생성·이미지 업로드는 0건입니다. 기록은 `.local/grok-subscription-probe-20260928/receipt.json`입니다. 공식 Kling CLI 0.2.0도 이 Mac에 별도 설치해 버전과 미로그인 상태를 확인했습니다.
- 패키지의 실제 WebKit에서 구독 연결 버튼, 크레딧 안내, API 키 입력 UI 부재, 16개 장면과 로컬 영상 재생·탐색을 확인했습니다. 공급자를 변경해도 새 요청이 발생하지 않았습니다. [현재 화면](images/native-subscription-video.png)은 1380×900이며, 검증 기록은 `.local/subscription-video-20260928/native-ui/native-ui-receipt.json`입니다.
- Runtime·StudioUI 20개 파일이 패키지와 일치했고 앱 서명, DMG 체크섬 및 마운트한 앱의 서명 검사가 통과했습니다. 패키지 기록은 `.local/subscription-video-20260928/package-receipt.json`입니다.

실제 구독 로그인 이후의 영상 생성과 보드 일관성 검증은 남아 있습니다. 새 생성은 앱에서 장면과 전송 내용을 확인한 뒤 시작합니다. 취소·응답 단절 시 승인했던 Grok 요청은 로컬 영수증으로 복구하며 자동으로 다시 생성하지 않습니다.

**아래는 구독 CLI 전환 전인 2026-09-27의 검증 기록입니다.** 새 연결 방식의 실계정 검증 결과로 해석하지 마세요.

미디어 검사는 공개 mac.3 앱에 포함된 실제 FFmpeg·ffprobe로 합성 보드와 움직이는 테스트 영상을 만듭니다. 당시 로컬 실행에서 9개 검사 모두 통과했고 건너뛴 검사는 없었습니다. 확인한 내용은 16개 실제 이미지 분할, 홀수 크기 경계 처리, 조건부 확대, 투명도·원본 보존, 클립 순서·동작·여백, 30/60fps H.264/AAC 출력, 음악 반복·원본 소리·무음, 진행 중 취소와 기존 결과 보존입니다.

```sh
"dist/MotionBoard Studio 0.3.2-mac.3.app/Contents/MacOS/node" \
  --test Tests/image-video-media.test.cjs
```

번들이 없으면 미디어 통합 검사는 건너뜁니다. 다른 macOS용 FFmpeg로 확인하려면 `MOTION_BOARD_TEST_FFMPEG`에 절대 경로를 지정하고 같은 폴더에 `ffprobe`를 두세요. 이 통합 검사는 VideoToolbox가 있는 macOS FFmpeg를 사용합니다. 실행할 때마다 `.local/image-video-media-*` 아래에 테스트 미디어와 `receipt.json`을 남깁니다. 현재 로컬 검증 기록은 `.local/image-video-media-Bxsdcj/receipt.json`이며, 개인 미디어가 아닌 합성 테스트 자료만 포함합니다.

2026-09-27 통합 검증에서는 인증·기존 제작 경로·새 장면 작업·서비스 어댑터·UI의 JavaScript 검사 82개가 통과했습니다. 새 서비스 계정도 별도의 UUID 키체인 서비스에 합성 값만 넣어 저장·읽기·갱신·삭제를 확인했습니다. `.local/image-video-acceptance-20260927/native-receipt.json`에는 실제 1920×1080 모션 영상과 별도의 2초 이미지 영상 합성 결과가 기록되어 있습니다.

패키징한 개발 앱의 실제 WebKit 화면에서도 16개 원본 이미지, 두 테스트 클립, 별도 최종 영상의 디코딩·재생·탐색이 통과했습니다. 서비스 선택 변경 시 외부 요청이 발생하지 않음과 기존 모션 영상 보존을 확인했습니다. 결과는 `.local/image-video-native-ui-20260927/native-ui-receipt.json`, 화면은 [네이티브 장면 편집 캡처](images/native-image-video.png)에 있습니다. 이 검사에서 가져온 클립은 기존 모션 테스트 영상을 복사한 것이며, 외부 AI가 피사체를 움직인 결과는 아닙니다.

당시 로컬 개발 패키지는 `dist/MotionBoard Studio Development.app`와 `dist/MotionBoardStudio-development-arm64.dmg`입니다. 빌드 번호는 4이며 구독 CLI 전환이 포함된 패키지가 아닙니다. GitHub의 mac.3 릴리스를 교체하지 않았습니다. 앱 서명과 DMG 체크섬·마운트 후 서명 검사를 통과했고, 당시 앱에 들어간 Runtime·StudioUI 14개 파일이 소스와 동일함을 확인했습니다. 무료 배포 방식의 ad-hoc 서명이며 공증은 받지 않았습니다.

남은 검증은 Grok·Kling 구독 계정에서의 실제 생성, 생성된 피사체와 원본 보드의 일관성, 다양한 외부 클립의 재생·합성 품질입니다. 모의 CLI·API 검사나 테스트 클립 합성이 이 결과를 보장하지 않습니다. 이 기능의 추가는 새 공개 릴리스나 Apple 공증 완료를 의미하지 않습니다.

## 관련 소스

| 파일 | 역할 |
| --- | --- |
| `StudioUI/index.html`, `StudioUI/app.js`, `StudioUI/styles.css` | 두 제작 경로, 장면 편집, 원본·클립 비교 화면 |
| `Runtime/image-video.cjs` | 장면 계획, 요청·상태 저장, 클립 가져오기, 내보내기 |
| `Runtime/subscription-video-providers.cjs` | 구독 연결 설정·로그인 안내·연결 상태 |
| `Runtime/grok-subscription.cjs`, `Runtime/kling-subscription.cjs`, `Runtime/video-cli.cjs` | 공식 CLI 실행과 구독 영상 요청·응답 |
| `Runtime/video-providers.cjs` | 이전 API 작업의 상태 확인 호환성 |
| `Runtime/image-video-media.cjs` | 로컬 이미지 분할, 영상 검사, 오디오·클립 합성 |
| `Sources/MotionBoardOriginal/NativeActions.swift` | 네이티브 확인창·파일 선택·터미널 로그인 열기, 기존 키체인 접근 |

원작 소스는 `upstream/MotionBoardStudio-0.3.2/`에 그대로 보존합니다. 앱의 새 화면은 이를 바탕으로 확장한 `StudioUI/`를 사용합니다.
