#!/usr/bin/env bash
# Pushes a live test pattern (or a looping file) to an RTMP ingest, like OBS would.
# Usage: scripts/push-rtmp.sh [rtmp-url] [file]
set -euo pipefail
FFMPEG="${FFMPEG_PATH:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
URL="${1:-rtmp://localhost:1935/live/test}"
FILE="${2:-}"
if [[ -n "$FILE" ]]; then
  INPUT=(-re -stream_loop -1 -i "$FILE")
else
  INPUT=(-re -f lavfi -i "testsrc2=size=1920x1080:rate=30" -re -f lavfi -i "sine=frequency=440:sample_rate=48000")
fi
echo "pushing to $URL (Ctrl+C to stop)"
exec "$FFMPEG" -hide_banner -loglevel warning "${INPUT[@]}" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 60 -b:v 4500k \
  -c:a aac -b:a 128k -ar 48000 \
  -f flv "$URL"
