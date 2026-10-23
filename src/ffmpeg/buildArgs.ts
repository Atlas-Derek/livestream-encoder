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
 * It runs once, in the filter graph, and asplit feeds the renditions. Verified with ffmpeg 9: as a per-output -af
 * (one aresample per rendition) the full ladder froze for good at the first gap of a real-time input, which includes
 * every loop point of a looping file. The stall watchdog then restarted it.
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

/**
 * Segments to keep on disk after they leave the live playlist. RFC 8216 6.2.2: a removed segment must stay available
 * for its own duration plus the playlist's, or a player holding an older playlist gets a 404. ffmpeg's default
 * (hls_delete_threshold 1) keeps one. Verified with ffmpeg 9: a threshold of N keeps exactly N unreferenced segments.
 */
export function liveRetainedSegments(liveListSize: number): number {
  return liveListSize + 1;
}

/** ffprobe's color_space names, as the scale filter's in_color_matrix spells them. */
const SCALE_MATRIX: Record<string, string> = {
  bt709: 'bt709',
  smpte170m: 'smpte170m',
  bt470bg: 'bt470',
  bt2020nc: 'bt2020',
  bt2020c: 'bt2020',
  fcc: 'fcc',
  smpte240m: 'smpte240m',
};

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

export const OUTPUT_COLOR_ARGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

export interface ColorPlan {
  /** Runs once before the split: tone maps HDR (PQ or HLG, as most phones record) to SDR BT.709. */
  tonemap: string | null;
  /** Appended to each rung's scale: converts the source's YUV matrix to BT.709 in limited range. */
  scale: string;
  /** Tags the encoded video as BT.709 SDR. */
  output: string[];
}

/**
 * Every rendition is SDR BT.709, the only thing every player shows right. Without tone mapping, 8-bit H.264 from an
 * HDR source looks washed out. Verified with ffmpeg 9: scale assumes BT.601 for an untagged source, so a BT.709 one
 * shifted color unless in_color_matrix is given; untagged sources get what players assume (BT.709 from 720 lines up).
 * Push sources can't be probed, so their color is left as the publisher tagged it, and the encoder carries the tags.
 */
export function colorPlan(probe: ProbeResult | null): ColorPlan {
  if (probe === null) return { tonemap: null, scale: '', output: [] };
  const transfer = probe.colorTransfer;
  let tonemap: string | null = null;
  let matrix: string;
  if (transfer !== null && HDR_TRANSFERS.has(transfer)) {
    // npl=203: HDR reference white (BT.2408, 75% HLG) becomes SDR white. mobius keeps tones below 0.8 of it linear and
    // rolls highlights off instead of clipping them. Measured on a BT.2408 HLG test pattern against its SDR original:
    // 29.8 dB PSNR (no tone mapping: 17.3, hable: 15.6, which darkens everything). 2.9x real time on 4K.
    tonemap = [
      `zscale=tin=${transfer}:pin=bt2020:min=bt2020nc:t=linear:npl=203`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=mobius:param=0.8:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ].join(',');
    matrix = 'bt709';
  } else {
    const shortSide = probe.width !== null && probe.height !== null ? Math.min(probe.width, probe.height) : null;
    const guess = shortSide !== null && shortSide < 720 ? 'smpte170m' : 'bt709';
    matrix = (probe.colorSpace !== null ? SCALE_MATRIX[probe.colorSpace] : undefined) ?? guess;
  }
  return { tonemap, scale: `:in_color_matrix=${matrix}:out_color_matrix=bt709:out_range=tv`, output: OUTPUT_COLOR_ARGS };
}

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

/**
 * Lets ffmpeg's HTTP client resume where a dropped connection left off (a Range request for a file, a new request for
 * a stream or an HLS playlist) instead of failing the run, which would restart ffmpeg and add a discontinuity.
 * Verified: a server cutting the connection 1MB into a 2.2MB file ended playback at 2.7s of 6s without these; with
 * them ffmpeg resumed at byte 1000000 and played to the end. An upstream gone for longer still trips rw_timeout or the
 * stall watchdog, and the supervisor restarts the run.
 */
