#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
destination="${1:-$project_root/dist/MotionBoard Studio 0.3.2-mac.3.app}"
if [[ -e "$destination" ]]; then
  echo "Output already exists; choose a new output path: $destination" >&2
  exit 1
fi
node_runtime="$(python3 scripts/prepare-node-runtime.py)"
ffmpeg_runtime="$(python3 scripts/prepare-ffmpeg-runtime.py)"
swift build -c release --product MotionBoardStudio
binary_dir="$(swift build -c release --show-bin-path)"
resource_bundle="$binary_dir/MotionBoardStudio_MotionBoardOriginal.bundle"
if [[ ! -d "$resource_bundle" ]]; then
  echo "The SwiftPM resource bundle was not found: $resource_bundle" >&2
  exit 1
fi
mkdir -p "$destination/Contents/MacOS" "$destination/Contents/Resources"
cp "$binary_dir/MotionBoardStudio" "$destination/Contents/MacOS/MotionBoardStudio"
ditto "$resource_bundle" "$destination/Contents/Resources/MotionBoardStudio_MotionBoardOriginal.bundle"
cp "$node_runtime/node" "$destination/Contents/MacOS/node"
cp "$node_runtime/LICENSE" "$destination/Contents/Resources/Node-LICENSE.txt"
cp "$node_runtime/receipt.json" "$destination/Contents/Resources/Node-provenance.json"
cp "$ffmpeg_runtime/ffmpeg" "$destination/Contents/MacOS/ffmpeg"
cp "$ffmpeg_runtime/ffprobe" "$destination/Contents/MacOS/ffprobe"
ditto "$ffmpeg_runtime/redistribution" "$destination/Contents/Resources/ThirdParty/FFmpeg"
cp LICENSE "$destination/Contents/Resources/LICENSE.txt"
xcrun swift scripts/create-app-icon.swift "$destination/Contents/Resources/AppIcon.icns"
cp scripts/installer/ThirdPartyNotices.html "$destination/Contents/Resources/ThirdPartyNotices.html"
# HFS+ disk images decompose Unicode filenames. Normalize the copied bundle
# before signing so the original Korean prompt names retain valid seals after
# the DMG is mounted. The source checkout remains byte-for-byte untouched.
python3 - "$destination" <<'PY'
from pathlib import Path
import sys
import unicodedata
import uuid
app = Path(sys.argv[1])
for path in sorted(app.rglob('*'), key=lambda item: len(item.parts), reverse=True):
    name = unicodedata.normalize('NFD', path.name)
    if name != path.name:
        target = path.with_name(name)
        if target.exists() and not path.samefile(target):
            raise SystemExit(f'Conflicting normalized resource filename: {path}')
        temporary = path.with_name('.normalizing-' + uuid.uuid4().hex)
        path.rename(temporary)
        temporary.rename(target)
PY
cat > "$destination/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>MotionBoardStudio</string>
  <key>CFBundleIdentifier</key><string>io.github.lucasung-debug.motionboardstudio</string>
  <key>CFBundleName</key><string>MotionBoard Studio</string>
  <key>CFBundleDisplayName</key><string>MotionBoard Studio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.2</string>
  <key>CFBundleVersion</key><string>3</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --sign - "$destination/Contents/MacOS/node"
codesign --force --sign - "$destination/Contents/MacOS/ffmpeg"
codesign --force --sign - "$destination/Contents/MacOS/ffprobe"
python3 - "$destination" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
app = Path(sys.argv[1])
binaries = {}
for name in ['node', 'ffmpeg', 'ffprobe']:
    digest = hashlib.sha256()
    with (app / 'Contents' / 'MacOS' / name).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    binaries[name] = digest.hexdigest()
receipt = {'description': 'SHA256 of bundled helper executables after ad-hoc signing. Source/build receipts describe the unsigned inputs.', 'binaries': binaries}
(app / 'Contents' / 'Resources' / 'packaged-binaries.json').write_text(json.dumps(receipt, indent=2) + '\n')
PY
codesign --force --sign - "$destination"
codesign --verify --deep --strict "$destination"
echo "Created local ad-hoc signed app (not notarized): $destination"
