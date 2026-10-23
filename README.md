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

For a full walkthrough of the internals, see [How it works](#how-it-works).

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

## How it works

### The big picture

Three programs cooperate, and **they only share files on disk**:

```
                 ┌─────────── Node app (:3000) ───────────┐
 curl / test ──▶ │ routes ─▶ manager ─▶ supervisor ───────┼──spawn──▶ ffmpeg (one per channel)
 page            └────────────────────────────────────────┘             ▲            │
                                                                        │            │ writes
 OBS / encoder ──── RTMP :1935 / SRT :9000 (push) ──────────────────────┘            ▼
 camera / URL  ◀─── ffmpeg pulls from it ────────────────────────────── var/hls/<id>/master.m3u8
 media/*.mp4   ◀─── ffmpeg reads it ─────────────────────────────────── var/hls/<id>/<rung>/index.m3u8
                                                                        var/hls/<id>/<rung>/seg_*.ts
                                                                                     │ reads
 hls.js / Safari ◀──────────── HTTP :8080 ──────────── nginx ◀───────────────────────┘
```

- **ffmpeg does all the media work.** It receives or reads the input, decodes it, encodes every rendition, cuts the
  output into segments and writes the playlists.
- **The Node app never touches video data.** It works out which ffmpeg command to run, starts it, watches its
  progress, and restarts it when it fails.
- **nginx is a plain static file server.** It serves the playlists and segments ffmpeg wrote, with the right headers.
- **The player** (hls.js or Safari) downloads those files over HTTP and plays them.

| File | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | Boot. Loads config and the default ladder, starts the channel manager, registers routes, listens on :3000, and shuts down gracefully on Ctrl+C. |
| [src/config.ts](src/config.ts) | Turns environment variables into a typed `Config` with defaults. |
| [src/api/routes.ts](src/api/routes.ts) | The HTTP endpoints. Validates request bodies and maps errors to status codes. |
| [src/channels/schema.ts](src/channels/schema.ts) | zod schemas that define what a valid channel looks like. |
| [src/channels/manager.ts](src/channels/manager.ts) | The registry of channels. Allocates ports, saves channels to disk, creates one supervisor per channel, and prepares each ffmpeg run. |
| [src/ffmpeg/buildArgs.ts](src/ffmpeg/buildArgs.ts) | A pure function that turns a channel spec into the ffmpeg argument list. |
| [src/ffmpeg/probe.ts](src/ffmpeg/probe.ts) | Runs ffprobe to learn a source's resolution, frame rate and codecs. |
| [src/ffmpeg/supervisor.ts](src/ffmpeg/supervisor.ts) | The lifecycle of one ffmpeg process: spawn, progress, watchdog, restarts. |
| [src/channels/output.ts](src/channels/output.ts) | Gets a channel's output folder ready before each run and cleans up leftovers. |
| [src/ffmpeg/pids.ts](src/ffmpeg/pids.ts) | Pid files, and killing ffmpeg processes orphaned by a crash. |
| [nginx/nginx.conf](nginx/nginx.conf), [nginx/cors.conf](nginx/cors.conf) | Serves `var/hls` with the correct MIME types, caching and CORS headers. |

### What happens when you create a channel

1. **Validation.** `POST /channels` parses the body with `ChannelSpecSchema`.
   - The `id` must be a lowercase slug. It is also the output folder name.
   - `input` must be one of `file`, `pull`, `rtmp` or `srt`, each with its own fields.
   - Defaults are filled in: `mode: live`, `segmentType: mpegts`, `passthrough: false`.
   - `vod` is only allowed for a file that doesn't loop.
   - An invalid body gets a `400` listing exactly which fields are wrong.
2. **Registration.** `ChannelManager.create`:
   - Rejects a duplicate id with `409`.
   - Gives RTMP and SRT channels the lowest free port in their range.
   - Saves the channel to `var/channels.json`.
   - Creates a `Supervisor` and starts it.
   - The API answers straight away with the state `starting`. Poll `GET /channels/:id` to follow progress.
3. **Preparation.** This happens before *every* ffmpeg start, including restarts, so it always reflects the source as
   it is now.
   - File inputs: the path is resolved against the repo root, and the file must exist.
   - File and pull inputs: ffprobe reads the source's width, height, frame rate and codecs.
   - `buildArgs` produces the ffmpeg command.
   - `prepareOutputDir` gets `var/hls/<id>/` ready (see [The output folder](#the-output-folder)).
   - If anything here fails (missing file, unreachable URL), it counts as a failed run, just like an ffmpeg crash.
4. **Spawn.** ffmpeg is started with an argument array, never through a shell, so stream keys and URLs can't be
   misread as shell syntax. ffmpeg's stdout carries machine-readable progress, and stderr carries its log.

### Inside the ffmpeg command

This is the command for a looping file played out as a live channel, abridged and annotated:

```
ffmpeg -hide_banner -nostdin -loglevel warning -nostats -progress pipe:1 -y
  -re -stream_loop -1 -i media/sample.mp4                          # 1. input
  -filter_complex "[0:v]split=4[s0][s1][s2][s3];
                   [s0]scale=-2:1080,format=yuv420p[v0];
                   [s1]scale=-2:720,format=yuv420p[v1]; …"         # 2. decode once, scale 4 ways
  -map [v0] -map 0:a:0 -map [v1] -map 0:a:0 …                      #    each rendition = 1 video + 1 audio
  -c:v libx264 -preset veryfast -profile:v high
  -force_key_frames "expr:gte(t,n_forced*4)"
  -g 120 -keyint_min 120 -sc_threshold 0                           # 3. a keyframe exactly every 4s
  -b:v:0 5000k -maxrate:v:0 5350k -bufsize:v:0 7500k …             # 4. bitrate per rendition
  -c:a aac -ar 48000 -ac 2 -b:a:0 128k …
  -f hls -hls_time 4 -hls_segment_type mpegts                      # 5. cut into 4s segments
  -hls_segment_filename var/hls/loop/%v/seg_<run>_%05d.ts       #    <run> is unique per ffmpeg run
  -master_pl_name master.m3u8
  -var_stream_map "v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p v:3,a:3,name:360p"
  -hls_list_size 6
  -hls_flags delete_segments+independent_segments+temp_file+program_date_time+append_list+omit_endlist
  var/hls/loop/%v/index.m3u8                                       # %v becomes the rendition name
```

**1. Input.** This is the only part that differs between input types:

| Input | ffmpeg arguments | Behaviour |
|---|---|---|
| file, live | `-re [-stream_loop -1] -i <path>` | `-re` reads at real-time speed, so a 60s file takes 60s, like a broadcast. `-stream_loop -1` repeats it forever. |
| file, vod | `-i <path>` | No `-re`: encodes as fast as the CPU allows. |
| pull | `[-re] -rw_timeout 10000000 -i <url>` (RTSP: `-rtsp_transport tcp -timeout …`) | ffmpeg connects out to the source. The timeout makes a dead source fail within 10s instead of hanging. `-re` is added when ffprobe reports a duration, meaning a finite source such as an HTTP file or a VOD playlist. Otherwise ffmpeg would read it hundreds of times faster than real time and race through the live window. |
| rtmp | `-listen 1 -i rtmp://0.0.0.0:<port>/live/<key>` | ffmpeg *becomes* an RTMP server and waits until a publisher such as OBS connects. |
| srt | `-i srt://0.0.0.0:<port>?mode=listener[&passphrase=…&pbkeylen=16]` | ffmpeg waits for an SRT caller. With a passphrase, the stream is AES-encrypted and callers without the passphrase are refused. |

**2. The ABR ladder.**
- **Decode once.** `split` copies the decoded picture N times, and each copy is `scale`d to its rung's height.
  - `-2` keeps the aspect ratio and rounds the width to an even number, which H.264 requires.
  - `format=yuv420p` is the pixel format every player supports.
- **Rungs taller than the source are dropped.** This is decided from the ffprobe result, so a 720p source yields only
  720p and below.
  - Push inputs can't be probed before a publisher connects, so they always get the full ladder.
  - If the source is smaller than every rung, there is one rendition at the source height.
  - If the source has no audio, the audio mappings are left out.

**3. Keyframe alignment.** This is the most important detail for ABR.
- **Why it matters.**
  - A player can only start decoding at a keyframe, so every segment must begin with one.
  - When hls.js switches from 1080p to 720p mid-stream, segment *N* of 720p must cover exactly the same moment as
    segment *N* of 1080p. Otherwise the picture jumps.
- **How the command enforces it.**
  - `-force_key_frames` puts a keyframe at 0s, 4s, 8s, … in every rendition.
  - `-g` caps the gap between keyframes: frame rate × 4 when the frame rate is known, otherwise 240 frames (which
    assumes at most 60 fps), so the cap never fires before the forced keyframe.
  - `-sc_threshold 0` turns off x264's extra keyframes on scene cuts. Those would land differently in each rendition.

**4. Bitrate.**
- `-b:v` is each rung's target.
- `-maxrate` (1.07× the target) and `-bufsize` (1.5×) cap the peaks.
- Together they keep the `BANDWIDTH` that the master playlist advertises honest, so players choose renditions they
  can actually sustain.

**5. HLS packaging.** The HLS muxer cuts each rendition at its keyframes into 4-second segments, then writes:
- a **variant playlist** for each rendition (`<rung>/index.m3u8`), listing its segments, and
- one **master playlist** listing the renditions. Players use it to choose:

```
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=5451248,AVERAGE-BANDWIDTH=5027195,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3094480,AVERAGE-BANDWIDTH=2906028,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
…
```

### Live playlists vs VOD playlists

**VOD** (`-hls_playlist_type vod -hls_list_size 0`):
- Every segment is listed.
- The playlist ends with `#EXT-X-ENDLIST`.
- The player knows the total duration and can seek anywhere.

**Live** playlists are a sliding window that ffmpeg rewrites after every segment:

```
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:9                         ← sequence number of the first segment listed
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:4.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-20T14:40:22.928-0600
seg_mvl0a1b2_00009.ts
#EXT-X-DISCONTINUITY                            ← publisher reconnected; timestamps restart here
#EXTINF:4.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-20T14:41:05.112-0600
seg_mvl0c3d4_00010.ts                           ← new run id; the numbering continues
…                                               (no #EXT-X-ENDLIST: the stream is still going)
```

The live flags, and what each one is for:

| Flag | Purpose |
|---|---|
| `-hls_list_size 6` | Only the newest 6 segments (24s) are listed. The player re-fetches the playlist about every target duration to discover new ones. |
| `delete_segments` | Deletes segment files once they fall out of the window, so disk use stays flat. |
| `temp_file` | Writes each playlist and segment as `.tmp`, then renames it. nginx never serves a half-written file. |
| `program_date_time` | Stamps each segment with wall-clock time. Players use it to stay in sync across discontinuities. |
| `independent_segments` | Promises that every segment starts with a keyframe (see keyframe alignment). |
| `omit_endlist` | Never writes `#EXT-X-ENDLIST`. When a publisher disconnects, players keep polling instead of deciding the stream is over, and pick up again on reconnect. |
| `append_list` | When ffmpeg restarts, it reads the existing playlist and continues the numbering (segment 10 follows segment 9), inserting `#EXT-X-DISCONTINUITY` so the player resets its timestamps. Without it, a restart would start again at segment 0 and confuse players that were watching. |

Two other modes:
- **Passthrough** (`-c copy`): no re-encoding. The source's own video and audio are repackaged as a single rendition
  named `source`. It costs almost no CPU, but there is no ABR, and segments break wherever the *source* put its
  keyframes. It needs H.264/HEVC video and AAC/MP3/AC-3 audio.
- **fMP4** (`segmentType: fmp4`): writes `.m4s` segments plus an `init_<n>.mp4` header per rendition instead of
  MPEG-TS.

### The supervisor: keeping ffmpeg alive

Each channel has one `Supervisor`, which runs this state machine:

```
 idle ─start─▶ starting ─┬─(rtmp/srt)──▶ waiting_for_publisher ──first output──▶ running
                         └─(file/pull)───────────────────────────first output──▶ running

 starting / waiting / running ──ffmpeg exits──▶ restarting ──after delay──▶ starting …
                                           ├──▶ completed   (VOD done, or a non-looping live file ended)
                                           └──▶ error       (VOD failed; it is never retried)

 any state ──stop──▶ stopping ──▶ stopped
```

**How it knows what ffmpeg is doing.**
- **Progress.** `-progress pipe:1` makes ffmpeg print a block of `key=value` lines about twice a second: `frame`,
  `fps`, `bitrate`, `out_time_us` and `speed`.
  - The first block in which `out_time` moves forward switches the state to `running`.
  - These values are what `GET /channels/:id` shows under `progress`. A `speed` of about `1.0x` means a live channel
    is keeping up.
- **Log.** The last 50 stderr lines are kept as `stderrTail`. When ffmpeg dies, the last line usually explains why,
  and it is included in `lastError`. Set `LOG_LEVEL=debug` to log every line.

**What happens when ffmpeg exits** depends on the channel's restart policy:

| Channel | Policy | ffmpeg exits cleanly (code 0) | ffmpeg fails |
|---|---|---|---|
| VOD | never | `completed` | `error` |
| Live file, no loop | on failure | `completed` (the file ended) | restart with backoff |
| RTMP / SRT | always | publisher left: re-arm the listener immediately | restart with backoff |
| Pull, looping file | always | restart with backoff | restart with backoff |

- **Backoff.**
  - Waits of 1s, 2s, 4s, 8s, … between attempts, capped at 30s, so a dead source isn't hammered.
  - The delay resets after a run lasting at least 60s.
  - A failure in the preparation step (for example, ffprobe can't reach a pull URL) counts too.
- **Listener re-arm.** A listener that exits cleanly within 1s is treated as a failure, so a broken setup can't spin
  in a tight loop.
- **Stall watchdog.**
  - Once a second, the supervisor checks whether `out_time` has moved.
  - If it hasn't moved for 15s while `starting` or `running`, ffmpeg gets SIGTERM, then SIGKILL 5s later, and the
    channel restarts with `lastError: stalled …`.
  - This catches a frozen pull source, or a publisher that stops sending but leaves the connection open.
  - A listener that is `waiting_for_publisher` is exempt, because waiting is normal for it.
- **Stream key enforcement.**
  - ffmpeg's RTMP listener accepts any publisher. It only logs `Unexpected stream X, expecting Y` when the key is
    wrong.
  - The supervisor watches stderr for that line and kills ffmpeg with SIGKILL. SIGKILL (rather than SIGTERM) stops
    ffmpeg from flushing the intruder's frames into the playlist.
  - The listener is re-armed 1s later.
- **Stopping.**
  - `stop` sends SIGTERM. ffmpeg finishes its current segment and writes final playlists. SIGKILL follows if it
    hasn't exited within 5s.
  - If a launch is still being prepared, `stop` waits for it first, so a delete can't race with an output folder
    being created.

### The output folder

```
var/hls/<id>/
├── master.m3u8          ← the URL you give a player
├── 1080p/
│   ├── index.m3u8       ← variant playlist
│   ├── seg_<run>_00009.ts
│   └── seg_<run>_00010.ts
├── 720p/ …
└── 360p/ …
```

Before each run, `prepareOutputDir` does one of two things:
- **VOD:** wipes the folder and starts fresh.
- **Live:** keeps the existing playlists, so `append_list` can continue them, but:
  - deletes rendition folders that are no longer in the ladder,
  - deletes leftover `.tmp` files, and
  - deletes segment files the playlist no longer references.

The last step is needed because `delete_segments` only cleans up within a single ffmpeg run, so restarts and crashes
leave stray segments behind.

### Persistence and crash recovery

**Saved channels.**
- `var/channels.json` holds every channel's spec, assigned port, desired state (`running` or `stopped`), and when a
  VOD encode completed.
- Writes are serialized and atomic: written to a `.tmp` file, then renamed, so a crash can't leave a half-written file.
- On startup:
  - Channels that should be running are started again.
  - Completed VOD encodes are not redone.
  - If the file is invalid, the app refuses to start rather than silently dropping channels.
- `POST /channels/:id/stop` sets the desired state to `stopped`. Ctrl+C does not change it, so channels come back on
  the next start.

**Orphaned ffmpeg processes.**
- If the Node app is killed hard (`kill -9`, a crash), its ffmpeg children keep running. A listener waiting for a
  publisher never notices its parent is gone, and keeps holding its port.
- So every ffmpeg's pid is written to `var/pids/<id>.pid`.
- On startup, each pid file is checked. If that process still exists *and* is ffmpeg (checked so that a reused pid
  belonging to something else is never killed), it is killed.

**Graceful shutdown.** On Ctrl+C or SIGTERM, the app:
1. stops accepting API requests,
2. stops every ffmpeg cleanly,
3. waits for pending file writes,
4. exits.

### Serving: nginx

`npm run nginx` runs `nginx -p "$PWD" -c nginx/nginx.conf`. The `-p` sets the repo root as nginx's prefix, so every
relative path in the config (logs, pid, `var/hls`) stays inside the repo, and Homebrew's own nginx config is never
touched.

| Location | What it does |
|---|---|
| `/hls/` | Serves files from `var/hls`. MIME types: `.m3u8` → `application/vnd.apple.mpegurl`, `.ts` → `video/mp2t`, `.m4s` and `.mp4` → `video/mp4`. |
| `*.m3u8`, `*.mp4` | `Cache-Control: no-cache`. Live playlists change every few seconds, and fMP4 init files (`init_<n>.mp4`) are rewritten under the same name on every run, so no cache may keep an old copy. |
| `*.ts`, `*.m4s` | `Cache-Control: max-age=86400`. A segment never changes once written. Its name carries a per-run id (`seg_<run>_<n>`), so a recreated channel or a rebuilt VOD never reuses a URL a player has already cached. |
| `/` | The test player (`nginx/html/index.html`). |
| `/api/` | Proxies to the Node API on :3000, so the test page can call it from the same origin. **Localhost only:** HLS is served to the whole network so other devices can play it, but the API can encode any file on disk and pull any URL. |

**CORS.**
- The hls.js demo runs at `https://hls-js.netlify.app`, a different origin from `http://localhost:8080`. Browsers
  only let its JavaScript read our files if each response carries `Access-Control-Allow-Origin`.
- Preflight `OPTIONS` requests get a `204`.
- `Access-Control-Allow-Private-Network: true` answers Chrome's extra check before a public website may call
  localhost.
- All of this lives in `nginx/cors.conf`, which is included in every HLS location. In nginx, `add_header` in a nested
  location *replaces* the parent's headers rather than adding to them.

### What the player does

1. Fetches `master.m3u8` and reads the renditions' `BANDWIDTH`, `RESOLUTION` and `CODECS`.
2. Picks a starting rendition from its bandwidth estimate and the player size, then fetches that rendition's
   `index.m3u8`.
3. Downloads segments in order and feeds them to the browser's video decoder. hls.js uses Media Source Extensions;
   Safari plays HLS natively.
4. **Live only:** re-fetches the variant playlist about every target duration (4s) to find new segments. It starts
   about 3 segments behind the newest one, so expect roughly 12-20s of latency with 4s segments. Set
   `SEGMENT_SECONDS=2` for lower latency, at the cost of more requests. Low-Latency HLS is not implemented.
5. Measures how fast each segment downloaded and switches rendition at the next segment boundary. This works without
   a glitch only because keyframes are aligned across renditions.
6. On `#EXT-X-DISCONTINUITY`, resets its timestamp mapping and carries on, which is how a reconnecting publisher
   resumes without the player failing.

## Development

```sh
npm test            # node --test, no framework
npm run typecheck   # tsc --noEmit (Node 24 runs the .ts files directly)
```

See [CLAUDE.md](CLAUDE.md) for the conventions and the ffmpeg/HLS behaviour that the code relies on.
