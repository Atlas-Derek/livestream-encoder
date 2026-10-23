import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { fillStreamInfo, type ProbeSegmentStreams } from './codecs.ts';
import {
  FFMPEG_MASTER_PLAYLIST,
  FFMPEG_MEDIA_PLAYLIST,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  orderVariants,
  publishMasterPlaylist,
  publishMediaPlaylist,
} from './playlist.ts';

export const DEFAULT_PUBLISH_INTERVAL_MS = 250;

export interface PublisherOptions {
  outDir: string;
  channel: string;
  logger: Logger;
  intervalMs?: number;
  /** Reads a segment's streams, to add the CODECS (HEVC) and FRAME-RATE ffmpeg leaves out. */
  probeStreams?: ProbeSegmentStreams;
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
      const dir = path.join(outDir, entry.name);
      await this.#publish(path.join(dir, FFMPEG_MEDIA_PLAYLIST), path.join(dir, MEDIA_PLAYLIST), publishMediaPlaylist);
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

  async #publish(from: string, to: string, transform: (source: string, previous: string | null) => string): Promise<void> {
    const source = await readIfExists(from);
    if (source === null || this.#published.get(from) === source) return;
    await writeAtomic(to, transform(source, await readIfExists(to)));
    this.#published.set(from, source);
  }
}
