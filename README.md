# livestream-encoder

Turns live streams or already-encoded files into adaptive-bitrate HLS (`master.m3u8` + variant playlists) using
ffmpeg. nginx serves the output so any HLS player, such as the hls.js demo, can play it.

- **Inputs:** media files (as VOD, or played out as a live channel, optionally looping), pulled URLs
  (RTSP, RTMP, HLS, HTTP, SRT), RTMP push (OBS, hardware encoders) and SRT push.
- **Output:** a 1080p/720p/480p/360p/240p H.264/AAC ladder by default ([config/ladder.json](config/ladder.json)). Rungs
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
npm run sample                  # writes media/sample.mp4 (npm run test-media writes more, see Testing)
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

# Pull an existing stream (reconnects whenever the source drops or ends)
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"cam","input":{"type":"pull","url":"rtsp://camera.local/stream"}}'

# Play an HTTP file or VOD playlist once, live; the channel completes when it ends
curl -XPOST localhost:3000/channels -H 'content-type: application/json' \
  -d '{"id":"once","input":{"type":"pull","url":"https://example.com/clip.mp4","loop":false}}'
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
| `debugOverlay` | `true` prints each rendition's name in its picture, for watching ABR switches. Not with passthrough. | `false` |
| `ladder` | per-channel list of rungs: `[{name, height, videoBitrateKbps, audioBitrateKbps, maxFps?}]`. `height` is the short side, so it is the width for portrait sources. | `config/ladder.json` |
| `input.latencyMs` (srt) | How long SRT waits for lost packets to be resent. The connection uses the larger of this and the publisher's setting, so publishers needn't change theirs. libsrt's 120ms default suits a LAN; over the internet allow several round trips. It adds to latency, but HLS already adds 10s or more. | `1000` |
| `input.audio` (rtmp, srt) | `false` for a video-only encoder. Push sources can't be probed before a publisher connects, so this decides whether the renditions carry audio. A publisher that sends no audio to a channel expecting it is disconnected, and `lastError` says to set this. | `true` |

Channels persist in `var/channels.json` and restart when the API starts. Completed VOD encodes are not redone.

Each push channel gets its own port. RTMP ports run from 1935 to 1944 and SRT ports from 9000 to 9009 (set them
with `RTMP_PORTS` / `SRT_PORTS`). The status output shows the exact ingest URL. A publisher with the wrong RTMP
stream key is disconnected. Treat the key as a guard against mistakes, not as authentication.

## Testing

### Players

