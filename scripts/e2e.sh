#!/usr/bin/env bash
# End-to-end test of the whole stack against real ffmpeg and nginx (npm run e2e, about 4 minutes).
#
# Runs nginx (scripts/nginx.sh, signed mode) and the API on their default ports, with all data in a temporary
# directory, never var/. Creates one channel of each kind, pushes RTMP and SRT, and checks each channel with
# check:hls and an ffmpeg viewer, then: signed URLs, encryption, HDR, DVR, thumbnails, metrics, the slate, on-demand
# recording, a graceful restart and webhooks. Exits 1 if any check fails.
#
# Needs media/sample.mp4 and media/test/ (npm run sample, npm run test-media), and free ports: it refuses to run
# while your own nginx or API is up. KEEP=1 keeps the temporary directory (logs, output) for a look afterwards.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
FFMPEG="${FFMPEG_PATH:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
FFPROBE="${FFPROBE_PATH:-/opt/homebrew/opt/ffmpeg-full/bin/ffprobe}"
WEBHOOK_PORT=8719

for file in media/sample.mp4 media/test/1080p60.mp4 media/test/hdr-hlg.mp4; do
  [[ -f "$file" ]] || { echo "missing $file: run npm run sample and npm run test-media first" >&2; exit 2; }
done
for port in 8080 3000 1935 1936 1937 9000 9001 "$WEBHOOK_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "port $port is in use: stop your own nginx/API (and anything else on it) first" >&2
    exit 2
  fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lse-e2e.XXXXXX")"
PIDS=()
cleanup() {
  # ${PIDS[@]+…}: bash 3.2, which macOS ships, treats an empty array as unset under set -u.
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do pkill -P "$pid" 2> /dev/null; kill "$pid" 2> /dev/null; done
  pkill -P $$ 2> /dev/null # anything else started here, such as an interrupted pause's sleep
  wait 2> /dev/null
  if [[ "${KEEP:-0}" = 1 ]]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

export PLAYBACK_SECRET=e2e-secret-0123456789
WEBHOOK_SECRET=e2e-hook-secret
PASS=0
FAIL=0

# check <description> <command> [args…]: runs the command and counts it.
check() {
  local description="$1"
  shift
  if "$@"; then PASS=$((PASS + 1)); echo "  PASS  $description"; else FAIL=$((FAIL + 1)); echo "  FAIL  $description"; fi
}
# json <expression>: evaluates a JavaScript expression over the JSON on stdin, bound to d.
json() {
  node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); const v = ($1);
    console.log(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);"
}
api() { curl -s "localhost:3000$1"; }
channel() { api "/channels/$1" | json "$2"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
# pause <seconds>: a sleep that Ctrl+C or kill -INT interrupts at once (bash runs traps only between commands, but
# does interrupt wait).
pause() { sleep "$1" & wait $!; }
eventually() { # eventually <seconds> <command> [args…]
  local seconds="$1"
  shift
  for _ in $(seq "$seconds"); do "$@" && return 0; pause 1; done
  return 1
}
create() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -XPOST localhost:3000/channels -H 'content-type: application/json' -d "$1")" = "$2" ]]
}
in_state() { [[ "$(channel "$1" d.state)" = "$2" ]]; }
background() { "$@" > /dev/null 2>&1 & PIDS+=($!); }

start_api() {
  VAR_DIR="$TMP/var" WEBHOOK_URLS="http://127.0.0.1:$WEBHOOK_PORT/hook" WEBHOOK_SECRET="$WEBHOOK_SECRET" LOG_LEVEL=warn \
    node --disable-warning=ExperimentalWarning src/index.ts >> "$TMP/api.log" 2>&1 &
  API=$!
  PIDS+=("$API")
  eventually 15 curl -sf localhost:3000/health > /dev/null
}

# nginx from a copy, so that its relative paths (var/hls, the generated playback.conf) are the temporary directory's.
mkdir -p "$TMP/scripts" "$TMP/var/hls"
cp scripts/nginx.sh "$TMP/scripts/"
cp -R nginx "$TMP/"
"$TMP/scripts/nginx.sh" > "$TMP/nginx.log" 2>&1 &
PIDS+=($!)

