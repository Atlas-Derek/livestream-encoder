#!/usr/bin/env bash
# Pushes a live test pattern (or a looping file) to an SRT listener in caller mode.
# Usage: scripts/push-srt.sh [srt-url] [file]
# With a passphrase: scripts/push-srt.sh 'srt://localhost:9000?mode=caller&passphrase=secret-phrase&pbkeylen=16'
set -euo pipefail
FFMPEG="${FFMPEG_PATH:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
URL="${1:-srt://localhost:9000?mode=caller}"
FILE="${2:-}"
if [[ -n "$FILE" ]]; then
  INPUT=(-re -stream_loop -1 -i "$FILE")
else
  INPUT=(-re -f lavfi -i "testsrc2=size=1920x1080:rate=30" -re -f lavfi -i "sine=frequency=440:sample_rate=48000")
fi
# Wall clock burned in at the source: compare it with a real clock next to the player to read end-to-end latency.
OVERLAY="drawtext=text='SRT push  %{localtime\\:%T}':fontsize=h/14:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=24:y=24"
echo "pushing to $URL (Ctrl+C to stop)"
exec "$FFMPEG" -hide_banner -loglevel warning "${INPUT[@]}" \
  -vf "$OVERLAY" -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 60 -b:v 4500k \
  -c:a aac -b:a 128k -ar 48000 \
  -f mpegts "$URL"