- **Test player** (http://localhost:8080) lists the channels and plays one with hls.js.
  - It shows the rendition and picture size, how much is buffered, how far behind the live edge playback is, the
    bandwidth estimate, and dropped frames.
  - The event log records rendition switches, discontinuities crossed, stalls and errors.
  - **Native HLS** plays through the browser's own player instead. Only Safari has one. hls.js runs in Safari too,
    so without this box native playback is never tested.
  - `?channel=<id>` opens a channel straight away: http://localhost:8080/?channel=obs.
- **hls.js demo:** `https://hls-js.netlify.app/demo/?src=http://localhost:8080/hls/<id>/master.m3u8` (the test player
  links to it). nginx sends the CORS and private-network headers it needs. If Chrome still blocks the request,
  accept its local-network access prompt.
- **Other players** handle discontinuities and errors differently from hls.js, so they find different bugs:
  - [Shaka Player demo](https://shaka-player-demo.appspot.com) (custom content), [Video.js](https://videojs.com/advanced/).
  - `ffplay http://localhost:8080/hls/<id>/master.m3u8` (comes with ffmpeg-full), VLC, mpv.
- **iPhone or iPad** on the same Wi-Fi: start the API with
  `PUBLIC_HLS_BASE_URL=http://<your-mac>.local:8080/hls`, then open the playback URL in Safari. The API itself stays
  local-only.
- **Apple's validator:** `mediastreamvalidator` and `hlsreport`, from Apple's HTTP Live Streaming Tools
  (developer.apple.com, free account), check a stream against the HLS spec and Apple's authoring rules.

### Checking a stream

```sh
npm run check:hls -- http://localhost:8080/hls/<id>/master.m3u8   # or a path: var/hls/<id>/master.m3u8
```

It checks the invariants ABR playback depends on, and exits 1 on a problem, so it can run in scripts:
- Segment *N* starts on a keyframe at the same timestamp in every rendition. It compares the newest 3 segments all
  renditions share; pass a number to compare more.
- Discontinuities line up across renditions.
- No segment is longer than `EXT-X-TARGETDURATION`.
- Live playlists carry `EXT-X-DISCONTINUITY-SEQUENCE`, and all renditions agree on it.

### Test sources

`npm run test-media` writes short labelled clips to `media/test/`, one per path through the encoder. Use any of them
as a VOD (`"mode": "vod"`) or a looping live channel (`"loop": true`). `DURATION=60 npm run test-media -- 1080p60`
makes a single, longer one.

| Clip | What to expect |
|---|---|
| `720p30.mp4` | 720p and below; the 1080p rung is dropped |
| `240p.mp4` | a single 240p rendition |
| `no-audio.mp4` | no audio codec in the master playlist's `CODECS` |
| `1080p60.mp4` | 60 fps on 1080p and 720p at 1.5× bitrate, 30 fps on 480p, 360p and 240p (`maxFps`) |
| `1080i.mp4` | 1080i29.97: progressive output at 29.97 fps, no combing on moving edges |
| `portrait.mp4` | 1080×1920, 720×1280, … |
| `phone-rotated.mp4` | stored 1920×1080 with a rotate-90° flag, like most phone video: the same portrait output |
| `hevc.mp4` | for `"passthrough": true, "segmentType": "fmp4"`: H.265 copied into the segments, with `CODECS="hvc1.…"` in the master playlist |
| `hdr-hlg.mp4` | 10-bit HEVC HLG, as phones record: tone mapped to SDR BT.709, colors as in the other clips, not washed out |
| `surround.mp4` | 5.1 audio, downmixed to stereo |
| `audio-gap.ts` | audio missing from 5s to 8s: silence there, and the audio stays in sync afterwards |

Live sources besides OBS:
- **Test pattern push:** `npm run push:rtmp` and `npm run push:srt` burn in a wall clock. Hold a phone stopwatch, or
  just the Mac's clock, next to the player to read end-to-end latency. Pass a file as the second argument to push it
  instead of the test pattern.
- **Rendition labels:** create a channel with `"debugOverlay": true` to print each rendition's name in its picture
  (top right), so you can watch ABR switches happen.
- **OBS over SRT:** Settings → Stream → Service: Custom, Server: `srt://localhost:9000?mode=caller` (add
  `&passphrase=…&pbkeylen=16` for an encrypted channel).
- **UDP MPEG-TS,** like a broadcast contribution feed:
  ```sh
  ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
    -c:v libx264 -preset veryfast -tune zerolatency -g 60 -pix_fmt yuv420p -c:a aac \
    -f mpegts 'udp://127.0.0.1:5000?pkt_size=1316'
  # then: {"id":"udp","input":{"type":"pull","url":"udp://127.0.0.1:5000"}}
  ```
- **RTSP or RTMP pull without a camera:** `brew install mediamtx`, run `mediamtx`, push a test pattern into it
  (`npm run push:rtmp -- rtmp://localhost:1935/test` after moving this app's RTMP ports with `RTMP_PORTS`), then
  pull `rtsp://localhost:8554/test` or `rtmp://localhost:1935/test`.
- **HLS pull:** pull another channel's output, e.g. `http://localhost:8080/hls/loop/master.m3u8`. A VOD playlist or
  an HTTP file is read in real time (`-re` is added because ffprobe reports a duration). By default it starts over
  when it ends; with `"loop": false` the channel completes instead. `loop: false` is refused (`lastError`) for a
  source with no duration, which would otherwise end for good at its first dropout. The HTTP server must support
  Range requests (nginx does; `python3 -m http.server` doesn't): without them ffprobe finds no duration, and an MP4
  fails to open.
- **HTTP(S) pulls resume after a dropped connection** (`-reconnect`): ffmpeg asks for the rest of a file from where
  it broke off, or reopens a stream or playlist, instead of failing. Without it, a pull of a file with `loop: false`
  reported `completed` partway through, since ffmpeg took the dropped connection for the end of the file.

### Things to break

| Do this | Expect |
|---|---|
| Stop the push (Ctrl+C) and start it again | `waiting_for_publisher`, then `running`; players continue after one discontinuity |
| Push with the wrong RTMP stream key | `lastError: rejected publisher with wrong stream key` |
| Push SRT without the channel's passphrase | the connection is refused; the channel keeps waiting |
| Push video only to a channel without `"audio": false` | `lastError` says to set `"audio": false` |
| `kill -STOP <pid of the pushing ffmpeg>` for 20s, then `kill -CONT` | `stalled: no output progress for 15s` and a restart |
| Start a live channel from `media/test/1080p60.mp4` with `X264_PRESET=placebo` | after 30s, `warnings: ["falling behind: output at 0.33x real time …"]` while the state stays `running` |
| Push to a `"passthrough": true` channel with a keyframe every 250 frames (`-g 250`, like OBS's "auto") | `warnings: ["segments are up to 8.3s long instead of 4s …"]`, gone once the publisher leaves |
| `kill -9` the API, then start it again | the old ffmpeg is killed (`killed stale ffmpeg`) and channels come back |
| Throttle the network in Chrome DevTools, or Safari/iOS with Network Link Conditioner | lower renditions in the event log, no stalls once it settles |
| Create one more RTMP channel than `RTMP_PORTS` allows | `409 no free rtmp ports` |
| Leave a looping channel running for hours | flat memory and `du -sh var/hls/<id>`, `restarts: 0` |

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
- **For live channels, the Node app republishes ffmpeg's playlists.** ffmpeg's own live playlists are wrong after a
  restart, so it writes private copies, and the app rewrites them into the ones players fetch (see
  [Publishing live playlists](#publishing-live-playlists)).
- **nginx is a plain static file server.** It serves the playlists and segments, with the right headers.
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
| [src/hls/playlist.ts](src/hls/playlist.ts) | Pure functions that turn ffmpeg's live playlists into the ones players fetch. |
| [src/hls/publisher.ts](src/hls/publisher.ts) | Keeps a live channel's published playlists in step with ffmpeg's while it runs. |
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
  -filter_complex "[0:v]bwdif=…:deint=interlaced,split=4[s0][s1][s2][s3];
                   [s0]scale=-2:1080,format=yuv420p[v0]; …
                   [s3]fps=fps=source_fps/ceil(source_fps/30),
                       scale=-2:360,format=yuv420p[v3];
                   [0:a]aresample=async=1:first_pts=0,
                       asplit=4[a0][a1][a2][a3]"                   # 2. decode once, scale 4 ways
  -map [v0] -map [a0] -map [v1] -map [a1] …                        #    each rendition = 1 video + 1 audio
  -c:v libx264 -preset veryfast -profile:v high
  -force_key_frames "expr:gte(t,n_forced*4)"
  -g:v:0 120 -keyint_min:v:0 120 … -sc_threshold 0                 # 3. a keyframe exactly every 4s
  -b:v:0 5000k -maxrate:v:0 5350k -bufsize:v:0 7500k …             # 4. bitrate per rendition
  -c:a aac -ar 48000 -ac 2 -b:a:0 128k …
  -f hls -hls_time 4 -hls_segment_type mpegts                      # 5. cut into 4s segments
  -hls_segment_filename var/hls/loop/%v/seg_<run>_%05d.ts       #    <run> is unique per ffmpeg run
  -master_pl_name ffmpeg-master.m3u8
  -var_stream_map "v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p v:3,a:3,name:360p"
  -hls_list_size 6
  -hls_flags delete_segments+independent_segments+temp_file+program_date_time+append_list+omit_endlist
  var/hls/loop/%v/ffmpeg.m3u8                                      # %v becomes the rendition name; the app
                                                                   #   publishes these as master.m3u8/index.m3u8
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
- **Deinterlace.** `bwdif` turns interlaced video (1080i from broadcast cameras and hardware SRT encoders) into
  progressive frames at the same frame rate. With `deint=interlaced` it only touches frames flagged as interlaced.
  Progressive frames pass through bit-identical, so it runs on every source, including push sources nobody could
  probe.
- **Decode once.** `split` copies the decoded picture N times, and each copy is `scale`d to its rung's size.
  - A rung's `height` is the picture's **short side**. Landscape is scaled to that height (`scale=-2:720`), and
    portrait to that width (`scale=720:-2`, giving 720×1280).
  - `-2` keeps the aspect ratio and rounds the other side to an even number, which H.264 requires.
  - `format=yuv420p` is the pixel format every player supports.
- **Portrait and rotated video.** Phones often store video landscape with a "rotate 90°" flag, and ffmpeg turns the
  frames while decoding. The probe applies the flag too, so a phone clip counts as 1080×1920 portrait.
- **Frame-rate cap.** A rung with `maxFps` divides the source frame rate by the smallest whole number that brings
  it under the cap: 60 → 30, 59.94 → 29.97, 50 → 25, and 29.97 stays as it is. Even cadence means no judder. The
  default ladder caps 480p, 360p and 240p at 30. At those bitrates, 60 fps mostly spends bits on frames nobody sees.
- **Audio gaps.** `aresample=async=1` fills gaps in the audio timestamps with silence, so audio can't drift ahead of
  video. Gaps come from packets dropped by OBS or the network, and from every loop point of a looping file. It runs
  once, and `asplit` feeds each rendition. With one `aresample` per rendition (`-af`), ffmpeg 9 froze at the first gap
  of a real-time input.
- **Rungs bigger than the source are dropped.** This is decided from the ffprobe result, so a 720p source yields only
  720p and below.
  - Push inputs can't be probed before a publisher connects, so they always get the full ladder.
  - If the source is smaller than every rung, there is one rendition at the source height.
  - If the source has no audio (or a push channel was created with `"audio": false`), the audio mappings are left out.

**3. Keyframe alignment.** This is the most important detail for ABR.
- **Why it matters.**
  - A player can only start decoding at a keyframe, so every segment must begin with one.
  - When hls.js switches from 1080p to 720p mid-stream, segment *N* of 720p must cover exactly the same moment as
    segment *N* of 1080p. Otherwise the picture jumps.
- **How the command enforces it.**
  - `-force_key_frames` puts a keyframe at 0s, 4s, 8s, … in every rendition.
  - `-g` caps the gap between keyframes: the rung's frame rate × 4 when the frame rate is known, otherwise 240 frames
    (which assumes at most 60 fps), so the cap never fires before the forced keyframe. It is set per rung
    (`-g:v:<n>`), because a capped rung has fewer frames per segment. The forced keyframes are time-based, so capped
    and uncapped rungs still cut at the same instants.
  - `-sc_threshold 0` turns off x264's extra keyframes on scene cuts. Those would land differently in each rendition.

**4. Bitrate.**
- `-b:v` is each rung's target. A rung that keeps a probed source above 30 fps gets 1.5× its `videoBitrateKbps`
  (1080p60: 7.5 Mbps). Push sources' frame rate isn't known when ffmpeg starts, so they get the base rate.
  - With the higher rates, 720p60 advertises about 4.6 Mbps, above the 3.5 Mbps start limit, so players start a 60 fps
    channel on 480p and step up from there.
- `-maxrate` (1.07× the target) and `-bufsize` (1.5×) cap the peaks.
- Together they keep the `BANDWIDTH` that the master playlist advertises honest, so players choose renditions they
  can actually sustain.

**5. HLS packaging.** The HLS muxer cuts each rendition at its keyframes into 4-second segments, then writes:
- a **variant playlist** for each rendition (`<rung>/index.m3u8`), listing its segments, and
- one **master playlist** listing the renditions. Players use it to choose:

```
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=3144112,AVERAGE-BANDWIDTH=3074677,RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2",FRAME-RATE=60.000
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5269264,AVERAGE-BANDWIDTH=5220133,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2",FRAME-RATE=60.000
1080p/index.m3u8
…
```

The app finishes ffmpeg's master playlist (live ones when they are published, VOD ones when the encode completes):
- **`FRAME-RATE`**, which Apple's HLS authoring spec requires for video and ffmpeg never writes. It is read from
  each rendition's first segment, so capped rungs report their own rate and push sources are covered too.
- **The start rendition is listed first.** Safari starts on the first rendition listed, before it has measured
  anything, and ffmpeg lists the top rung first, so every viewer began at 5 Mbps. The first listed is now the
  highest whose `BANDWIDTH` is at most 3.5 Mbps (720p with the default ladder), or the lowest if none is; the rest
  keep their order.

### Live playlists vs VOD playlists

**VOD** (`-hls_playlist_type vod -hls_list_size 0`):
- Every segment is listed.
- The playlist ends with `#EXT-X-ENDLIST`.
- The player knows the total duration and can seek anywhere.
- ffmpeg writes VOD variant playlists only when it finishes, so the encode goes into a hidden `.building-<id>`
  directory and replaces the served one when it completes. Re-encoding a VOD (`POST /channels/:id/start`) keeps the
  previous version playable until the new one is ready, and a failed encode never replaces it. A viewer still
  watching the previous version when the swap happens gets 404s for its remaining segments.

**Live** playlists are a sliding window, rewritten after every segment. This is the published `index.m3u8`:

```
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA-SEQUENCE:9                         ← sequence number of the first segment listed
#EXT-X-DISCONTINUITY-SEQUENCE:3                 ← discontinuities that have already left the window
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
  - **HEVC needs `"segmentType": "fmp4"`.** Safari and hls.js only play HEVC from fMP4, so a probed HEVC source with
    MPEG-TS is refused. It is written with the `hvc1` sample entry Apple requires (`-tag:v hvc1`). ffmpeg would
    otherwise write `hev1` when copying from MPEG-TS or a push source.
  - **`CODECS`.** ffmpeg leaves the whole `CODECS` attribute out for HEVC from an MP4 source. The app then reads the
    first segment and adds it, e.g. `hvc1.1.6.L120.90,mp4a.40.2`. Live master playlists get it when they are published,
    VOD ones when the encode completes. Nothing is added when a codec isn't recognised.
  - **fMP4 from MPEG-TS, SRT or RTMP** gets `-bsf:a aac_adtstoasc`. Their AAC is ADTS, which fMP4 can't carry, and
    ffmpeg's HLS muxer doesn't add the filter itself.
  - **Segment length follows the source's keyframes.** With OBS's "Keyframe Interval: 0 (auto)" they are about 8s
    apart, so segments are too, and latency roughly doubles. While a live channel runs, segments longer than 1.25×
    `SEGMENT_SECONDS` add an entry to `warnings` (logged once per run) saying what to change: set the publisher's
    keyframe interval to `SEGMENT_SECONDS` or a divisor of it.
  - **Push sources** carry no bitrate when copied, so the top rung's bitrate is declared as the `BANDWIDTH` estimate.
    Without it, ffmpeg advertised 79 kbps for a 2.6 Mbps stream.
  - **HEVC from a push publisher** keeps `hev1`: its codec isn't known until it connects, and the tag can't be forced
    without breaking H.264 publishers. hls.js in Chrome plays it; Safari won't.
- **fMP4** (`segmentType: fmp4`): writes `.m4s` segments instead of MPEG-TS, plus an init section (the header every
  segment needs) per rendition and run: `init_<run>_<rung>.mp4`, or `init_<run>.mp4` for a single rendition.

### Publishing live playlists

ffmpeg's own live playlists go wrong once a channel restarts, which happens every time a publisher reconnects
(checked with ffmpeg 9):
- **No `#EXT-X-DISCONTINUITY-SEQUENCE`.** After a restart, `append_list` inserts `#EXT-X-DISCONTINUITY`, but when that
  tag slides out of the window nothing records it. The HLS spec requires that count, and players use it to line up
  renditions and timestamps.
- **One init section for every segment (fMP4).** ffmpeg writes a single `#EXT-X-MAP` for its own run, so segments
  from the previous run that are still in the window get the new run's init section. If the source changed between
  runs (a different publisher, resolution or frame rate), those segments won't decode.

So for live channels ffmpeg writes `ffmpeg-master.m3u8` and `<rung>/ffmpeg.m3u8`, and a `PlaylistPublisher` rewrites
them every 250 ms into the `master.m3u8` and `<rung>/index.m3u8` that players fetch:
- Run boundaries come from the segment names (`seg_<run>_<n>`). A segment from a new run gets
  `#EXT-X-DISCONTINUITY`, plus its own run's `#EXT-X-MAP` for fMP4.
- The previously published playlist provides the rest of the history: each earlier run's init section, and how many
  discontinuities have already left the window.
- It writes atomically (`.tmp`, then rename) and only when ffmpeg's file changed. It publishes once more after
  ffmpeg exits, so the final segments are announced.

nginx returns 404 for `ffmpeg*.m3u8`. VOD output is a single run, so ffmpeg writes `master.m3u8` and `index.m3u8`
directly.

### The supervisor: keeping ffmpeg alive

Each channel has one `Supervisor`, which runs this state machine:

```
 idle ─start─▶ starting ─┬─(rtmp/srt)──▶ waiting_for_publisher ──first output──▶ running
                         └─(file/pull)───────────────────────────first output──▶ running

 starting / waiting / running ──ffmpeg exits──▶ restarting ──after delay──▶ starting …
                                           ├──▶ completed   (VOD done, or a live file or pull with loop: false ended)
                                           └──▶ error       (VOD failed; it is never retried)

 any state ──stop──▶ stopping ──▶ stopped
```

**How it knows what ffmpeg is doing.**
- **Progress.** `-progress pipe:1` makes ffmpeg print a block of `key=value` lines about twice a second: `frame`,
  `fps`, `bitrate`, `out_time_us` and `speed`.
  - The first block in which `out_time` moves forward switches the state to `running`.
  - These values are what `GET /channels/:id` shows under `progress`. ffmpeg's `speed` is an average since it
    started, so it hides a recent slowdown.
- **Keeping up.** On live channels, `realtimeFactor` is how many seconds of output were produced per second over the
  last 30s (`null` until a run has 30s of history). A healthy channel reads 0.997–1.005.
  - Below 0.97, `warnings` says the channel is falling behind, and it is logged once. The channel keeps running, but
    segments arrive late: players rebuffer and latency grows.
  - Causes: the ladder is too heavy for the CPU (try `VIDEO_ENCODER=h264_videotoolbox`, a faster `X264_PRESET` or
    fewer rungs), or a push or pull source is delivering slower than real time.
  - The warning clears once the factor is back to 0.99, and on every restart.
- **Log.** The last 50 stderr lines are kept as `stderrTail`. When ffmpeg dies, the last line usually explains why,
  and it is included in `lastError`. Set `LOG_LEVEL=debug` to log every line.

**What happens when ffmpeg exits** depends on the channel's restart policy:

| Channel | Policy | ffmpeg exits cleanly (code 0) | ffmpeg fails |
|---|---|---|---|
| VOD | never | `completed` | `error` |
| Live file, or pull with `loop: false` | on failure | `completed` (the input ended) | restart with backoff |
| RTMP / SRT | always | publisher left: re-arm the listener immediately | restart with backoff |
| Pull (default), looping file | always | restart with backoff | restart with backoff |

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
├── ffmpeg-master.m3u8   ← live only: ffmpeg's copy, published as master.m3u8
├── 1080p/
│   ├── index.m3u8       ← variant playlist
│   ├── ffmpeg.m3u8      ← live only: ffmpeg's copy, published as index.m3u8
│   ├── init_<run>_1080p.mp4  ← fMP4 only
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
  - deletes segments and init sections that neither `ffmpeg.m3u8` nor the published `index.m3u8` references.

The last step is needed because `delete_segments` only cleans up within a single ffmpeg run, so restarts and crashes
leave stray segments behind. Both playlists count because only the published one still lists earlier runs' init
sections. Output from before live playlists were published only has an `index.m3u8`, written by ffmpeg. It is copied
to `ffmpeg.m3u8` once, so numbering carries on instead of restarting at 0.

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
| `ffmpeg*.m3u8` | `404`. These are ffmpeg's private live playlists. Players get the published copies. |
| `*.m3u8` | `Cache-Control: no-cache`. Live playlists change every few seconds, so no cache may keep an old copy. |
| `*.ts`, `*.m4s`, `*.mp4` | `Cache-Control: max-age=86400`. Segments and init sections never change once written. Their names carry a per-run id (`seg_<run>_<n>`, `init_<run>_<rung>.mp4`), so a restart, a recreated channel or a rebuilt VOD never reuses a URL a player has already cached. |
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

1. Fetches `master.m3u8` and reads the renditions' `BANDWIDTH`, `RESOLUTION`, `CODECS` and `FRAME-RATE`.
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