const HTTP_RECONNECT = [
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
];

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
      // Played once, a live source would complete the channel at its first dropout instead of reconnecting.
      if (!input.loop && pace.length === 0) {
        throw new AppError('"loop": false needs a finite source (an HTTP file or VOD playlist); ffprobe reports no duration', 422);
      }
      // The RTSP demuxer has its own socket timeout; every other protocol honours rw_timeout (microseconds).
      if (input.url.startsWith('rtsp')) {
        return [...pace, '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', input.url];
      }
      return [...pace, '-rw_timeout', '10000000', ...(input.url.startsWith('http') ? HTTP_RECONNECT : []), '-i', input.url];
    }
    case 'rtmp':
      return ['-listen', '1', '-i', `rtmp://0.0.0.0:${requirePort(port, input)}/live/${input.streamKey}`];
    case 'srt': {
      // latency is in microseconds.
      let url = `srt://0.0.0.0:${requirePort(port, input)}?mode=listener&latency=${input.latencyMs * 1000}`;
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
 * Optional frame-rate cap, then scaling so the short side matches the rung (width for portrait sources) with the
 * color conversion, then the optional debug label. Rung names are [A-Za-z0-9_-], so they need no escaping.
 */
function rungFilter(rung: Rung, portrait: boolean, overlay: boolean, color: ColorPlan): string {
  const steps: string[] = [];
  // source_fps is resolved by ffmpeg, so this also works for push sources whose frame rate is unknown here.
  if (rung.maxFps !== undefined) steps.push(`fps=fps=source_fps/ceil(source_fps/${rung.maxFps})`);
  steps.push(`${portrait ? `scale=${rung.height}:-2` : `scale=-2:${rung.height}`}${color.scale}`);
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
  const color = colorPlan(probe);
  // Deinterlace and tone map once, before the split.
  const source = `[0:v]${DEINTERLACE}${color.tonemap === null ? '' : `,${color.tonemap}`}`;
  const filter =
    rungs.length === 1 && only !== undefined
      ? `${source},${rungFilter(only, portrait, overlay, color)}[v0]`
      : [
          `${source},split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')}`,
          ...rungs.map((rung, i) => `[s${i}]${rungFilter(rung, portrait, overlay, color)}[v${i}]`),
        ].join(';');
  const audio =
    rungs.length === 1
      ? `[0:a]${AUDIO_SYNC}[a0]`
      : `[0:a]${AUDIO_SYNC},asplit=${rungs.length}${rungs.map((_, i) => `[a${i}]`).join('')}`;

  const args = ['-filter_complex', hasAudio ? `${filter};${audio}` : filter];
  rungs.forEach((_, i) => {
    args.push('-map', `[v${i}]`);
    if (hasAudio) args.push('-map', `[a${i}]`);
  });
  args.push(...videoEncoderArgs(encoder), ...color.output, ...gopArgs(rungs, probe?.fps ?? null, encoder));
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
    args.push(
      '-hls_list_size', String(encoder.liveListSize),
      '-hls_delete_threshold', String(liveRetainedSegments(encoder.liveListSize)),
      '-hls_flags', LIVE_HLS_FLAGS,
    );
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
    if (probe?.videoCodec === 'hevc') {
      // Safari and hls.js only play HEVC from fMP4, and Apple requires the hvc1 sample entry. Copied from MPEG-TS
      // or a push source, ffmpeg would write hev1.
      if (spec.segmentType !== 'fmp4') {
        throw new AppError('HEVC passthrough needs "segmentType": "fmp4"; players only play HEVC from fMP4', 422);
      }
      args.push('-tag:v', 'hvc1');
    }
    // AAC copied from MPEG-TS, SRT or RTMP is ADTS, which fMP4 can't carry; the HLS muxer doesn't add the filter
    // itself. For AAC already in MP4 form it changes nothing. Push sources are assumed AAC, as OBS sends.
    if (spec.segmentType === 'fmp4' && hasAudio && (probe === null || probe.audioCodec === 'aac')) {
      args.push('-bsf:a', 'aac_adtstoasc');
    }
    if (probe === null) {
      // A copied push stream carries no bitrate, so ffmpeg advertised BANDWIDTH=79310 for a 2.6 Mbps stream. Declare
      // the top rung's as an estimate; with a single rendition, players don't choose by it.
      const top = ladder.reduce((a, b) => (b.height > a.height ? b : a));
      args.push('-b:v', `${top.videoBitrateKbps}k`, ...(hasAudio ? ['-b:a', `${top.audioBitrateKbps}k`] : []));
    }
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
