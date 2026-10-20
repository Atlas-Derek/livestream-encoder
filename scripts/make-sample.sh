#!/usr/bin/env bash
# Generates a 1080p30 test pattern with a 440 Hz tone: media/sample.mp4 (DURATION seconds, default 60).
set -euo pipefail
FFMPEG="${FFMPEG_PATH:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
cd "$(dirname "$0")/.."
mkdir -p media
"$FFMPEG" -hide_banner -loglevel warning -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t "${DURATION:-60}" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 60 \
  -c:a aac -b:a 128k \
  media/sample.mp4
echo "wrote media/sample.mp4"
