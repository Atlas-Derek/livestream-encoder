import path from 'node:path';
import type { ChannelSpec, Input, Rung } from '../channels/schema.ts';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { FFMPEG_MASTER_PLAYLIST, FFMPEG_MEDIA_PLAYLIST, MASTER_PLAYLIST, MEDIA_PLAYLIST } from '../hls/playlist.ts';
import type { ProbeResult } from './probe.ts';

export type EncoderConfig = Pick<Config, 'videoEncoder' | 'x264Preset' | 'segmentSeconds' | 'liveListSize'>;

export interface BuildOptions {
  /** Directory that receives master.m3u8 and one sub-directory per variant. */
  outDir: string;
  /**
   * Unique per ffmpeg run and embedded in segment names (seg_<runId>_<n>). Recreating a channel or rebuilding a VOD
   * restarts numbering, and nginx lets players cache segments for a day, so a segment URL must never be reused.
   */
  runId: string;
  ladder: Rung[];
  /** Listener port for rtmp/srt inputs. */
  port: number | null;
  /** ffprobe result for file/pull inputs; null for push inputs, whose format is unknown until a publisher connects. */
  probe: ProbeResult | null;
  encoder: EncoderConfig;
}

export interface BuildResult {
  args: string[];
  /** Variant directory names, in master playlist order. */
  variants: string[];
}

export const PASSTHROUGH_VARIANT = 'source';

/** Assumes push sources run at most this fast when sizing the GOP without a known frame rate. */
const MAX_ASSUMED_FPS = 60;

/**
 * Deinterlaces only frames flagged as interlaced (1080i from broadcast gear and hardware SRT encoders), keeping the
 * frame rate. Progressive frames pass through bit-identical, so it is safe on push sources nobody could probe.
 */
const DEINTERLACE = 'bwdif=mode=send_frame:parity=auto:deint=interlaced';

/**
 * Fills audio timestamp gaps (dropped packets from OBS or the network) with silence and trims overlaps, so audio
 * doesn't drift ahead of video after a gap. first_pts=0 pads audio that starts after the video.
 */
const AUDIO_SYNC = 'aresample=async=1:first_pts=0';

// append_list continues media sequence numbers from the existing playlist after a restart and inserts the
// EXT-X-DISCONTINUITY itself. Don't add discont_start (duplicates the tag) or an epoch start number (with
// append_list it renumbers already-published segments, which the HLS spec forbids).
// omit_endlist keeps players polling while a push publisher reconnects.
const LIVE_HLS_FLAGS = [
  'delete_segments',
  'independent_segments',
  'temp_file',
  'program_date_time',
  'append_list',
  'omit_endlist',
].join('+');

const PASSTHROUGH_VIDEO_CODECS = new Set(['h264', 'hevc']);
const PASSTHROUGH_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3']);

/** Masks secrets that ffmpeg args and log lines can carry: SRT passphrases and user:password@ in URLs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/passphrase=[^&\s]*/g, 'passphrase=********')
    .replace(/(\/\/[^:/@\s]+):[^@/\s]*@/g, '$1:********@');
}

/** Drops rungs bigger than the source so nothing is upscaled. Rung heights are the picture's short side. */
export function selectRungs(ladder: Rung[], sourceShortSide: number | null): Rung[] {
  if (ladder.length === 0) throw new AppError('ladder must contain at least one rung', 422);
  if (sourceShortSide === null) return ladder;
  const fitting = ladder.filter((rung) => rung.height <= sourceShortSide);
  if (fitting.length > 0) return fitting;
  // Source is smaller than every rung: encode one rendition at the source size.
  const smallest = ladder.reduce((a, b) => (b.height < a.height ? b : a));
  return [{ ...smallest, height: sourceShortSide - (sourceShortSide % 2) }];
}

/**
 * A rung's frame rate: the source's divided by the smallest whole number that brings it to maxFps or below, so the
 * cadence stays even (59.94 -> 29.97, 50 -> 25, 29.97 unchanged). Matches the fps filter expression in rungFilter.
 */
export function rungFps(sourceFps: number, maxFps: number | undefined): number {
  return maxFps === undefined ? sourceFps : sourceFps / Math.ceil(sourceFps / maxFps);
}

function requirePort(port: number | null, input: Input): number {
  if (port === null) throw new AppError(`${input.type} input has no listener port assigned`, 500);
  return port;
}

