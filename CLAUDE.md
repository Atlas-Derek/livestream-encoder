# CLAUDE.md — livestream-encoder

Guidance for AI tools (and humans) working in this repo. A Node 24 / TypeScript service supervises one ffmpeg
process per channel, turning file, pull (RTSP/RTMP/HLS/HTTP), RTMP-push and SRT-push input into adaptive-bitrate
HLS under `var/hls/<channel>/`, which nginx serves on :8080. Everything runs natively on macOS (no Docker).

## Commands

- `npm run nginx` — nginx in the foreground with the repo-local config (`nginx/nginx.conf`, prefix = repo root).
- `npm run dev` — API on :3000 with `--watch`. `npm start` without watch.
- `npm test` — `node --test` over `src/**/*.test.ts`. `npm run typecheck` — `tsc --noEmit`.
- `npm run sample` — writes `media/sample.mp4` (1080p30 test pattern + tone). `npm run push:rtmp` / `npm run push:srt` —
  push a live test pattern (with a burned-in wall clock) like OBS would.
- `npm run test-media` — labelled clips in `media/test/`, one per encoder path (portrait, rotated, 1080i, 60 fps,
  no audio, HEVC, 5.1, audio gap). `npm run check:hls -- <master URL or path>` — checks keyframe alignment,
  discontinuities and playlist rules; exits 1 on a problem. Use both to verify encoder changes against real ffmpeg.

## Conventions

- Strict TypeScript. `any` is forbidden; use `unknown` and narrow.
- `async/await`, no `.then()` chains.
- No silent failures: an ffmpeg/ffprobe failure ends up in the channel's `state`/`lastError` (visible via
  `GET /channels/:id`) **and** in the logs. Domain errors throw `AppError` (src/errors.ts) with an HTTP status.
- Runtime is Node 24 type stripping — no tsx, no build. Use only erasable TS syntax (no enums, namespaces or
  parameter properties), relative imports with explicit `.ts` extensions, and `import type` for type-only imports.
- Tests live next to the code as `*.test.ts`. Prefer dependency injection over mocking globals: `Supervisor` takes a
  `spawn`, `ChannelManager` takes `spawn`, `probe` and `killStale`. Shared fakes are in `src/testing/fakes.ts`.
  Supervisor tests drive time with `mock.timers`; manager tests use real timers and `waitFor`.

## ffmpeg

- Every ffmpeg argument comes from the pure `buildArgs` (src/ffmpeg/buildArgs.ts), which is covered by tests. Never
  build shell strings — spawn with argument arrays.
- ffmpeg/ffprobe paths come from config (`FFMPEG_PATH`/`FFPROBE_PATH`). The default is Homebrew's `ffmpeg-full`,
  which is keg-only (`/opt/homebrew/opt/ffmpeg-full/bin`). The plain `ffmpeg` formula has no SRT support.
