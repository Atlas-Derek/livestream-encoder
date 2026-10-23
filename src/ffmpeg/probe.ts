import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  /** As displayed: rotation metadata (phone video is often stored landscape and rotated 90°) is applied. */
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** ffprobe's color_space (the YUV matrix: bt709, smpte170m, bt2020nc…); null when untagged. */
  colorSpace: string | null;
  /** ffprobe's color_transfer; smpte2084 (PQ) and arib-std-b67 (HLG) mean HDR. null when untagged. */
  colorTransfer: string | null;
  /** Set for finite sources (files, VOD playlists); null for live ones, which ffprobe reports without a duration. */
  durationSec: number | null;
}

export type ProbeFn = (input: string) => Promise<ProbeResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** ffprobe writes "unknown" or "unspecified", or leaves the key out, for untagged color properties. */
function colorTag(value: unknown): string | null {
  return typeof value === 'string' && value !== 'unknown' && value !== 'unspecified' && value !== '' ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Parses ffprobe's "30000/1001" style rates. */
export function parseFrameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num) || num <= 0) return null;
  if (den === undefined) return num;
  return Number.isFinite(den) && den > 0 ? num / den : null;
}

/** The display rotation in degrees from a stream's side data, e.g. 90 or -90 for portrait phone video. */
function rotation(stream: Record<string, unknown> | undefined): number {
  const sideData = Array.isArray(stream?.side_data_list) ? stream.side_data_list.filter(isRecord) : [];
  const value = sideData.find((d) => typeof d.rotation === 'number')?.rotation;
  return typeof value === 'number' ? value : 0;
}

export function parseProbeOutput(json: unknown): ProbeResult {
  const streams = isRecord(json) && Array.isArray(json.streams) ? json.streams.filter(isRecord) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = isRecord(json) && isRecord(json.format) ? json.format : null;
  // ffprobe reports the stored size, but ffmpeg rotates frames while decoding, so the filters see them turned.
  const turned = Math.abs(rotation(video)) % 180 === 90;
  return {
    width: positiveNumber(turned ? video?.height : video?.width),
    height: positiveNumber(turned ? video?.width : video?.height),
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    colorSpace: colorTag(video?.color_space),
    colorTransfer: colorTag(video?.color_transfer),
    durationSec: positiveNumber(typeof format?.duration === 'string' ? Number(format.duration) : format?.duration),
  };
}

export function createProbe(ffprobePath: string, timeoutMs = 20_000): ProbeFn {
  return async (input) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format'];
    if (input.startsWith('rtsp')) args.push('-rtsp_transport', 'tcp');
    args.push(input);
    try {
      const { stdout } = await execFileAsync(ffprobePath, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return parseProbeOutput(JSON.parse(stdout));
    } catch (err) {
      const detail = isRecord(err) && typeof err.stderr === 'string' && err.stderr.trim() !== '' ? err.stderr.trim() : String(err);
      throw new Error(`ffprobe failed for ${input}: ${detail}`, { cause: err });
    }
  };
}

/**
 * ffprobe -show_streams -show_data of one output segment, for the codec configuration bytes (extradata) that
 * src/hls/codecs.ts turns into a CODECS attribute. The init section is prepended for fMP4. The bytes go in on stdin, so
 * no path quoting or temp file is needed.
 */
export function createSegmentStreamProbe(ffprobePath: string, timeoutMs = 10_000) {
  return async (segment: string, init: string | null): Promise<unknown> => {
    const data = Buffer.concat([...(init === null ? [] : [await readFile(init)]), await readFile(segment)]);
    const child = spawn(ffprobePath, ['-v', 'error', '-show_streams', '-show_data', '-of', 'json', '-i', 'pipe:0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // ffprobe may stop reading before the end of the segment; that is not an error.
    child.stdin.on('error', () => {});
    child.stdin.end(data);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw new Error(`ffprobe failed for ${segment}: ${Buffer.concat(err).toString().trim() || `exit ${code}`}`);
    return JSON.parse(Buffer.concat(out).toString());
  };
}
