# livestream-encoder

Turns live streams or already-encoded files into adaptive-bitrate HLS (`master.m3u8` + variant playlists) using
ffmpeg. nginx serves the output so any HLS player, such as the hls.js demo, can play it.

- **Inputs:** media files (as VOD, or played out as a live channel, optionally looping), pulled URLs
  (RTSP, RTMP, HLS, HTTP, SRT), RTMP push (OBS, hardware encoders) and SRT push.
- **Output:** a 1080p/720p/480p/360p H.264/AAC ladder by default ([config/ladder.json](config/ladder.json)). Rungs
  taller than the source are dropped. Segments are MPEG-TS or fMP4. There is also a passthrough mode for sources that
  are already H.264/AAC.
- One supervised ffmpeg process per channel, which restarts with backoff, kills stalled runs, re-arms listeners when
  a publisher leaves, and cleans up orphaned ffmpeg processes after a crash.

## Setup (macOS)

```sh
nvm use                         # Node 24 (.nvmrc)
brew install ffmpeg-full nginx  # ffmpeg-full includes SRT; the plain ffmpeg formula does not
npm install
npm run sample                  # writes media/sample.mp4
```

Then run these in two terminals:

```sh
npm run nginx   # http://localhost:8080  (test player at /, HLS at /hls/, API proxied at /api/)
npm run dev     # API on http://localhost:3000
```

## Channels

```sh
# VOD: encode a file once
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"bbb","input":{"type":"file","path":"media/sample.mp4"},"mode":"vod"}'

# Live playout of a file, looping forever
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"loop","input":{"type":"file","path":"media/sample.mp4","loop":true}}'

# RTMP push (OBS: Server rtmp://localhost:1935/live, Stream key secret123)
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"obs","input":{"type":"rtmp","streamKey":"secret123"}}'
npm run push:rtmp -- rtmp://localhost:1935/live/secret123     # or push a test pattern instead of OBS

# SRT push, optionally encrypted (passphrase: 10-79 characters)
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"srt1","input":{"type":"srt","passphrase":"correct-horse-battery"}}'
npm run push:srt -- 'srt://localhost:9000?mode=caller&passphrase=correct-horse-battery&pbkeylen=16'

# Pull an existing stream
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"cam","input":{"type":"pull","url":"rtsp://camera.local/stream"}}'
```

Playback URL: `http://localhost:8080/hls/<id>/master.m3u8`.

| Endpoint | |
|---|---|
| `POST /channels` | Create and start a channel |
| `GET /channels`, `GET /channels/:id` | State, progress (fps, speed, bitrate), restarts, last error, last 50 ffmpeg log lines, ingest and playback URLs |
| `POST /channels/:id/start`, `POST /channels/:id/stop` | Start or stop a channel |
| `DELETE /channels/:id` | Stop the channel and delete its output |

Channel options:

| Option | Values | Default |
|---|---|---|
| `mode` | `live` or `vod` | `live` |
| `segmentType` | `mpegts` or `fmp4` | `mpegts` |
| `passthrough` | `true` copies the streams without re-encoding (single rendition) | `false` |
| `ladder` | per-channel list of rungs: `[{name, height, videoBitrateKbps, audioBitrateKbps}]` | `config/ladder.json` |

Channels persist in `var/channels.json` and restart when the API starts. Completed VOD encodes are not redone.

Each push channel gets its own port. RTMP ports run from 1935 to 1944 and SRT ports from 9000 to 9009 (set them
with `RTMP_PORTS` / `SRT_PORTS`). The status output shows the exact ingest URL. A publisher with the wrong RTMP
stream key is disconnected. Treat the key as a guard against mistakes, not as authentication.

## Testing with the hls.js demo

Open `https://hls-js.netlify.app/demo/?src=http://localhost:8080/hls/<id>/master.m3u8`, or use the test player at
http://localhost:8080. nginx sends the CORS and private-network headers the demo needs. If Chrome still blocks the
request, accept its local-network access prompt. Alternatively, run the demo locally:
`git clone https://github.com/video-dev/hls.js && cd hls.js && npm install && npm run dev`.

## Configuration (environment variables)

| Variable | Default |
|---|---|
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3000` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` / `.../ffprobe` |
| `VIDEO_ENCODER` | `libx264` (`h264_videotoolbox` uses the Mac's hardware encoder) |
| `X264_PRESET` | `veryfast` |
| `SEGMENT_SECONDS` / `LIVE_LIST_SIZE` | `4` / `6` |
| `RTMP_PORTS` / `SRT_PORTS` | `1935-1944` / `9000-9009` |
| `PUBLIC_HLS_BASE_URL` | `http://localhost:8080/hls` |
| `INGEST_HOST` | `localhost` (the hostname shown in ingest URLs) |
| `VAR_DIR` / `HLS_ROOT` | `var` / `var/hls` |
| `LOG_LEVEL` | `info` (`debug` also logs every ffmpeg stderr line) |

## Development

```sh
npm test            # node --test, no framework
npm run typecheck   # tsc --noEmit (Node 24 runs the .ts files directly)
```

See [CLAUDE.md](CLAUDE.md) for the conventions and the ffmpeg/HLS behaviour that the code relies on.
