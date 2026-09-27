# Roadmap

Status: Phase 1 is implemented and has automated model, renderer, and native export verification. Manual editor acceptance remains open. The milestones below separate that implementation from future scope; see [VALIDATION.md](VALIDATION.md) for exact checks and limits.

## Phase 1 — Local editor and exports

Implemented in the initial macOS editor:

- Native SwiftUI controls and a WKWebView Canvas preview with sixteen original effects.
- Per-tile text, effect, and accent editing; shared playback, pause, and timeline seeking.
- JSON save and open, including validation of unsupported versions and invalid documents.
- Standalone offline HTML export and PNG export of the selected frame.
- Native H.264 MP4 export using explicit frame timestamps, progress, and cancellation.
- Swift core models and focused tests for document validation, timing, and export inputs.
- Atomic local draft recovery, with discard confirmation when replacing a recovered draft.

Builds and automated model, rendering, and export checks have passed. Remaining acceptance includes manual macOS editing and playback, native save/open dialogs, clipboard use, draft recovery interactions, and light/dark appearance. The available graphical session was locked during verification, so this phase is not marked fully accepted.

## Phase 2 — Storyboard interoperability and providers

Planned after the local workflow is verified:

- Define a documented storyboard/spec format with stable identifiers, versioning, validation, and import/export fixtures.
- Map scenes, timing, text, and supported visual parameters into editable boards; surface unsupported fields explicitly.
- Introduce a provider abstraction so generation can be added without coupling local documents to one service.
- Add providers through their documented, supported authentication methods. Store secrets in macOS Keychain; keep them out of project files, exports, and logs.
- Show the provider, requested action, and any known cost before a user initiates a remote generation request.

Provider integrations and Keychain handling remain planned. No provider compatibility, authentication support, or hosted generation is claimed by Phase 1.

## Phase 3 — Audio, review, and distribution

- Add local audio import, beat markers, and timing controls; verify synchronization in previews and exported video.
- Add review workflows for comparing revisions, inspecting frames, and recording export settings.
- Prepare reproducible app packaging, signing, and notarization; verify installation and launch on supported macOS versions.
- Maintain a feature comparison against observable reference behavior, separating implemented, verified, unsupported, and deferred items. Evaluate visual and workflow parity with reproducible examples rather than assumed equivalence.

Reuse of material from the previously assessed Windows application depends on clarified rights. That dependency does not authorize copying its code, prompts, or assets. See [INSPIRATION.md](INSPIRATION.md) for the reference and source boundaries.