# Webhook receiver: one line per event, with whether its signature checks out.
cat > "$TMP/receiver.mjs" <<'EOF'
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
const [port, secret] = process.argv.slice(2);
createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
    const body = Buffer.concat(chunks);
    const signed = req.headers['x-lse-signature'] === `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const e = JSON.parse(body);
    console.log(e.event, e.channel, e.state ?? e.recording, signed ? 'signed' : 'BAD');
    res.writeHead(204).end();
  });
}).listen(Number(port), '127.0.0.1');
EOF
node "$TMP/receiver.mjs" "$WEBHOOK_PORT" "$WEBHOOK_SECRET" > "$TMP/events.log" 2>&1 &
PIDS+=($!)
start_api || { echo "the API did not start; see $TMP/api.log" >&2; KEEP=1; exit 1; }

echo "== Setup"
check "nginx serves signed URLs only" grep -q 'signed URLs only' "$TMP/nginx.log"
check "create vod (encrypted, thumbnails)" create \
  '{"id":"vod","mode":"vod","encrypt":true,"thumbnails":true,"input":{"type":"file","path":"media/test/1080p60.mp4"}}' 201
check "create hdr (VOD from HLG)" create '{"id":"hdr","mode":"vod","input":{"type":"file","path":"media/test/hdr-hlg.mp4"}}' 201
check "create loop (live, 40s DVR window)" create \
  '{"id":"loop","dvrWindowSeconds":40,"input":{"type":"file","path":"media/sample.mp4","loop":true}}' 201
check "create push (RTMP, encrypted, thumbnails)" create \
  '{"id":"push","encrypt":true,"thumbnails":true,"input":{"type":"rtmp","streamKey":"k1"}}' 201
check "create copy (RTMP passthrough)" create '{"id":"copy","passthrough":true,"input":{"type":"rtmp","streamKey":"k2"}}' 201
check "create srt (passphrase)" create '{"id":"srt","input":{"type":"srt","passphrase":"correct-horse-battery"}}' 201
check "refuse encrypted fMP4" create '{"id":"bad","encrypt":true,"segmentType":"fmp4","input":{"type":"srt"}}' 400

PUSH_PORT=$(channel push d.port)
COPY_PORT=$(channel copy d.port)
SRT_PORT=$(channel srt d.port)
eventually 20 in_state push waiting_for_publisher
background scripts/push-rtmp.sh "rtmp://localhost:$PUSH_PORT/live/k1"
PUSHER=$!
background scripts/push-rtmp.sh "rtmp://localhost:$COPY_PORT/live/k2"
background scripts/push-srt.sh "srt://localhost:$SRT_PORT?mode=caller&passphrase=correct-horse-battery&pbkeylen=16"
check "push is running" eventually 30 in_state push running
recording_is() { [[ "$(curl -s -XPOST "localhost:3000/channels/push/recording/$1" | json d.recordingEnabled)" = "$2" ]]; }
check "start recording on demand" recording_is start true
check "create pull (HTTP pull of loop's signed URL)" create \
  "{\"id\":\"pull\",\"input\":{\"type\":\"pull\",\"url\":\"$(channel loop d.playbackUrl)\"}}" 201
echo "  …letting every channel run for 45s"
pause 45

echo "== Every channel"
for id in vod hdr loop push copy srt pull; do
  want=running
  [[ $id = vod || $id = hdr ]] && want=completed
  url=$(channel "$id" d.playbackUrl)
  check "$id: $want, no warnings" eval "[[ \"\$(channel $id d.state)\" = $want && \"\$(channel $id d.warnings)\" = '[]' ]]"
  check "$id: signed playback URL" grep -q '/hls/_s/' <<< "$url"
  check "$id: check:hls passes" eval "npm run -s check:hls -- '$url' > '$TMP/check-$id.log' 2>&1"
  check "$id: an ffmpeg viewer decodes it" "$FFMPEG" -hide_banner -loglevel error -i "$url" -map 0:v:0 -t 5 -f null -
  check "$id: unsigned is refused" test "$(status_of "http://localhost:8080/hls/$id/master.m3u8")" = 403
done
hdr_transfer() {
  "$FFPROBE" -v error -select_streams v:0 -show_entries stream=color_transfer -of default=nw=1:nk=1 \
    "$(ls "$TMP"/var/hls/hdr/720p/seg_*_00000.ts)" | head -1
}
check "hdr: tone mapped to BT.709" test "$(hdr_transfer)" = bt709
check "vod: thumbnails served signed" test "$(status_of "$(channel vod d.thumbnailsUrl)")" = 200
LOOP_BASE=$(channel loop d.playbackUrl)
LOOP_BASE=${LOOP_BASE%/master.m3u8}
check "loop: DVR window of 10 segments" test "$(curl -s "$LOOP_BASE/720p/index.m3u8" | grep -c '^seg_')" -ge 10
PUSH_BASE=$(channel push d.playbackUrl)
PUSH_BASE=${PUSH_BASE%/master.m3u8}
check "push: AES-128 key with an explicit IV" grep -q 'METHOD=AES-128,URI="../key_.*IV=0x' <<< "$(curl -s "$PUSH_BASE/720p/index.m3u8")"
check "metrics: all five live channels running" \
  test "$(api /metrics | grep -c 'lse_channel_state{.*state="running"} 1')" -eq 5

echo "== Publisher drops out: slate, then back"
kill "$PUSHER"
pause 12
check "push: slate segments, unencrypted" grep -q '^slate_' <<< "$(curl -s "$PUSH_BASE/720p/index.m3u8" | grep -A3 'METHOD=NONE')"
check "push: the recording closed when the slate started" \
  test "$(api /channels/push/recordings | json 'd.map((r) => r.open).join()')" = false
background scripts/push-rtmp.sh "rtmp://localhost:$PUSH_PORT/live/k1"
PUSHER=$!
check "push: running again" eventually 30 in_state push running
pause 14
check "push: live segments after the slate" grep -q '^seg_' <<< "$(curl -s "$PUSH_BASE/720p/index.m3u8" | tail -1)"
check "push: check:hls across the slate" eval "npm run -s check:hls -- '$PUSH_BASE/master.m3u8' > '$TMP/check-push-slate.log' 2>&1"
check "stop recording" recording_is stop false
pause 4
api /channels/push/recordings > "$TMP/recordings.json"
check "push: two closed recordings, both with thumbnails" test "$(json \
  'd.length === 2 && d.every((r) => !r.open && r.thumbnailsUrl !== null)' < "$TMP/recordings.json")" = true
for url in $(json "d.map((r) => r.playbackUrl).join(' ')" < "$TMP/recordings.json"); do
  check "a recording passes check:hls and decodes" eval "npm run -s check:hls -- '$url' > /dev/null 2>&1 &&
    '$FFMPEG' -hide_banner -loglevel error -i '$url' -map 0:v:0 -f null -"
done

echo "== Graceful restart"
kill -INT "$API"
wait "$API"
check "shutdown closed every recording" eval "! grep -L ENDLIST '$TMP'/var/hls/push/recordings/*/720p/index.m3u8 | grep -q ."
start_api
# The shutdown cut the RTMP publisher off, and push-rtmp.sh doesn't reconnect, so push waits for a new one.
both_back() { in_state push waiting_for_publisher && in_state loop running; }
check "channels come back" eventually 40 both_back
kill "$PUSHER" 2> /dev/null
background scripts/push-rtmp.sh "rtmp://localhost:$PUSH_PORT/live/k1"
check "push: running with a new publisher" eventually 30 in_state push running
check "the VOD is not encoded again" in_state vod idle
check "on-demand recording stays off" test "$(channel push d.recordingEnabled)" = false

echo "== Webhooks"
check "every webhook correctly signed" eval "[[ -s '$TMP/events.log' ]] && ! grep -q BAD '$TMP/events.log'"
check "state changes delivered" grep -q '^channel.state push running' "$TMP/events.log"
check "both closed recordings delivered" test "$(grep -c '^recording.closed push' "$TMP/events.log")" -eq 2

echo "== $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  KEEP=1
  exit 1
fi
