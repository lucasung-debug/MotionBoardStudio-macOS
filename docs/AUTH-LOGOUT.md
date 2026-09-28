# MotionBoard logout investigation

Status: investigation paused at the user's requested source checkpoint on 2026-09-28. Actual logout with the affected account remains unverified.

## Observed behavior

The running MotionBoard development build 7 displayed a generic `AUTH_STORAGE` error when logout failed. The reported issue concerned "Codex logout"; the visible MotionBoard error led this investigation to its ChatGPT account path. Other applications' account stores were not changed.

A narrowly scoped Keychain attributes query found the MotionBoard account entry in an unlocked Keychain. It did not retrieve credentials. A code requirement failure appeared in system logs around the reported failure, but it has not been causally linked to this logout attempt. The underlying cause is still unknown.

## Implemented diagnostics

The logout error path now preserves the native Keychain operation and its macOS status code:

- Swift emits a typed operation and `OSStatus` through the native bridge.
- The worker accepts the diagnostic only for the matching vault operation and a nonzero signed 32-bit status.
- Authentication errors expose a fixed message with those bounded fields. Arbitrary native error text is not included in the displayed authentication error.
- A failed deletion continues to report failure and retains authentication state.

This change adds diagnostic support. It does not establish that the affected account can log out successfully. The separate authentication save path still uses its generic storage error handling.

## Verification completed

- 63 authentication, worker, engine and bridge tests passed, including the worker-to-authentication error propagation regression and rejection of malformed diagnostics.
- The native vault fixture passed create, read, update and delete operations in a separate synthetic Keychain namespace.
- Development build 12 compiled and passed the packaging script's local ad-hoc signature verification.

Focused regression command:

```sh
node --test Tests/original-auth.test.cjs Tests/worker-auth.test.cjs Tests/original-engine.test.cjs Tests/original-bridge.test.cjs
```

The source checkpoint also passed all 224 Node tests with no skips, including actual local FFmpeg cropping and MP4 assembly, plus all 8 release-script unit tests. Service responses and notarization responses in these tests were fixtures; they did not exercise live generation or Apple notarization.

```sh
MOTION_BOARD_TEST_FFMPEG="$PWD/dist/MotionBoard Studio Development 12.app/Contents/MacOS/ffmpeg" node --test Tests/*.test.cjs
python3 Tests/release-macos.test.py
```

## Resume point

The new local diagnostic app is `dist/MotionBoard Studio Development 12.app`. On launch, macOS requested Keychain access for this binary. At the checkpoint, that prompt had not been confirmed by the user and actual logout had not been exercised. The installed build 7 was preserved.

When the user resumes verification, allow the macOS Keychain prompt directly on the Mac, inspect the app's authentication state, and try its ChatGPT logout action. If it fails, use the recorded operation and status to investigate the specific cause. Verify that successful logout remains effective after restarting the app.

No real account credentials were removed or copied during this investigation. No provider generation was requested. Development build 12 has no published DMG; the public release remains [0.3.2-mac.3](https://github.com/lucasung-debug/MotionBoardStudio-macOS/releases/tag/v0.3.2-mac.3).
