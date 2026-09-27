# Validation record

Checked on 2026-09-27 with Swift 6.4, Xcode 27.0 (27A266a), and an Apple Silicon macOS 27 host. The package declares macOS 14 as its deployment target; older systems and Intel hardware were not exercised.

| Check | Result |
| --- | --- |
| `swift test` with the full Xcode developer directory | Exit 0; 17 tests in 3 Swift Testing suites |
| `node --test Tests/board-runtime.test.cjs` | Exit 0; 8 tests |
| `scripts/build-app.sh` | Release build and local ad-hoc signature verification passed |
| Packaged executable launched from outside the build directory with `--verify-render` | Exit 0; native WebKit and AVFoundation checks passed |
| Visual-pattern source scanner | 2 HTML/CSS/JavaScript resource files scanned; 0 findings. This does not cover SwiftUI layout. |

## Native rendering and export

The integration check uses an original synthetic project with Korean text and the sixteen bundled effects. It runs the actual packaged macOS executable and its bundled renderer without any provider or network connection.

- PNG dimensions match 1280×720, 1280×1280, and 720×1280.
- Seeking to the same phase in adjacent loops produces byte-identical PNGs. Seeking to different phases changes the image.
- A silent H.264 MP4 contains 48 frames at 480×270, 24 fps, and a two-second duration.
- Decoded presentation timestamps match the requested frame schedule. Compressed sample timestamps include codec priming/edit-list offsets and are not used as displayed-frame times.
- A 2.01-second export with four-sample motion blur retains its requested duration.
- Cancellation before rendering and after the first rendered frame both preserve an existing destination. No temporary MP4 remains after cancellation.
- The release app includes its SwiftPM resource bundle and passes the same checks when launched from outside the build directory.

The exported PNGs and a decoded MP4 frame were visually inspected. The committed [board image](images/board.png) is a native WebKit output, not a screenshot of the native editor. [The machine-readable receipt](validation/native-export.json) records the final run.

## Remaining acceptance

The macOS session reported that its screen was locked. Manual native editor checks in light and dark appearances were not completed. Keyboard navigation, native dialogs, clipboard actions, and draft recovery across window/app lifecycle still need interactive acceptance.

This record does not establish parity with the separately inspected Windows application, live provider compatibility, audio synchronization, sustained 1080p60 throughput, Intel compatibility, or notarized distribution readiness. Unit-test success is not a claim about those untested areas.
