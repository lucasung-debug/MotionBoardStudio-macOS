# Specification response recovery

Recorded on 2026-09-27 for local development build 5, with the build 6 latency follow-up below. These changes are not included in the published `0.3.2-mac.3` DMG.

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

## Build 6: specification latency and request visibility

The preserved Claude client defaults to `effort=max`, `max_tokens=128000`, and a one-hour total request timeout. Its idle timeout is reset by received bytes, including SSE pings. The app previously surfaced text/thinking deltas but not message acceptance, hidden thinking blocks, or pings. Those choices allow a long wait with only the initial request message visible. They do not establish what the server was computing during an already running request.

Current [Claude effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort) identifies `medium` as the Opus 5.5 default and effort as the control for response latency. The [thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking) identifies omitted thinking as its default display: thinking blocks can be present with no readable thinking text. The adapter observes block types and public stream metadata; it does not request or expose hidden reasoning.

The Mac specification path now uses `medium` by default on the same model. The form persists an explicit `claudeEffort` choice and displays a corresponding per-response deadline: low/medium 5 minutes, high 10 minutes, xhigh/max 15 minutes. Missing or invalid saved values use medium. The original output-token allowance and the separate video-direction settings remain intact.

`Runtime/claude-activity.cjs` observes the same SSE bytes consumed by the original parser. It distinguishes sending, accepted, waiting, thinking, and writing; counts text without storing it; and emits elapsed time and time since observed activity every five seconds. A ping is evidence of a live stream, not evidence that the model is thinking. Inspection buffers are bounded and malformed events remain the original parser's responsibility.

The response deadline is independent of pings. A timeout aborts the request, returns `SPEC_RESPONSE_TIMEOUT`, preserves existing history, and does not trigger JSON format recovery. User cancellation keeps its distinct cancellation result. Each completed but malformed response still has at most one format-correction request, so that second request has its own deadline. An already running request in an older app keeps its original settings until it finishes or the user cancels it.

The specification-only native verifier records activity state transitions, effort, and elapsed time as safe metadata. Its output never establishes board/video quality or server-side cancellation. No response-time improvement is claimed without a completed live measurement.

### Build 6 verification

The combined local regression suite passed **123 tests**, with no failures or skipped tests:

```sh
node --test Tests/claude-activity.test.cjs Tests/specification.test.cjs Tests/original-engine.test.cjs Tests/original-auth.test.cjs Tests/original-bridge.test.cjs Tests/studio-ui.test.cjs
```

The log is `.local/claude-latency-tests-20260927.log`. It includes transparent SSE byte forwarding, hidden thinking and ping distinctions, split UTF-8/CRLF, bounded inspection, unchanged HTTP/SSE rate-limit retries, deadline retention during backoff, cancellation precedence, timeout error mapping without format recovery, history preservation, and saved-form compatibility.

The release Swift build and packaged application's native WebKit check passed. The native check confirms the effort selector changes the submitted value, progress displays elapsed time, waiting is not labeled as thinking, and cancellation remains available while the provider/effort selectors are disabled. It also verifies the existing board, history, video playback/seeking, and image-video fixture flow. The two inspected interface snapshots are 1380×900; activity events in this UI check are synthetic, not measurements of live Claude work. The existing CSS was unchanged; the visual scanner's four findings are its retained gradients, spinner radius, and YAML monospace style.

Local evidence is `.local/claude-latency-ui-20260927/native-ui-receipt.json`, `native-request-status.png`, `native-ui.png`, and `package-receipt.json`.

All **16** Runtime/UI files in the packaged application match the working source by SHA-256. The DMG checksum verification and mounted application's strict signature verification passed. The public mac.3 DMG and both earlier development DMGs retained their recorded hashes.

Local installer: `dist/MotionBoardStudio-development-6-arm64.dmg`, **73,061,986 bytes**; SHA-256 `45cc1e0dba84473faf83ca02b594080a18987a99f6653a060816138c4c723774`. It is ad-hoc signed, not notarized or published. The user's running build 5 was not stopped or changed.

A specification-only live check was launched from this exact packaged app with the user's same input and an isolated output directory, `.local/claude-medium-live-20260927`. It reached macOS's account-keychain access prompt before sending the Claude request. At this checkpoint, user approval of that OS prompt is pending, so live latency and completed Claude generation remain unverified. No access-control bypass or credential extraction was used. The five-minute response deadline starts only after account access succeeds and the model request begins.
