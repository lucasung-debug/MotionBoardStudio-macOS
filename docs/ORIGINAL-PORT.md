# Original application port: implementation and verification

The source in [upstream/MotionBoardStudio-0.3.2](../upstream/MotionBoardStudio-0.3.2) remains the implementation reference. The macOS port preserves the original workflow and replaces Electron's desktop integration with a Swift host and a local Node.js process. No original GitHub repository URL was supplied; this is a source-based port.

Implementation of the preserved workflow is complete. The app passed isolated production/native UI checks and a separate real-account ChatGPT → board → Claude direction/review → Mixkit → MP4 → history run. The earlier sixteen-tile Swift editor is retained as `MotionBoardPrototype`; its results do not establish original-app parity.

## Preserved production flow

Topic and creative direction feed a ChatGPT or Claude production specification. The user can inspect the concept and YAML, optionally generate or import a 4×4 board, and select automatic music, local music, or sound effects without music. The production pipeline builds a beat grid, generates structured direction or experimental motion code, validates and optionally reviews frames, mixes audio, and renders an MP4. History retains the production entry and its associated image, composition, poster, video, and metadata.

Both the structured engine and generated HTML/CSS/JavaScript path remain part of the implementation. Their browser content runs in WebKit; the original audio and FFmpeg pipeline remains JavaScript executed by the local Node worker.

## Implemented mapping

The table identifies current code, not a claim that every live provider or visual behavior has passed acceptance. Original paths are relative to the upstream snapshot.

| Original entry point | Current macOS implementation |
| --- | --- |
| `main.cjs:createWindow`, `registerIpc`; `preload.cjs:studio` | `Sources/MotionBoardOriginal/OriginalStudioApp.swift` and `RuntimeBridge.swift` host the original UI; `Runtime/engine.cjs` implements the 26 original bridge operations |
| `main.cjs:runSpec`; `lib/prompt.cjs`; `prompts/` | `Runtime/engine.cjs` reuses original guides, normalization, provider clients, streaming progress, and cancellation |
| `main.cjs:runBoard`, image import/save handlers | Runtime orchestration, `Runtime/store.cjs`, and native dialogs implement optional board generation, import, persistence, and export |
| Original ChatGPT/Claude authentication modules | `Runtime/auth.cjs` and `StudioVault.swift` implement app-specific OAuth, Keychain persistence, expiry, refresh, cancellation, and public status |
| `main.cjs:runVideo`; `lib/video/pipeline.cjs:runVideo` | Runtime orchestration invokes the preserved pipeline and records progress, composition, metadata, and completed outputs |
| `lib/video/script.cjs`, `engine.js`, `kit.js` | Original direction parsing and browser engine run through `OriginalPageRenderer.swift` with explicit-time DOM capture |
| `lib/video/compose.cjs` | Original free-code parsing and composition run through the same controlled WebKit rendering service |
| `lib/video/audio.cjs`, `dsp.cjs`, `mixkit.cjs` | Preserved audio analysis, music selection, loop cutting, synthesized effects, and mixing execute in Node |
| `lib/video/render.cjs`, `ffmpeg.cjs` | `Runtime/render.cjs` replaces Chromium capture with native WebKit frames and retains FFmpeg encoding/muxing; macOS FFmpeg selection replaces Windows setup |
| `lib/store.cjs`, save/reveal handlers | `Runtime/store.cjs`, `NativeActions.swift`, and `StudioAssetHandler.swift` provide local history, atomic writes, native file actions, and scoped media access |

The store preserves entries instead of silently applying the original 60-entry truncation. Removing a history entry archives it and its assets in the application's local Trash directory. This is an intentional preservation change, not identical deletion behavior.

## Runtime and packaging

`MotionBoardStudio` is the SwiftPM product for the original app. The Swift host starts a local Node worker with a restricted environment; provider tokens are not inherited. Tokens remain in the worker and the app-specific Keychain service, while the interface receives public account status.

Source runs need installed Node.js and FFmpeg executables. The local bundles include official Node.js 24.21.0 arm64. The earlier `mac.2` bundle added the explicit live verification command. The `mac.3` distribution also bundles a standalone LGPL FFmpeg build, using Apple's VideoToolbox for H.264 encoding, and supplies a drag-to-Applications DMG. The build script defaults to `dist/MotionBoard Studio 0.3.2-mac.3.app` unless given another destination. See [DISTRIBUTION.md](DISTRIBUTION.md) for installer contents and verification.

## Verification and next steps

| Area | Recorded status and limit |
| --- | --- |
| Original source | Thirty files, 360,724 bytes; all preserved source files match the retained extraction by SHA-256 |
| Original-app JavaScript | 43 checks passed: 29 authentication, 12 engine including nested cases, and 2 original bridge checks |
| Production pipeline | Original direction, frame review, actual music analysis/mixing, history, and H.264/AAC output passed with fixture provider responses; full-size output was 1920×1080, 60 fps, 480 frames, eight seconds |
| DOM and free-code rendering | Production-size captures passed at 1440×1440, 1920×1080, and 1080×1920 with identical loop endpoints; free code rendered 60 frames with four subframes per frame |
| Native services | An isolated synthetic Keychain CRUD test passed and cleaned up; selected-image conversion, rejection of unselected outside images, and media byte ranges passed |
| Native interface | The real WebKit bridge, five tabs, forms, history opening, board loading, video decoding, muted playback, seeking, and subframe access rejection passed; the 1380×900 screenshot was inspected |
| Public music catalog | A separate live Mixkit check returned three eligible tracks and downloaded 524,288 bytes of MP3, identified as 44,100 Hz stereo; this is a bounded sample, not a complete catalog acceptance |
| Live account production | App-connected accounts generated a real ChatGPT specification/1254×1254 board and Claude direction/review; automatic Mixkit music, 1440×1440 MP4 at 60 fps, and history round trip passed |
| Fonts and account limits | Four Google FontFace entries loaded and captures were inspected; broad visual parity and live expiry/renewal/quota cases remain open |
| Distribution | The local arm64 bundle passed signature and runtime checks; Intel, clean-machine installation, Developer ID signing, and notarization remain unverified |

The packaged combined run is recorded in `.local/verification-release-004/native-receipt.json`. Full-size production evidence is in `.local/verification-original-full-002/verification/receipt.json`, and the 1080p UI playback check is in `.local/verification-native-ui-003/native-ui-receipt.json`. These are local evidence paths, not published download links.

The live receipt is `.local/verification-live-005/live-receipt.json`; independent codec/frame-count checks are in its `media-receipt.json`. Continue with broader account/error cases, visual comparison, and distribution checks. [ORIGINAL-VALIDATION.md](ORIGINAL-VALIDATION.md) lists the commands, measurements, and separation from prototype tests; [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md) records attribution.