export function inputArgs(
  input: Input,
  mode: ChannelSpec['mode'],
  port: number | null,
  probe: ProbeResult | null = null,
): string[] {
  switch (input.type) {
    case 'file':
      return [...(mode === 'live' ? ['-re'] : []), ...(input.loop ? ['-stream_loop', '-1'] : []), '-i', input.path];
    case 'pull': {
      // A finite source (an HTTP file, a VOD playlist) would otherwise be read as fast as the CPU allows and race
      // through the live window. Live sources pace themselves, and -re on them only adds latency.
      const pace = probe?.durationSec != null ? ['-re'] : [];
      // The RTSP demuxer has its own socket timeout; every other protocol honours rw_timeout (microseconds).
      return input.url.startsWith('rtsp')
        ? [...pace, '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', input.url]
        : [...pace, '-rw_timeout', '10000000', '-i', input.url];
    }
    case 'rtmp':
      return ['-listen', '1', '-i', `rtmp://0.0.0.0:${requirePort(port, input)}/live/${input.streamKey}`];
    case 'srt': {
      let url = `srt://0.0.0.0:${requirePort(port, input)}?mode=listener`;
      if (input.passphrase !== undefined) url += `&passphrase=${encodeURIComponent(input.passphrase)}&pbkeylen=16`;
      return ['-i', url];
    }
  }
}

function gopArgs(rungs: Rung[], fps: number | null, encoder: EncoderConfig): string[] {
  const seg = encoder.segmentSeconds;
  // Forced keyframes keep every variant cut at the same instants, which ABR switching depends on. They are
  // time-based, so rungs at a capped frame rate still cut where the others do.
  const args = ['-force_key_frames', `expr:gte(t,n_forced*${seg})`];
  rungs.forEach((rung, i) => {
    // Per rung, since a capped rung has fewer frames per segment. Sized so it never fires before the forced keyframe.
    const gop = fps === null ? seg * MAX_ASSUMED_FPS : Math.round(rungFps(fps, rung.maxFps) * seg);
    args.push(`-g:v:${i}`, String(gop));
    if (fps !== null) args.push(`-keyint_min:v:${i}`, String(gop));
  });
  if (encoder.videoEncoder === 'libx264') args.push('-sc_threshold', '0');
  return args;
}

function videoEncoderArgs(encoder: EncoderConfig): string[] {
  return encoder.videoEncoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', encoder.x264Preset, '-profile:v', 'high']
    : ['-c:v', 'h264_videotoolbox', '-profile:v', 'high'];
}

/**
 * Optional frame-rate cap, then scaling so the short side matches the rung (width for portrait sources), then the
 * optional debug label. Rung names are [A-Za-z0-9_-], so they need no escaping in the filtergraph.
 */
function rungFilter(rung: Rung, portrait: boolean, overlay: boolean): string {
  const steps: string[] = [];
  // source_fps is resolved by ffmpeg, so this also works for push sources whose frame rate is unknown here.
  if (rung.maxFps !== undefined) steps.push(`fps=fps=source_fps/ceil(source_fps/${rung.maxFps})`);
  steps.push(portrait ? `scale=${rung.height}:-2` : `scale=-2:${rung.height}`);
  // Top right, clear of the clock the push scripts draw top left.
  if (overlay) {
    steps.push(`drawtext=text='${rung.name}':fontsize=h/14:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=12:x=w-tw-24:y=24`);
  }
  steps.push('format=yuv420p');
  return steps.join(',');
}

function ladderArgs(
  rungs: Rung[],
  portrait: boolean,
  overlay: boolean,
  hasAudio: boolean,
  probe: ProbeResult | null,
  encoder: EncoderConfig,
): string[] {
  const [only] = rungs;
  // Deinterlace once, before the split.
  const filter =
    rungs.length === 1 && only !== undefined
      ? `[0:v]${DEINTERLACE},${rungFilter(only, portrait, overlay)}[v0]`
      : [
          `[0:v]${DEINTERLACE},split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')}`,
          ...rungs.map((rung, i) => `[s${i}]${rungFilter(rung, portrait, overlay)}[v${i}]`),
        ].join(';');

  const args = ['-filter_complex', filter];
  rungs.forEach((_, i) => {
    args.push('-map', `[v${i}]`);
    if (hasAudio) args.push('-map', '0:a:0');
  });
  args.push(...videoEncoderArgs(encoder), ...gopArgs(rungs, probe?.fps ?? null, encoder));
  rungs.forEach((rung, i) => {
    const kbps = rung.videoBitrateKbps;
    args.push(
      `-b:v:${i}`, `${kbps}k`,
      `-maxrate:v:${i}`, `${Math.round(kbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(kbps * 1.5)}k`,
    );
  });
  if (hasAudio) {
    args.push('-af', AUDIO_SYNC, '-c:a', 'aac', '-ar', '48000', '-ac', '2');
    rungs.forEach((rung, i) => args.push(`-b:a:${i}`, `${rung.audioBitrateKbps}k`));
  }
  return args;
}

