#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
output="${1:-$project_root/.local/verification-$(date +%Y%m%d-%H%M%S)-$$}"
swift build --product MotionBoardStudio
binary_dir="$(swift build --show-bin-path)"
exec "$binary_dir/MotionBoardStudio" --verify-original --output "$output"
