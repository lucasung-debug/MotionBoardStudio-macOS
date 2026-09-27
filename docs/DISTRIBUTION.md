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

## Developer ID release workflow

The released `mac.3` DMG above remains ad-hoc signed. On 2026-09-27, the distributor chose to keep the existing free distribution rather than enroll in a paid developer program. The optional `scripts/release-macos.py` workflow is retained for a future signed release, with build 4 as its next default; adding this script does not notarize or replace an existing download.

First create or import a **Developer ID Application** certificate and its private key in the current Mac's login keychain. In Xcode, use Settings → Accounts → the enrolled developer team → Manage Certificates, and select **Developer ID Application** from the menu beside the plus button. An **Apple Development** certificate does not qualify. See [Apple's certificate requirements](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).

Create a project-specific notarization profile in an interactive terminal:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun notarytool store-credentials MotionBoardStudio
```

Enter the enrolled Apple account, Team ID, and app-specific password into the terminal prompts, not chat, a checked-in file, or a shell argument. The release script uses the named Keychain profile without extracting its credentials. Xcode login alone does not create this profile.

```sh
python3 scripts/release-macos.py --check
python3 scripts/release-macos.py --build-number 4
```

If several Developer ID certificates are installed, select one with `--identity '<certificate SHA1>'`. A different notarization profile can be selected with `--profile`.

The workflow signs Node, FFmpeg and FFprobe before the enclosing app, using a secure timestamp and hardened runtime. Only Node receives `com.apple.security.cs.allow-jit`; the Swift host and FFmpeg helpers receive no exception entitlements. It checks the actual signatures and entitlements, then runs the offline full-size production and native UI fixtures under the hardened app.

It submits an app ZIP to Apple, checks `Accepted` and the archive hash in Apple's log, staples the app, and then packages, signs, submits and staples the DMG. The app submission allows the copied app to retain its own ticket. The DMG must pass integrity, signature, ticket and Gatekeeper checks, including checks of the mounted app, before the completed DMG and its post-stapling checksum appear in `dist`. These are local distribution checks; a quarantined download/install check is still required before announcing a successful public release.

Every run retains its working files, submission IDs and logs under `.local/release-0.3.2-mac.4-*`. Resume the printed directory after a recoverable failure:

```sh
python3 scripts/release-macos.py --resume '/absolute/path/to/the/retained/run'
```

Resume reuses a recorded Apple submission. An unconfirmed upload without a saved ID stops for reconciliation with `notarytool history`; it is never automatically resubmitted. Existing releases and installed apps are preserved. The workflow does not publish to GitHub or change macOS security settings.

References: [Apple signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac), [notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), and [packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

### Release preparation checks (2026-09-27)

The following checks cover the new workflow's local preparation, not Apple acceptance or a new published DMG:

- `python3 Tests/release-macos.test.py`: eight offline checks passed, covering certificate selection, actual hardened-runtime flags, changed archives, ambiguous uploads, and accepted/rejected Apple response fixtures.
- An isolated copy of the app was ad-hoc signed with hardened runtime and only the Node `allow-jit` entitlement. Its 46 original authentication/engine/bridge tests passed. The full-size native fixture produced 1920×1080 H.264/AAC at 60 fps, 480 frames/eight seconds; native UI playback/seeking and the synthetic Keychain checks passed. The 1380×900 native screenshot was inspected. Evidence: `.local/hardened-runtime-rf76xe3z/`.
- A fresh build with `CFBundleVersion=4` was packaged locally; the mounted signature check still ran when checksum generation was deferred. Requesting notarized packaging for this unticketed fixture correctly failed before DMG creation. Evidence: `.local/release-packaging-check-qm6aefxx/`.
- The live release preflight stopped because no valid Developer ID Application identity was available. Apple submission, Developer ID execution acceptance, and a new public download remain pending distributor setup. No new release was published by these checks.

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
