import path from 'node:path';
import type { ChannelSpec, Input, Rung } from '../channels/schema.ts';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
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

/** Drops rungs taller than the source so nothing is upscaled. */
export function selectRungs(ladder: Rung[], sourceHeight: number | null): Rung[] {
  if (ladder.length === 0) throw new AppError('ladder must contain at least one rung', 422);
  if (sourceHeight === null) return ladder;
  const fitting = ladder.filter((rung) => rung.height <= sourceHeight);
  if (fitting.length > 0) return fitting;
  // Source is smaller than every rung: encode one rendition at the source height.
  const smallest = ladder.reduce((a, b) => (b.height < a.height ? b : a));
  return [{ ...smallest, height: sourceHeight - (sourceHeight % 2) }];
}

function requirePort(port: number | null, input: Input): number {
  if (port === null) throw new AppError(`${input.type} input has no listener port assigned`, 500);
  return port;
}

export function inputArgs(input: Input, mode: ChannelSpec['mode'], port: number | null): string[] {
  switch (input.type) {
    case 'file':
      return [...(mode === 'live' ? ['-re'] : []), ...(input.loop ? ['-stream_loop', '-1'] : []), '-i', input.path];
    case 'pull':
      // The RTSP demuxer has its own socket timeout; every other protocol honours rw_timeout (microseconds).
      return input.url.startsWith('rtsp')
        ? ['-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', input.url]
        : ['-rw_timeout', '10000000', '-i', input.url];
    case 'rtmp':
      return ['-listen', '1', '-i', `rtmp://0.0.0.0:${requirePort(port, input)}/live/${input.streamKey}`];
    case 'srt': {
      let url = `srt://0.0.0.0:${requirePort(port, input)}?mode=listener`;
      if (input.passphrase !== undefined) url += `&passphrase=${encodeURIComponent(input.passphrase)}&pbkeylen=16`;
      return ['-i', url];
    }
  }
}

function gopArgs(fps: number | null, encoder: EncoderConfig): string[] {
  const seg = encoder.segmentSeconds;
  // Forced keyframes keep every variant cut at the same instants, which ABR switching depends on.
  const gop = fps === null ? seg * MAX_ASSUMED_FPS : Math.round(fps * seg);
  const args = ['-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-g', String(gop)];
  if (fps !== null) args.push('-keyint_min', String(gop));
  if (encoder.videoEncoder === 'libx264') args.push('-sc_threshold', '0');
  return args;
}

function videoEncoderArgs(encoder: EncoderConfig): string[] {
  return encoder.videoEncoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', encoder.x264Preset, '-profile:v', 'high']
    : ['-c:v', 'h264_videotoolbox', '-profile:v', 'high'];
}

function ladderArgs(rungs: Rung[], hasAudio: boolean, probe: ProbeResult | null, encoder: EncoderConfig): string[] {
  const filter =
    rungs.length === 1
      ? `[0:v]scale=-2:${rungs[0]?.height},format=yuv420p[v0]`
      : [
          `[0:v]split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')}`,
          ...rungs.map((rung, i) => `[s${i}]scale=-2:${rung.height},format=yuv420p[v${i}]`),
        ].join(';');

  const args = ['-filter_complex', filter];
  rungs.forEach((_, i) => {
    args.push('-map', `[v${i}]`);
    if (hasAudio) args.push('-map', '0:a:0');
  });
  args.push(...videoEncoderArgs(encoder), ...gopArgs(probe?.fps ?? null, encoder));
  rungs.forEach((rung, i) => {
    const kbps = rung.videoBitrateKbps;
    args.push(
      `-b:v:${i}`, `${kbps}k`,
      `-maxrate:v:${i}`, `${Math.round(kbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(kbps * 1.5)}k`,
    );
  });
  if (hasAudio) {
    args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2');
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

function hlsArgs(spec: ChannelSpec, outDir: string, runId: string, varStreamMap: string, encoder: EncoderConfig): string[] {
  const ext = spec.segmentType === 'fmp4' ? 'm4s' : 'ts';
  const args = ['-f', 'hls', '-hls_time', String(encoder.segmentSeconds), '-hls_segment_type', spec.segmentType];
  if (spec.segmentType === 'fmp4') args.push('-hls_fmp4_init_filename', 'init.mp4');
  args.push(
    // append_list keeps counting across runs, so the run id only changes the name, not the sequence number.
    '-hls_segment_filename', path.join(outDir, '%v', `seg_${runId}_%05d.${ext}`),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varStreamMap,
  );
  if (spec.mode === 'live') {
    args.push('-hls_list_size', String(encoder.liveListSize), '-hls_flags', LIVE_HLS_FLAGS);
  } else {
    args.push('-hls_playlist_type', 'vod', '-hls_list_size', '0', '-hls_flags', 'independent_segments+temp_file');
  }
  args.push(path.join(outDir, '%v', 'index.m3u8'));
  return args;
}

/** Pure: turns a channel spec into the ffmpeg argument list. Never shell-joined; pass straight to spawn. */
export function buildArgs(spec: ChannelSpec, options: BuildOptions): BuildResult {
  const { outDir, runId, ladder, port, probe, encoder } = options;
  // Push inputs are assumed to carry audio (OBS always does); probed sources tell us.
  const hasAudio = probe === null || probe.audioCodec !== null;

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-y'];
  args.push(...inputArgs(spec.input, spec.mode, port));

  let variants: string[];
  if (spec.passthrough) {
    assertPassthroughCompatible(probe);
    variants = [PASSTHROUGH_VARIANT];
    args.push('-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []), '-c', 'copy');
  } else {
    const rungs = selectRungs(ladder, probe?.height ?? null);
    variants = rungs.map((rung) => rung.name);
    args.push(...ladderArgs(rungs, hasAudio, probe, encoder));
  }
  args.push('-max_muxing_queue_size', '1024');

  const varStreamMap = variants
    .map((name, i) => (hasAudio ? `v:${i},a:${i},name:${name}` : `v:${i},name:${name}`))
    .join(' ');
  args.push(...hlsArgs(spec, outDir, runId, varStreamMap, encoder));
  return { args, variants };
}