- Verify ffmpeg behaviour empirically (run it) before relying on flag documentation; several assumptions here were
  wrong until tested. Known facts:
  - The RTMP listener (`-listen 1`) only *warns* on a wrong stream key and accepts the publish, so the
    supervisor kills on that stderr line (`rejectWrongStreamKey`).
  - A listener exits 0 when the publisher disconnects; the supervisor re-arms it.
  - A custom `-hls_fmp4_init_filename` must contain `%v` when there are several variants (it expands to the variant
    name). With a single variant, `%v` is left as a literal `%v`, so it is only added for several.
  - `bwdif=…:deint=interlaced` leaves progressive frames bit-identical, so it runs on every source.
  - ffprobe reports a rotated phone clip's stored size (1920x1080 + rotation 90); ffmpeg decodes it turned
    (1080x1920). `parseProbeOutput` applies the rotation so rung selection sees what the filters see.
  - `aresample=async=1` must run once in `-filter_complex` (then `asplit`), never as a per-output `-af`. With one
    per rendition, the full ladder froze for good (no error, out_time stuck) at the first audio gap of a real-time
    input, including every loop point of a looping file. Test audio changes with a looping live file.
  - The `fps` filter takes `source_fps` in its expression, which keeps the cap working for unprobed push sources.
  - HEVC passthrough: ffmpeg writes no `CODECS` at all for HEVC from an MP4 (hvcC) source, so `fillMissingCodecs`
    (src/hls/codecs.ts) adds it from the first segment. ffmpeg writes `hev1` unless given `-tag:v hvc1`, which Apple
    requires. Copying AAC from MPEG-TS/SRT/RTMP into fMP4 fails without `-bsf:a aac_adtstoasc`. A copied push stream
    has no bitrate, so `BANDWIDTH` is nonsense unless `-b:v`/`-b:a` are declared.
  - Audio stays muxed into each rendition. A shared audio group would save ~2% CPU (4 AAC encodes cost 1.4s per
    minute against 52s for the video ladder) at the cost of an extra playlist players must sync. Not worth it.
  - ffmpeg's live playlists are wrong after a restart: it never writes `EXT-X-DISCONTINUITY-SEQUENCE`, and with fMP4
    plus `append_list` one `EXT-X-MAP` (its own run's) covers every segment, earlier runs' included.

## HLS invariants

- Keyframes stay aligned to `hls_time` across all variants (`-force_key_frames` + fixed GOP + `-sc_threshold 0`).
  ABR switching depends on it.
- Live playlists use `append_list` so media sequence numbers continue across restarts, and `omit_endlist` so players
  keep polling while a publisher reconnects. Do **not** add `discont_start` (duplicates the discontinuity tag) or
  `-hls_start_number_source epoch` (with append_list it renumbers already-published segments).
- `prepareOutputDir` sweeps orphaned segments before each live run; VOD output is wiped and rebuilt.
- A segment that leaves the live playlist stays on disk for one segment plus the playlist's duration (RFC 8216
  6.2.2): `-hls_delete_threshold` is `liveListSize + 1` (ffmpeg's default keeps one), and the sweep keeps
  unreferenced files younger than that window.
- Segment and init names carry a per-run id (`seg_<runId>_<n>`, `init_<runId>[_<variant>].mp4`), so a URL never
  changes content and can be cached for a day. Numbering alone isn't enough: it restarts when a channel is
  recreated or a VOD rebuilt. The run id also marks run boundaries for the publisher.
- Live playlists are published. ffmpeg writes `ffmpeg.m3u8`/`ffmpeg-master.m3u8`, and `PlaylistPublisher` rewrites
  them into `index.m3u8`/`master.m3u8` (logic in `src/hls/playlist.ts`), adding `EXT-X-DISCONTINUITY-SEQUENCE` and a
  per-run `EXT-X-MAP`. Never serve ffmpeg's copies to players. VOD is a single run, so ffmpeg writes the served
  names directly.
- The live sweep keeps anything `ffmpeg.m3u8` or the published `index.m3u8` references: only the published one
  still lists earlier runs' init sections.
- nginx must keep the CORS headers and preflight handling (`nginx/cors.conf`, included in every HLS location) and
  `Cache-Control: no-cache` on `.m3u8`. These are what let the hls.js demo page play from localhost.
- nginx serves HLS on every interface but only proxies `/api/` for localhost: the API can encode any file on disk
  and pull any URL.
- Secrets (SRT passphrases, `user:password@` in URLs) go through `redactSecrets` before reaching logs, `stderrTail`,
  `lastError` or the status `spec`.

## Paths

- `var/` (gitignored): `hls/` output, `channels.json` (persisted channels), `pids/` (ffmpeg pid files, used to kill
  orphans after a crash), `nginx/` logs and temp dirs. `media/` (gitignored) holds input files.

## Git

- Never push code changes.
- Never commit without a message describing what was done.
