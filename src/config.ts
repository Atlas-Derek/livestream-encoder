import path from 'node:path';

export type VideoEncoder = 'libx264' | 'h264_videotoolbox';

export interface PortRange {
  start: number;
  end: number;
}

export interface Config {
  rootDir: string;
  varDir: string;
  hlsRoot: string;
  apiHost: string;
  apiPort: number;
  /** Base URL players use to reach var/hls through nginx. */
  publicHlsBaseUrl: string;
  /** Hostname shown in RTMP/SRT ingest URLs. */
  ingestHost: string;
  ffmpegPath: string;
  ffprobePath: string;
  rtmpPorts: PortRange;
  srtPorts: PortRange;
  videoEncoder: VideoEncoder;
  x264Preset: string;
  segmentSeconds: number;
  liveListSize: number;
  /** POSTed channel and recording events (src/notify/webhooks.ts). */
  webhookUrls: string[];
  webhookSecret: string | null;
  /** When set, playback URLs are signed (src/api/playback.ts) and nginx serves only signed ones (scripts/nginx.sh). */
  playbackSecret: string | null;
  /** How long a signed playback URL from the channel status stays valid. */
  playbackTokenTtlSeconds: number;
}

const FFMPEG_FULL_BIN = '/opt/homebrew/opt/ffmpeg-full/bin';

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function readRange(env: NodeJS.ProcessEnv, key: string, fallback: PortRange): PortRange {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const match = /^(\d+)-(\d+)$/.exec(raw);
  if (!match) throw new Error(`${key} must look like "1935-1944", got "${raw}"`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end) throw new Error(`${key} start must be <= end, got "${raw}"`);
  return { start, end };
}

function readEncoder(env: NodeJS.ProcessEnv): VideoEncoder {
  const raw = env.VIDEO_ENCODER ?? 'libx264';
  if (raw === 'libx264' || raw === 'h264_videotoolbox') return raw;
  throw new Error(`VIDEO_ENCODER must be libx264 or h264_videotoolbox, got "${raw}"`);
}

function readSecret(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined || raw === '') return null;
  // Written into nginx's config by scripts/nginx.sh, so nothing that needs quoting.
  if (!/^[A-Za-z0-9_-]{16,}$/.test(raw)) throw new Error(`${key} must be at least 16 letters, digits, _ or -`);
  return raw;
}

function readUrls(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((part) => {
    const value = part.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${key} must be comma-separated http(s) URLs, got "${value}"`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${key} must use http or https, got "${value}"`);
    return value;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rootDir = path.resolve(import.meta.dirname, '..');
  const varDir = path.resolve(rootDir, env.VAR_DIR ?? 'var');
  return {
    rootDir,
    varDir,
    hlsRoot: path.resolve(rootDir, env.HLS_ROOT ?? path.join(varDir, 'hls')),
    apiHost: env.API_HOST ?? '127.0.0.1',
    apiPort: readInt(env, 'API_PORT', 3000),
    publicHlsBaseUrl: (env.PUBLIC_HLS_BASE_URL ?? 'http://localhost:8080/hls').replace(/\/+$/, ''),
    ingestHost: env.INGEST_HOST ?? 'localhost',
    ffmpegPath: env.FFMPEG_PATH ?? `${FFMPEG_FULL_BIN}/ffmpeg`,
    ffprobePath: env.FFPROBE_PATH ?? `${FFMPEG_FULL_BIN}/ffprobe`,
    rtmpPorts: readRange(env, 'RTMP_PORTS', { start: 1935, end: 1944 }),
    srtPorts: readRange(env, 'SRT_PORTS', { start: 9000, end: 9009 }),
    videoEncoder: readEncoder(env),
    x264Preset: env.X264_PRESET ?? 'veryfast',
    segmentSeconds: readInt(env, 'SEGMENT_SECONDS', 4),
    liveListSize: readInt(env, 'LIVE_LIST_SIZE', 6),
    webhookUrls: readUrls(env, 'WEBHOOK_URLS'),
    webhookSecret: env.WEBHOOK_SECRET || null,
    playbackSecret: readSecret(env, 'PLAYBACK_SECRET'),
    playbackTokenTtlSeconds: readInt(env, 'PLAYBACK_TOKEN_TTL_SECONDS', 6 * 3600),
  };
}
