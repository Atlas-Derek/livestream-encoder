import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Set for finite sources (files, VOD playlists); null for live ones, which ffprobe reports without a duration. */
  durationSec: number | null;
}

export type ProbeFn = (input: string) => Promise<ProbeResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

export function parseProbeOutput(json: unknown): ProbeResult {
  const streams = isRecord(json) && Array.isArray(json.streams) ? json.streams.filter(isRecord) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = isRecord(json) && isRecord(json.format) ? json.format : null;
  return {
    width: positiveNumber(video?.width),
    height: positiveNumber(video?.height),
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
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
