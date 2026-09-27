# Original-app validation

Recorded on 2026-09-27 for the arm64 macOS implementation. The packaged app, original production pipeline, and native interface passed isolated checks. A separate real-account generation run subsequently passed with ChatGPT, Claude, and automatic Mixkit music. The evidence is separated below; the published UI screenshot still shows fixture account states.

## Results and scope

| Check | Result |
| --- | --- |
| Original JavaScript services | 43 passed: authentication 29, engine 12 including two nested cases, original bridge 2 |
| Other JavaScript checks | Browser preview 3 and prototype renderer 8 passed; total JavaScript count 54 |
| Swift tests | 17 passed, scoped to prototype models and behavior; these do not establish original-app parity |
| Full-size production | 1920×1080 H.264 video, 60 fps, 480 frames, eight seconds, AAC audio; actual synthetic-music analysis/mixing, original direction, frame review, board attachment, and history round trip passed |
| Production-size DOM captures | 1440×1440, 1920×1080, and 1080×1920; loop endpoints were identical and changed phases differed |
| Free-code render | 320×180, 60 fps, 60 frames, one second, four subframes per frame |
| Cancellation | Existing completed video was preserved; cancellation also prevented later video work in the same UI flow |
| Final packaged combined run | Production, native services, and UI passed together; its smaller production fixture was 320×180, 30 fps, 240 frames, eight seconds with AAC audio |
| Native storage and media | Unique synthetic Keychain item create/read/update/delete passed with cleanup; selected-image conversion, rejection of unselected outside images, and HTTP-style media byte ranges passed |
| Native interface | 26 bridge methods and three subscriptions; real environment/history calls, history-open button, 256×256 board loading, five tabs, form controls, and iframe bridge rejection passed |
| Native video playback | A 1920×1080 eight-second video decoded through `studio-video:`; 31 decoded frames were observed, muted playback advanced, and seeking to one second completed |
| Screenshot | The actual 1380×900 WebKit snapshot was inspected; [native-studio.png](images/native-studio.png) shows fixture account states and provider responses |

The combined receipt is `.local/verification-release-004/native-receipt.json`. Full-size evidence is `.local/verification-original-full-002/verification/receipt.json`; the separate 1080p UI receipt is `.local/verification-native-ui-003/native-ui-receipt.json`. These are local artifact locations, not public download links.

## Runtime and source integrity

The combined fixture validation used `dist/MotionBoard Studio 0.3.2-mac.1.app`. The subsequent `dist/MotionBoard Studio 0.3.2-mac.2.app` added the explicit live-verification entry point. Both use official Node.js **v24.21.0, arm64**. The archive checksum and system-library-only dependencies were checked, all eight bundled runtime files matched current source hashes, and `codesign --verify --deep --strict` passed for the ad-hoc signed bundles. Authentication and engine checks also passed as 41 tests under bundled Node.js. The later self-contained `mac.3` installer is documented separately in [DISTRIBUTION.md](DISTRIBUTION.md).

The final `mac.2` bundle also passed native UI verification with exit 0, including the original forms, history/board loading, 1080p video playback and seeking, and subframe bridge rejection. Its receipt is `.local/verification-release2-ui-006/native-ui-receipt.json`; account states in this UI-only run were fixtures.

Node archive SHA-256: `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`. The bundle retains `Node-provenance.json` and `Node-LICENSE.txt`; its recorded source is the [official Node.js archive](https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz).

All 30 original source files, totaling 360,724 bytes, remain unchanged against the retained extraction by SHA-256 comparison.

## Reproduce the checks

Run from the repository root. JavaScript checks and `swift test` returned exit 0 in the recorded runs:

```sh
node --test Tests/original-auth.test.cjs Tests/original-engine.test.cjs Tests/original-bridge.test.cjs Tests/original-preview.test.cjs Tests/board-runtime.test.cjs
swift test
```

The following commands inspect the preserved `mac.1` validation bundle. For the current app and DMG build procedure, use [DISTRIBUTION.md](DISTRIBUTION.md).

```sh
codesign --verify --deep --strict "dist/MotionBoard Studio 0.3.2-mac.1.app"
"dist/MotionBoard Studio 0.3.2-mac.1.app/Contents/MacOS/node" --version
```

Native checks require FFmpeg and a usable macOS graphical session. Use new output directories; existing evidence is never overwritten. The following commands reproduce the combined, full-size, and UI checks using the final bundle:

```sh
verification_app="dist/MotionBoard Studio 0.3.2-mac.1.app/Contents/MacOS/MotionBoardStudio"
"$verification_app" --verify-original --output .local/recheck-original
"$verification_app" --verify-original --full-size --output .local/recheck-full
"$verification_app" --verify-ui --data-root .local/recheck-full --output .local/recheck-ui
```

