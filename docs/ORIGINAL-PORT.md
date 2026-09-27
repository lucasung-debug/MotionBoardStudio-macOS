# Porting the original MotionBoardStudio 0.3.2

The macOS project preserves and ports the supplied MotionBoardStudio application. The source in [upstream/MotionBoardStudio-0.3.2](../upstream/MotionBoardStudio-0.3.2) is the implementation reference. This is a source-based port; no original GitHub repository was supplied to establish a GitHub network fork.

The earlier Swift tile editor is retained as a historical prototype. Its sixteen effects, JSON format, tests, and exports do not establish compatibility with the original application's workflow, documents, or motion engine.

## Original workflow

The shipped source implements the following generation workflow, visible through concept, YAML, board image, video, and history tabs:

1. Enter a topic, mood, style, copy, exclusions, aspect ratio, desired duration, and optional additional requests.
2. Select ChatGPT or Claude for the production specification. The result contains a title, concept, YAML specification, image prompt, and notes; output modes also cover image-only and specification-only requests.
3. Optionally generate a 4×4 board through the ChatGPT image path, or import an external board image. Video generation can proceed from the specification without a board.
4. Select music from the automatic catalog path, a local file, or no music. Audio analysis and the beat grid determine the loop timing; the no-music path can still include synthesized effects.
5. Generate direction for the built-in design engine, or use the experimental generated HTML/CSS/JavaScript path. The pipeline validates its composition, attempts repairs, and can review sampled frames before rendering.
6. Render an MP4 with mixed audio, retain the composition and poster, and attach the outputs to the history entry. The UI supports reopening results, saving assets, and revealing their files.

These are source observations, not successful macOS provider or rendering results. The original interface is a generation and result-management application, rather than the timeline editor introduced by the earlier prototype.

## Entry points and proposed Swift services

Service names below describe the target architecture. They are not a claim that each service or its original behavior has been implemented.

| Original entry point | Swift/macOS responsibility |
| --- | --- |
| `main.cjs:createWindow`, `registerIpc`; `preload.cjs:studio` | `AppCoordinator` and a typed `StudioBridge`; retain the original screens initially while replacing Electron IPC |
| `main.cjs:runSpec`; `lib/prompt.cjs:buildInstructions`, `normalizeResult`; `prompts/` | `SpecificationService`; preserve guide resources, request fields, result normalization, streaming progress, and cancellation |
| `main.cjs:runBoard`, `studio:imageImport` | `BoardService` and `AssetStore`; preserve optional generation, external image import, retry, and save behavior |
| `lib/codex.cjs`, `lib/claude.cjs`, authentication modules | `ProviderClient` and `AccountStore`; verify supported login and streaming, use Keychain, and keep credentials out of documents |
| `main.cjs:runVideo`; `lib/video/pipeline.cjs:runVideo` | `VideoPipeline`; preserve stages, options, progress, cancellation, and output metadata |
| `lib/video/script.cjs:normalizeScript`, `buildEngineShell`; `engine.js`, `kit.js` | `DirectionService` and `WebKitMotionRenderer`; retain the scene contract and explicit-time browser rendering |
| `lib/video/compose.cjs:parseCompose`, `buildShell` | `CodeCompositionService`; preserve the experimental composition contract in a controlled web renderer |
| `lib/video/audio.cjs`, `dsp.cjs`, `mixkit.cjs` | `AudioService`; compare beat analysis, loop cutting, synthesized effects, mixing, and music metadata |
| `lib/video/render.cjs:renderVideo`; `ffmpeg.cjs` | `FrameCaptureService` and `VideoEncoder`; replace Chromium capture and Windows setup, then compare encoding and audio muxing |
| `lib/store.cjs`; image/video save and reveal handlers in `main.cjs` | `HistoryStore` and native file services; preserve entry fields, related assets, newest-first order, and the 60-entry limit |

The existing WebKit and AVFoundation prototype can inform the capture implementation. It does not demonstrate that the original DOM/CSS renderer, fonts, motion blur, audio, or generated compositions render equivalently.

## Verification and next steps

Verified on 2026-09-27: the upstream snapshot contains 30 files totaling 360,724 bytes; all files match the retained extraction by SHA-256 comparison. The workflow and entry-point mapping above were checked against that source.

A localhost preview of the original screens is available through `node scripts/preview-original.cjs`. Its three Node tests passed: original HTML is retained apart from explicit preview injections, unsupported actions return honest errors, and the server only serves allowlisted assets. An isolated Chromium check verified all five tabs, provider switching, and topic/mood/provider persistence after reload, with zero page errors and zero outgoing external requests. The original renderer HTML, CSS, and JavaScript still match the retained extraction. The preview notice and actual screen were visually inspected.

This preview does not exercise real login, generation, filesystem integration, or stored production history. The original application's complete macOS workflow, provider compatibility, audio output, and rendering parity remain unverified.

The new preview resources passed the visual-pattern scanner (two files, zero findings). This check does not claim to audit or redesign the preserved original interface.

1. Verify the original screens, form state, tabs, progress, cancellation, and history navigation with local fixtures.
2. Port specification normalization and history/asset contracts with synthetic fixtures, preserving original field meanings.
3. Run a fixed local direction document and local audio through the original engine in WebKit. Compare Korean text, three aspect ratios, representative transitions, exact frame times, loop boundaries, and audio alignment.
4. Validate the free-code composition path separately, then add provider integration through supported authentication and test each provider explicitly.

Keep verification receipts scoped to the original port or the historical prototype. See [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md) for attribution and the supplied source's origin.
