# Specification response recovery

Recorded on 2026-09-27 for local development build 5. This change is not included in the published `0.3.2-mac.3` DMG.

## Failure and evidence

The reported Claude run failed at the parse stage with `응답에서 결과(JSON)를 찾지 못했습니다`. Its existing diagnostic records 16,014 response characters. That record contains no raw provider response, so the exact original syntax error cannot be established retrospectively.

The original instruction describes YAML inside JSON as a string with actual line breaks. Literal, unescaped line breaks inside a quoted JSON string reproduce the reported error with the original parser. The original service also returns `stopReason`, but the specification handler did not distinguish an output limit from a format error. These are reproduced handling defects, not proof of the precise contents of the past response.

## Changed behavior

- The specification prompt explicitly requires JSON string escaping. Image-only requests receive an image-only final instruction instead of the Claude client's default YAML instruction.
- The parser validates a complete top-level object and required string fields. An unfinished outer object cannot be bypassed by extracting a valid nested object, including after prose or a code fence.
- Unescaped control characters inside quoted strings are encoded locally. Missing quotes, brackets, field values, and ambiguous escaping are not invented.
- A completed but malformed response receives at most one format-correction request through the same selected provider, model, and app account. It preserves the original creative content and factual uncertainty in its instructions; it does not perform or claim new research.
- Authentication, transport, cancellation, refusal/tool turns, output limits, empty responses, and responses over 200,000 characters do not initiate format recovery. Existing transport rate-limit behavior is unchanged.
- No incomplete history entry is saved. Failure diagnostics contain counts, a bounded response shape, a known stop reason, and error metadata; they do not persist the raw response or account credentials.

The provided source under `upstream/` is unchanged. The adapter is `Runtime/specification.cjs`; `Runtime/engine.cjs` controls the one allowed repair. The interface shows whether format correction or local line-break recovery is taking place.

## Verification

The following command passed **87 tests**, with no failures or skipped tests, using local provider fixtures:

```sh
node --test Tests/specification.test.cjs Tests/original-engine.test.cjs Tests/original-auth.test.cjs Tests/original-bridge.test.cjs Tests/studio-ui.test.cjs
```

Coverage includes Korean/Unicode and literal backslash preservation, escaped quotes, all C0 control characters, incomplete outer objects, required field types, full/image-only modes, size limits, one repair only, cancellation during repair, previous-history preservation, and diagnostic redaction. The local log is `.local/claude-spec-tests-20260927.log`.

Build 5 passed `swift build -c release`, `codesign --verify --deep --strict`, and native WebKit verification. The native check used isolated fixture data: 36 bridge methods, history and board loading, 1920×1080 video decoding/playback/seeking, the image-video scene interface, and separate imported-clip output. Its actual 1380×900 snapshot was inspected. This UI check used no live AI generation.

Local receipts:

- `.local/claude-spec-fix-ui-20260927/native-ui-receipt.json`
- `.local/claude-spec-fix-ui-20260927/package-receipt.json`

All 15 Runtime/UI resources in the packaged application match the working source by SHA-256. The new DMG passed image verification and signature verification of its mounted application. The previous public DMG retained its SHA-256.

Local installer: `dist/MotionBoardStudio-development-5-arm64.dmg`, 73,058,079 bytes; SHA-256 `2f8b4a7df96b642cd055c1e3c1bacf16749fac3b1ec10eb89b6c3fda14fead5d`. It is ad-hoc signed, not notarized or published.

## Live specification check

One source-built, same-input Claude attempt reached `prepare` and `request`, but no result text arrived within a 900-second local verification budget. The isolated worker was stopped at 922.7 seconds; the host then returned exit 1. The host's “runtime ended” error is the consequence of that deliberate stop, not evidence of a spontaneous application crash. No format-repair request, board generation, or video generation was started. **Live Claude generation is not verified by this run.** Local evidence is `.local/claude-spec-live-20260927/live-receipt.json` and `supervisor-receipt.json`. This limit was applied to the verification run; the production provider timeouts were not changed.

The native verification executable supports a specification-only run with the account already connected in the application:

```sh
"dist/MotionBoard Studio Development 5.app/Contents/MacOS/MotionBoardStudio" --verify-live --spec-only --input /path/to/spec-input.json --output .local/spec-live-new
```

The input JSON names `provider` (`claude` or `chatgpt`), `topic`, and the usual form fields. This explicit command consumes the selected account's model usage. It does not call image generation, music downloads, rendering, or video providers. Its new output directory isolates generated history from existing app work. The receipt records the model, phases, result lengths, and history round trip, without logging the response text or credentials.
