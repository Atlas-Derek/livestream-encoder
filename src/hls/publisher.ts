import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { fillStreamInfo, type ProbeSegmentStreams } from './codecs.ts';
import type { RecordingSink } from './recorder.ts';
import {
  appendSlateSegment,
  FFMPEG_MASTER_PLAYLIST,
  FFMPEG_MEDIA_PLAYLIST,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  longestSegmentOfLastRun,
  orderVariants,
  parseMediaPlaylist,
  publishMasterPlaylist,
  publishMediaPlaylist,
  segmentDuration,
  SLATE_PLAYLIST,
  unpublishedSegments,
} from './playlist.ts';

export const DEFAULT_PUBLISH_INTERVAL_MS = 250;
/** Segments in a published playlist, unless windowSize says otherwise. Matches LIVE_LIST_SIZE's default. */
export const DEFAULT_WINDOW_SIZE = 6;

/**
 * Segments longer than this many times hls_time get a warning. ffmpeg cuts at the first keyframe at or after hls_time,
 * so an encoded ladder (forced keyframes) stays within a frame of it; longer means sparse source keyframes.
 */
const LONG_SEGMENT_RATIO = 1.25;

export interface PublisherOptions {
  outDir: string;
  channel: string;
  logger: Logger;
  intervalMs?: number;
  /** Reads a segment's streams, to add the CODECS (HEVC) and FRAME-RATE ffmpeg leaves out. */
  probeStreams?: ProbeSegmentStreams;
  /** hls_time: segments much longer than this are reported by warnings(). */
  segmentSeconds?: number;
  /** Passthrough copies the source, so segments can only be cut at its keyframes; the warning says what to change. */
  passthrough?: boolean;
  /** Segments per published playlist. */
  windowSize?: number;
  /** Gets each segment published from the source, and is closed when the source goes down or publishing stops. */
  recorder?: RecordingSink;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Write-then-rename, so nginx never serves a half-written playlist. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/**
 * Keeps a live channel's published playlists (see playlist.ts) in step with ffmpeg's while it runs.
 * It polls rather than using fs.watch: the files are tiny, ffmpeg renames them into place (temp_file), and a fixed
 * interval bounds the extra delay before a new segment is announced.
 */
export class PlaylistPublisher {
  readonly #opts: PublisherOptions;
  #timer: NodeJS.Timeout | null = null;
  #syncing: Promise<void> | null = null;
  /** The ffmpeg playlist text last published from each source file, to skip unchanged ones. */
  readonly #published = new Map<string, string>();
  #lastError: string | null = null;
  /** The newest run's longest segment, per variant directory. */
  readonly #longest = new Map<string, { runId: string; seconds: number }>();
  /** The run whose long segments have been logged, to log them once. */
  #loggedLongRun: string | null = null;
  /** Set while the source is down, so slate segments keep the published playlists growing. */
  #slate = false;
  /** Per variant: the newest published segment and when it was published, which paces the slate behind it. */
  readonly #edges = new Map<string, { uri: string; at: number; seconds: number }>();

  constructor(options: PublisherOptions) {
    this.#opts = options;
  }

  resume(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.sync(), this.#opts.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS);
  }

  /** Stops polling after a last sync, so the segments ffmpeg wrote while exiting are announced too. */
  async pause(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#syncing !== null) await this.#syncing;
    await this.sync();
    await this.#opts.recorder?.close();
  }

  /**
   * Turns the slate on while the source is down (ffmpeg restarting, or waiting for a publisher) and off once it is
   * running again. Slate segments follow the newest segment in real time, each when the one before has played out.
   */
  setSlate(on: boolean): void {
    this.#slate = on;
  }

