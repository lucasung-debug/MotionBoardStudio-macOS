# Original-application roadmap

The creator-provided MotionBoardStudio 0.3.2 workflow is implemented in the Swift macOS host, WebKit, and local Node runtime. Local production and native UI checks pass. Real-provider acceptance and broader distribution checks remain open.

## Implemented and locally verified

- Preserve the original interface, guides, production contracts, structured direction engine, and experimental generated-code path.
- Replace Electron integration with 26 runtime bridge operations, Swift native actions, and WebKit DOM capture.
- Exercise specification and board fixtures through actual music analysis, direction, frame review, audio mixing, FFmpeg output, and history.
- Verify a 1920×1080, 60 fps, 480-frame H.264/AAC output; production-size captures in all three aspect ratios; free-code output and four-subframe rendering.
- Verify cancellation preserves completed output and stops subsequent work in the same UI flow.
- Verify native forms, history opening, board loading, media byte ranges, 1080p video decoding/playback/seeking, and rejection of iframe bridge calls.
- Verify app-specific authentication behavior with mocks and actual Keychain CRUD using a unique synthetic test service, followed by cleanup.
- Package official Node.js 24.21.0 arm64, retain its provenance/license, and verify the local bundle's ad-hoc signature.

The public Mixkit catalog and a bounded MP3 download passed a separate live check. Provider account states and AI responses in the production/UI checks remained fixtures. The earlier tile editor and its tests are separate prototype evidence.

## Live acceptance remains open

- Complete fresh ChatGPT and Claude login, renewal, streaming, generation, error handling, and account-state checks with real accounts.
- Compare external Google Fonts loading, Korean glyph metrics, and representative generated compositions.
- Extend the bounded music-catalog sample to the normal automatic-selection workflow.

## Distribution remains open

- Verify installation and launch on clean supported macOS systems and Intel hardware.
- Complete Developer ID signing and notarization for distribution.

## Later workflow improvements

- Add a seekable scene preview before full MP4 rendering.
- Make start, transition, and end states explicit in scene review.
- Revise a single scene while preserving approved scenes and assets.
- Add export presets, clearer job progress, and reproducible render receipts.

[ORIGINAL-PORT.md](ORIGINAL-PORT.md) maps current services to the original source. [ORIGINAL-VALIDATION.md](ORIGINAL-VALIDATION.md) records local results and the limits of each check.
