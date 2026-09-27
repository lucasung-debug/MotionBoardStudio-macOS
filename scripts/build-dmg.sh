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
mkdir -p "$project_root/.local" "$(dirname "$destination")"
staging="$(mktemp -d "$project_root/.local/dmg-stage.XXXXXX")"
# Keep the exact staging tree as a local packaging receipt; never replace an
# existing installed application or delete an earlier distributable.
ditto "$app" "$staging/MotionBoard Studio.app"
ln -s /Applications "$staging/Applications"
cp scripts/installer/Install.html "$staging/설치 안내.html"
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
echo "Packaging staging tree: $staging"