function assertPassthroughCompatible(probe: ProbeResult | null): void {
  if (probe === null) return; // push input: trust the publisher
  if (probe.videoCodec === null || !PASSTHROUGH_VIDEO_CODECS.has(probe.videoCodec)) {
    throw new AppError(`passthrough needs H.264 or HEVC video, source is ${probe.videoCodec ?? 'missing'}`, 422);
  }
  if (probe.audioCodec !== null && !PASSTHROUGH_AUDIO_CODECS.has(probe.audioCodec)) {
    throw new AppError(`passthrough cannot carry ${probe.audioCodec} audio in HLS`, 422);
  }
}

function hlsArgs(spec: ChannelSpec, outDir: string, runId: string, variants: string[], varStreamMap: string, encoder: EncoderConfig): string[] {
  const ext = spec.segmentType === 'fmp4' ? 'm4s' : 'ts';
  const live = spec.mode === 'live';
  const args = ['-f', 'hls', '-hls_time', String(encoder.segmentSeconds), '-hls_segment_type', spec.segmentType];
  // Per run, so earlier runs' segments keep their own init section. ffmpeg requires %v (the variant name) in a
  // custom name when there are several variants, but leaves it unexpanded, a literal "%v", when there is one.
  if (spec.segmentType === 'fmp4') {
    args.push('-hls_fmp4_init_filename', variants.length > 1 ? `init_${runId}_%v.mp4` : `init_${runId}.mp4`);
  }
  args.push(
    // append_list keeps counting across runs, so the run id only changes the name, not the sequence number.
    '-hls_segment_filename', path.join(outDir, '%v', `seg_${runId}_%05d.${ext}`),
    // Live playlists go through the publisher (src/hls/playlist.ts); VOD output is a single run and served as is.
    '-master_pl_name', live ? FFMPEG_MASTER_PLAYLIST : MASTER_PLAYLIST,
    '-var_stream_map', varStreamMap,
  );
  if (live) {
    args.push('-hls_list_size', String(encoder.liveListSize), '-hls_flags', LIVE_HLS_FLAGS);
  } else {
    args.push('-hls_playlist_type', 'vod', '-hls_list_size', '0', '-hls_flags', 'independent_segments+temp_file');
  }
  args.push(path.join(outDir, '%v', live ? FFMPEG_MEDIA_PLAYLIST : MEDIA_PLAYLIST));
  return args;
}

/** Pure: turns a channel spec into the ffmpeg argument list. Never shell-joined; pass straight to spawn. */
export function buildArgs(spec: ChannelSpec, options: BuildOptions): BuildResult {
  const { outDir, runId, ladder, port, probe, encoder } = options;
  // Push inputs declare it (OBS always sends audio); probed sources tell us.
  const { input } = spec;
  const hasAudio = input.type === 'rtmp' || input.type === 'srt' ? input.audio : probe === null || probe.audioCodec !== null;

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-y'];
  args.push(...inputArgs(spec.input, spec.mode, port, probe));

  let variants: string[];
  if (spec.passthrough) {
    assertPassthroughCompatible(probe);
    variants = [PASSTHROUGH_VARIANT];
    args.push('-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []), '-c', 'copy');
  } else {
    // Push sources can't be probed, so they are treated as landscape.
    const portrait = probe?.width != null && probe.height != null && probe.height > probe.width;
    const rungs = selectRungs(ladder, (portrait ? probe?.width : probe?.height) ?? null);
    variants = rungs.map((rung) => rung.name);
    args.push(...ladderArgs(rungs, portrait, spec.debugOverlay, hasAudio, probe, encoder));
  }
  args.push('-max_muxing_queue_size', '1024');

  const varStreamMap = variants
    .map((name, i) => (hasAudio ? `v:${i},a:${i},name:${name}` : `v:${i},name:${name}`))
    .join(' ');
  args.push(...hlsArgs(spec, outDir, runId, variants, varStreamMap, encoder));
  return { args, variants };
}