  /** Problems seen in the published playlists: segments much longer than hls_time, which add latency. */
  warnings(): string[] {
    const target = this.#opts.segmentSeconds;
    const longest = Math.max(0, ...[...this.#longest.values()].map((l) => l.seconds));
    if (target === undefined || longest <= target * LONG_SEGMENT_RATIO) return [];
    const advice = this.#opts.passthrough
      ? `: passthrough can only cut at the source's keyframes. Set the source encoder's keyframe interval to ${target}s ` +
        'or a divisor of it (in OBS: Settings > Output > Keyframe Interval), or encode a ladder instead of passthrough'
      : '';
    return [`segments are up to ${longest.toFixed(1)}s long instead of ${target}s, which adds latency${advice}`];
  }

  /** One pass over the output directory. Joins a pass already in flight. Never rejects; failures are logged. */
  sync(): Promise<void> {
    this.#syncing ??= this.#syncLogged();
    return this.#syncing;
  }

  async #syncLogged(): Promise<void> {
    try {
      await this.#syncOnce();
      if (this.#lastError !== null) this.#opts.logger.info({ channel: this.#opts.channel }, 'playlist publishing recovered');
      this.#lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Polling would repeat the same failure several times a second; log each distinct one once.
      if (message !== this.#lastError) this.#opts.logger.error({ channel: this.#opts.channel, err }, 'failed to publish playlists');
      this.#lastError = message;
    } finally {
      this.#syncing = null;
    }
  }

  async #syncOnce(): Promise<void> {
    const { outDir } = this.#opts;
    let entries;
    try {
      entries = await readdir(outDir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return; // not prepared yet, or deleted
      throw err;
    }
    // Variants before the master, so a player never follows the master to a playlist that doesn't exist yet.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.#publishVariant(entry.name, path.join(outDir, entry.name));
    }
    await this.#publishMaster();
  }

  /**
   * Like #publish, plus the CODECS and FRAME-RATE ffmpeg left out (republished until every variant has a segment to
   * read them from) and the start variant listed first.
   */
  async #publishMaster(): Promise<void> {
    const { outDir, probeStreams } = this.#opts;
    const from = path.join(outDir, FFMPEG_MASTER_PLAYLIST);
    const source = await readIfExists(from);
    if (source === null || this.#published.get(from) === source) return;
    let text = publishMasterPlaylist(source);
    let complete = true;
    if (probeStreams !== undefined) {
      const filled = await fillStreamInfo(text, outDir, probeStreams);
      for (const error of filled.errors) this.#opts.logger.warn({ channel: this.#opts.channel, error }, 'stream info not added');
      ({ text, complete } = filled);
    }
    text = orderVariants(text);
    const to = path.join(outDir, MASTER_PLAYLIST);
    if ((await readIfExists(to)) !== text) await writeAtomic(to, text);
    if (complete) this.#published.set(from, source);
  }

  /** Appends ffmpeg's new segments to the variant's published playlist, then a slate segment if one is due. */
  async #publishVariant(variant: string, dir: string): Promise<void> {
    const windowSize = this.#opts.windowSize ?? DEFAULT_WINDOW_SIZE;
    const from = path.join(dir, FFMPEG_MEDIA_PLAYLIST);
    const to = path.join(dir, MEDIA_PLAYLIST);
    let published = await readIfExists(to);
    const source = await readIfExists(from);
    if (source !== null && this.#published.get(from) !== source) {
      const before = published === null ? null : parseMediaPlaylist(published);
      const fresh = unpublishedSegments(parseMediaPlaylist(source), before).segments;
      published = publishMediaPlaylist(source, published, windowSize);
      await writeAtomic(to, published);
      this.#published.set(from, source);
      this.#trackSegmentLength(variant, source);
      if (this.#opts.recorder !== undefined && fresh.length > 0) {
        // As published (discontinuity and init section corrected), unless already trimmed from a short window.
        const after = parseMediaPlaylist(published);
        const asPublished = fresh.map((segment) => after.segments.find((s) => s.uri === segment.uri) ?? segment);
        await this.#opts.recorder.record(variant, dir, after.header, asPublished);
      }
    }
    if (published === null) return;

    const now = Date.now();
    const newest = parseMediaPlaylist(published).segments.at(-1);
    if (newest === undefined) return;
    let edge = this.#edges.get(variant);
    if (edge?.uri !== newest.uri) {
      edge = { uri: newest.uri, at: now, seconds: segmentDuration(newest) };
      this.#edges.set(variant, edge);
    }
    if (!this.#slate || now < edge.at + edge.seconds * 1000) return;
    // The source has been down for a segment: whatever it comes back with is a new recording.
    await this.#opts.recorder?.close();
    const slate = await readIfExists(path.join(dir, SLATE_PLAYLIST));
    const next = slate === null ? null : appendSlateSegment(published, slate, windowSize);
    if (next === null) return;
    await writeAtomic(to, next);
    const added = parseMediaPlaylist(next).segments.at(-1);
    // Due when the previous one has played out, not when this pass ran, so the cadence doesn't drift with polling.
    if (added !== undefined) this.#edges.set(variant, { uri: added.uri, at: edge.at + edge.seconds * 1000, seconds: segmentDuration(added) });
  }

  #trackSegmentLength(variant: string, source: string): void {
    const longest = longestSegmentOfLastRun(source);
    if (longest === null) return;
    this.#longest.set(variant, longest);
    const [warning] = this.warnings();
    if (warning !== undefined && this.#loggedLongRun !== longest.runId) {
      this.#loggedLongRun = longest.runId;
      this.#opts.logger.warn({ channel: this.#opts.channel, warning }, 'segments longer than hls_time');
    }
  }
}
