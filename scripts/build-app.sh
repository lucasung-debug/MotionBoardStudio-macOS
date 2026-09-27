#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
destination="${1:-$project_root/dist/MotionBoard Studio.app}"
if [[ -e "$destination" ]]; then
  echo "Output already exists; choose a new output path: $destination" >&2
  exit 1
fi
swift build -c release
binary_dir="$(swift build -c release --show-bin-path)"
resource_bundle="$binary_dir/MotionBoardStudio_MotionBoardStudio.bundle"
if [[ ! -d "$resource_bundle" ]]; then
  echo "The SwiftPM resource bundle was not found: $resource_bundle" >&2
  exit 1
fi
mkdir -p "$destination/Contents/MacOS" "$destination/Contents/Resources"
cp "$binary_dir/MotionBoardStudio" "$destination/Contents/MacOS/MotionBoardStudio"
ditto "$resource_bundle" "$destination/Contents/Resources/MotionBoardStudio_MotionBoardStudio.bundle"
cat > "$destination/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>MotionBoardStudio</string>
  <key>CFBundleIdentifier</key><string>io.github.lucasung-debug.motionboardstudio</string>
  <key>CFBundleName</key><string>MotionBoard Studio</string>
  <key>CFBundleDisplayName</key><string>MotionBoard Studio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --sign - "$destination"
codesign --verify --strict "$destination"
echo "Created local ad-hoc signed app (not notarized): $destination"
