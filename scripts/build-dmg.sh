#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
app="${1:-$project_root/dist/MotionBoard Studio 0.3.2-mac.3.app}"
destination="${2:-$project_root/dist/MotionBoardStudio-0.3.2-mac.3-arm64.dmg}"
if [[ -e "$destination" || -e "$destination.sha256" ]]; then
  echo "Output already exists; choose a new destination: $destination" >&2
  exit 1
fi
if [[ ! -d "$app" ]]; then
  scripts/build-app.sh "$app"
fi
for executable in MotionBoardStudio node ffmpeg ffprobe; do
  if [[ ! -x "$app/Contents/MacOS/$executable" ]]; then
    echo "The installer requires a self-contained app; missing executable: $executable" >&2
    exit 1
  fi
done
codesign --verify --deep --strict "$app"
if [[ "${MOTION_BOARD_NOTARIZED:-0}" == 1 ]]; then
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
fi
mkdir -p "$project_root/.local" "$(dirname "$destination")"
staging="$(mktemp -d "$project_root/.local/dmg-stage.XXXXXX")"
# Keep the exact staging tree as a local packaging receipt; never replace an
# existing installed application or delete an earlier distributable.
ditto "$app" "$staging/MotionBoard Studio.app"
ln -s /Applications "$staging/Applications"
cp scripts/installer/Install.html "$staging/설치 안내.html"
python3 - "$app" "$staging/설치 안내.html" "${MOTION_BOARD_NOTARIZED:-0}" <<'PY'
from pathlib import Path
import plistlib
import re
import sys
info = plistlib.loads((Path(sys.argv[1]) / 'Contents/Info.plist').read_bytes())
guide = Path(sys.argv[2])
text = guide.read_text()
text = re.sub(r'0\.3\.2 · Mac 빌드 \d+', f"{info['CFBundleShortVersionString']} · Mac 빌드 {info['CFBundleVersion']}", text)
if sys.argv[3] == '1':
    text = re.sub(r'<!-- SIGNING_NOTICE_START -->.*?<!-- SIGNING_NOTICE_END -->',
        '<h2>처음 실행할 때</h2>\n<p>이 앱은 Developer ID로 서명하고 Apple 공증을 받았습니다. 인터넷에서 다운로드한 앱을 열겠다는 확인 창이 나타나면 <strong>열기</strong>를 선택하세요.</p>',
        text, flags=re.S)
guide.write_text(text)
PY
cp scripts/installer/ThirdPartyNotices.html "$staging/ThirdPartyNotices.html"
cp LICENSE "$staging/LICENSE.txt"
hdiutil create -volname "MotionBoard Studio" -srcfolder "$staging" -fs HFS+ \
  -format UDZO -imagekey zlib-level=9 "$destination"
hdiutil verify "$destination"
python3 - "$destination" <<'PY'
from pathlib import Path
import subprocess
import sys
import tempfile
mount = Path(tempfile.mkdtemp(prefix='dmg-signature-', dir='.local')).resolve()
subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), sys.argv[1]], check=True)
try:
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(mount / 'MotionBoard Studio.app')], check=True)
finally:
    subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
print('Mounted app signature: verified')
PY
if [[ "${MOTION_BOARD_DEFER_CHECKSUM:-0}" != 1 ]]; then
python3 - "$destination" <<'PY'
import hashlib
from pathlib import Path
import sys
file = Path(sys.argv[1])
hash = hashlib.sha256()
with file.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        hash.update(chunk)
digest = hash.hexdigest()
with file.with_name(file.name + '.sha256').open('x') as checksum:
    checksum.write(f'{digest}  {file.name}\n')
print(f'Created {file.resolve()} ({file.stat().st_size:,} bytes)')
print(f'SHA256: {digest}')
PY
fi
echo "Packaging staging tree: $staging"
