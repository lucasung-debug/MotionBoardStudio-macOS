# Original-application port roadmap

The target is the creator-provided MotionBoardStudio 0.3.2 production workflow. The earlier independent tile editor remains a prototype; completing its checks does not complete this roadmap.

## 1. Restore the correct baseline

- Preserve the thirty recovered source files and their original relative paths.
- Preview the original input form and concept/YAML/image/video/history tabs.
- Keep browser-only preview capabilities distinct from the application's desktop services.
- Record provenance and the original `window.studio` bridge contract.

## 2. Connect the Swift desktop shell

- Present the original interface in WebKit with typed, allowlisted Swift messages.
- Port the original production-entry schema and history storage to Application Support.
- Implement native open/save panels, imported images/music, Finder reveal, and cancellable tasks.
- Keep image/video access scoped to the application asset directories.
- Verify reloading, persistence, keyboard use, and native dialogs with the real UI.

## 3. Restore original generation and rendering

- Preserve the original prompt documents and result normalization.
- Implement and verify provider login, renewal, streaming, and error handling.
- Preserve the structured direction engine and the experimental generated-code contract.
- Compare original-engine frame capture in all three aspect ratios, including Korean text and fonts.
- Restore music selection/import, beat analysis, sound effects, mixing, and MP4 output.
- Verify cancellation and failed regeneration preserve the previous completed result.

## 4. Improve the existing workflow

- Add a seekable scene preview before final export.
- Make references, start/end states, and loop behavior explicit in the generation contract.
- Support revising a single scene without regenerating the entire production.
- Add export presets, reproducible render receipts, and clearer job progress.
- Complete native UI acceptance, packaging, signing, and distribution verification.

The source-backed mapping and verification boundaries are in [ORIGINAL-PORT.md](ORIGINAL-PORT.md). These are planned port steps, not claims that the original application's services already run in Swift.
