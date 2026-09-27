# macOS distribution

The `0.3.2-mac.3` installer targets Apple Silicon Macs running macOS 14 or later. It packages the original production application with its Node.js and FFmpeg executables so a recipient can install by dragging the app to Applications. It does not include the proposed image-to-video AI integration.

## Build

```sh
scripts/build-app.sh
scripts/build-dmg.sh
```

The first build downloads the pinned official Node archive and the signed official FFmpeg source, verifies their provenance, and compiles FFmpeg locally. Xcode, Python 3, make, and GnuPG are build-time tools, not recipient requirements. The scripts preserve earlier app bundles, DMGs, runtime caches, and user data. Supply unused output paths to make another build.

The default outputs are:

- `dist/MotionBoard Studio 0.3.2-mac.3.app`
- `dist/MotionBoardStudio-0.3.2-mac.3-arm64.dmg`
- `dist/MotionBoardStudio-0.3.2-mac.3-arm64.dmg.sha256`

The DMG contains the app, an Applications shortcut, installation instructions, third-party notices, and the MIT license. Its staging tree is retained under `.local/dmg-stage.*` for inspection.

## Runtime contents

The app's `Contents/MacOS` directory contains the Swift host, `node`, `ffmpeg`, and `ffprobe`. The native host selects those bundled executables before checking external installations. It does not inherit provider credentials or arbitrary FFmpeg settings from the launching environment.

The packaged H.264 path uses the system VideoToolbox encoder. Frame rendering, 30/60 fps choices, four-subframe motion blur, audio mixing, history, and cancellation preservation retain the existing workflow. Source runs with an external FFmpeg retain their previous libx264 path. The two encoders need not produce identical compressed bytes or file sizes.

FFmpeg is executed as a separate process and is built without GPL/nonfree components or Homebrew libraries. The exact source archive, signature, license, configuration, and rebuild script are retained under `Contents/Resources/ThirdParty/FFmpeg`. Node provenance and license texts are also retained. Third-party terms remain separate from the application's MIT license.

## Signing and first launch

This build is ad-hoc signed. It is not Developer ID signed, notarized, or stapled, and is not expected to pass Gatekeeper's normal Internet-download assessment. No Apple distribution signing identity was available in the packaging environment.

After checking the download's source, a recipient may authorize the first launch through macOS System Settings → Privacy & Security → Open Anyway. See [Apple's instructions](https://support.apple.com/en-us/102445). No installer command disables Gatekeeper, removes quarantine, modifies system settings, or reads another app's credentials.

Developer ID signing and notarization require the distributor's Apple Developer credentials. Intel hardware and a separate clean macOS 14 machine are outside this local validation scope.

## Verification

Packaging acceptance checks the compressed image, its mounted app signature, a relocated installed copy, the bundled runtime paths and library dependencies, and the actual offline production/UI flow. Provider responses in these packaging checks are synthetic; they do not consume provider usage or certify a new live-account run. The prior real-account result remains documented in [ORIGINAL-VALIDATION.md](ORIGINAL-VALIDATION.md).

The final installer was checked on 2026-09-27 on an Apple Silicon Mac running macOS 27.0:

| Check | Result |
| --- | --- |
| DMG integrity and read-only mount | Passed |
| Mounted app signature | Deep/strict verification passed |
| Installation | Copied to `/Applications/MotionBoard Studio.app`; all 72 files matched; disk ejected before execution |
| Runtime selection | Node, FFmpeg, and FFprobe resolved inside the installed app; encoder was `h264_videotoolbox` |
| Full production fixture | 1920×1080 H.264/AAC, 60 fps, 480 frames, eight seconds |
| Native UI | Original forms, board/history loading, video playback/seeking, and subframe bridge rejection passed; screenshot inspected |
| Other native checks | Three production-size aspect ratios, deterministic seeking, 60 fps/four-subframe free-code export, cancellation preservation, and isolated Keychain CRUD passed |
| JavaScript suite | 57 tests passed under bundled Node; 46 original authentication/engine/bridge, three preview, eight prototype |
| External library dependencies | All four executables use system libraries; no Homebrew libraries are required |
| Gatekeeper assessment | Rejected as expected for the ad-hoc, non-notarized build; first-launch authorization is required |

The native verification command was:

```sh
env PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  '/Applications/MotionBoard Studio.app/Contents/MacOS/MotionBoardStudio' \
  --verify-original --full-size --output .local/verification-dmg-installed-008
```

It returned exit 0. The installed runtime receipt confirms the app's bundled paths. Local evidence is in `.local/dmg-acceptance-008/installation-receipt.json`, `resource-receipt.json`, and `.local/verification-dmg-installed-008/native-receipt.json`. These are local evidence paths, not public download links.

The initial HFS+ image exposed a Unicode filename normalization problem in three Korean prompt resources. The builder now normalizes only the copied bundle's resource names to NFD before signing and checks the mounted signature as part of DMG creation. The original source content remains unchanged.

Final file: `MotionBoardStudio-0.3.2-mac.3-arm64.dmg` — **72,983,650 bytes** (about 73 MB).

SHA256: `7a47772dc6a335d83e1ea546643f521467f55af02544973adf51a00b8d57f6c1`.