The recorded combined command used `--verify-original --output .local/verification-release-004` and returned exit 0. `scripts/verify-render.sh .local/recheck-source` performs original-app verification from a SwiftPM source build. The `--full-size` option is available through the executable directly. Provider calls are substituted, while rendering, FFmpeg, media playback, and the separately isolated Keychain CRUD check exercise native services.

## Public Mixkit check

At `2026-09-27T05:04:57.927Z`, a bounded live catalog check returned three tracks passing the free-license filter. The first was **Deep Urban**, labeled **Mixkit Stock Music Free License**. A 524,288-byte sample downloaded to the local cache and was identified by FFprobe as MP3, 44,100 Hz, two channels. No downloaded audio was added to public documentation.

The receipt is `.local/mixkit-live-validation/receipt.json`. The check used the original `lib/video/mixkit.cjs` with bundled Node.js and these calls, where `cacheDir` is a new local cache directory:

```js
const signal = AbortSignal.timeout(45000);
const tracks = await mixkit.search(['sports'], { limit: 3, maxPages: 2, minDurationSec: 30, signal });
await mixkit.downloadHead(tracks[0], cacheDir, { bytes: 512 * 1024, signal });
```

This verifies that sample's catalog/filter/download path, not all tracks or the complete automatic-music production workflow.

## Real-account production

After the operator completed both logins in the application, the source-built app ran:

```sh
.build/debug/MotionBoardStudio --verify-live --output .local/verification-live-005
```

This explicit command consumes provider usage and downloads public music. It reads only this application's Keychain accounts and writes a new, isolated history directory. It never substitutes provider responses. To reproduce from a fresh checkout, use `swift run MotionBoardStudio --verify-live --output .local/live-new` after connecting both accounts in the normal app. Choose an unused output directory.

The command returned exit 0. Its actual results were:

| Stage | Observed result |
| --- | --- |
| Specification | `gpt-6-astra`, `xhigh`; 10,951 YAML characters and 5,015 board-prompt characters; no model fallback |
| Board | Real image-generation response, 1254×1254 PNG, 4×4 composition; response reports the orchestrating model as `gpt-6-astra` |
| Direction and review | `claude-opus-5-5`; structured engine, native validation, and frame review completed; `reviewed=true`, repairs 0 |
| Music | Five actual candidates analyzed; “Pop Track 03” by Lily J selected, 109.0048 BPM; reported Mixkit Stock Music Free License |
| Video | 1440×1440 H.264, 60 fps, 528 frames, 8.8 seconds, four subframes per frame |
| Audio | AAC, 48,000 Hz, stereo; decoded mean volume −14.2 dB, maximum −0.8 dB |
| Persistence | Completed image/video entry was reopened through the history API with the same video URL |

The requested eight-second duration became 8.8 seconds through the original beat/bar quantization. FFprobe independently confirmed the codecs and frame count; FFmpeg decoded all 528 frames and the audio stream without errors. The generated board, review sheet, poster, and a contact sheet extracted from the encoded MP4 were inspected. This is one successful structured production run; it does not certify every account, composition, or live error case.

Local evidence: `.local/verification-live-005/live-receipt.json`, `media-receipt.json`, and `encoded-video-contact-sheet.png`. Convenient local copies are `dist/MAC MOTION - live verification.mp4` and `dist/MAC MOTION - 4x4 board.png`. Neither credentials nor downloaded audio were published. Music attribution and its [reported license](https://mixkit.co/license/#musicFree) remain attached to the history metadata.

## Fonts and remaining acceptance

An additional live-font check loaded Black Han Sans 400, Anton 400, and Noto Sans KR 500/700 in the unchanged original 1920×1080 composition. All four FontFace entries were `loaded`; Korean and Latin captures were inspected. WebKit exposed the Google stylesheet timing, but not gstatic font timings. A diagnostic requiring those timing entries returned exit 1; separate retrieval of the stylesheet and its four font URLs confirmed gstatic HTTP 200. No font-loading or composition error was observed. The local receipt is `.local/google-fonts-validation/verification-summary.json`. Windows pixel equivalence and general font fidelity are not established by this sample.

Fresh app login and the live workflow above passed. Real token expiry/renewal, quota exhaustion, additional account/error cases, and live free-code generation were not covered by that run; their implemented contracts have isolated test coverage where recorded. The native playback check was muted; the live audio measurements establish decoding and non-silent output, not a subjective listening review.

Intel hardware, clean-machine installation, Developer ID signing, and notarization remain unverified. No benchmark, universal visual parity, or production-account compatibility is inferred from these local checks.
