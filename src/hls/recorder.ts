import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import {
  formatMediaPlaylist,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  parseMediaPlaylist,
  segmentDuration,
  type MediaPlaylist,
  type Segment,
} from './playlist.ts';

/**
 * Live-to-VOD recording. Each segment a live channel publishes from its source (not the slate) is hard-linked into
 * <channel>/recordings/<id>/<variant>/, so recording copies nothing and ffmpeg deleting its own copy doesn't matter.
 * While open, each variant's playlist is an EVENT playlist players can follow from the start; closed, it is VOD.
 * A recording closes when the source has been down for a segment (when the slate would start) or the channel stops;
 * the next segment from the source opens a new one.
 */
export const RECORDINGS_DIR = 'recordings';

/** 20261023T165802Z, with -2, -3… if one already started in that second. */
export const RECORDING_ID = /^\d{8}T\d{6}Z(?:-\d+)?$/;

const MAP_URI = /URI="([^"]+)"/;

export interface RecordingSummary {
  id: string;
  /** From the first segment's program date time, else the id. */
  startedAt: string;
  durationSec: number;
  /** Still being written: an EVENT playlist without EXT-X-ENDLIST. */
  open: boolean;
  variants: string[];
}

/** What the publisher needs from a recorder; tests pass a fake. */
export interface RecordingSink {
  record(variant: string, variantDir: string, header: string[], segments: Segment[]): Promise<void>;
  close(): Promise<void>;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

function errorCode(err: unknown): unknown {
  return err instanceof Error && 'code' in err ? err.code : undefined;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

/** A recording's variant playlist: EVENT while open, VOD with EXT-X-ENDLIST once closed. */
export function formatRecording(playlist: MediaPlaylist, closed: boolean): string {
  const longest = Math.max(1, ...playlist.segments.map(segmentDuration));
  const header = playlist.header.filter((line) => !/^#EXT-X-(TARGETDURATION|PLAYLIST-TYPE)/.test(line));
  const [first = '#EXTM3U', ...rest] = header;
  return formatMediaPlaylist({
    ...playlist,
    header: [first, ...rest, `#EXT-X-TARGETDURATION:${Math.round(longest)}`, `#EXT-X-PLAYLIST-TYPE:${closed ? 'VOD' : 'EVENT'}`],
    mediaSequence: 0,
    discontinuitySequence: 0,
    sourceSequence: null,
    trailer: closed ? ['#EXT-X-ENDLIST'] : [],
  });
}

function recordingId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export interface RecorderOptions {
  /** The channel's output directory. */
  outDir: string;
  channel: string;
  logger: Logger;
  onClose?: (recording: { id: string; durationSec: number }) => void;
}

interface OpenRecording {
  id: string;
  dir: string;
  playlists: Map<string, MediaPlaylist>;
  /** Init sections already linked, by path. */
  linked: Set<string>;
  /** Per variant: a segment was missed, so the next one starts with a discontinuity. */
  gaps: Set<string>;
}

export class Recorder implements RecordingSink {
  readonly #opts: RecorderOptions;
  #open: OpenRecording | null = null;
  #error: string | null = null;

  constructor(options: RecorderOptions) {
    this.#opts = options;
  }

  /** The recording being written, if any. */
  get current(): string | null {
    return this.#open?.id ?? null;
  }

  /** The last recording failure, until a segment is recorded again. */
  get error(): string | null {
    return this.#error;
  }

  /** Appends segments the publisher just published from the source, opening a recording if none is. */
  async record(variant: string, variantDir: string, header: string[], segments: Segment[]): Promise<void> {
    try {
      const recording = this.#open ?? (await this.#start());
      const dir = path.join(recording.dir, variant);
      await mkdir(dir, { recursive: true });
      const playlist = recording.playlists.get(variant) ?? {
        header, mediaSequence: 0, discontinuitySequence: 0, sourceSequence: null, segments: [], trailer: [],
      };
      for (const segment of segments) {
        const init = segment.map === null ? undefined : MAP_URI.exec(segment.map)?.[1];
        if (!(await this.#link(variantDir, dir, segment.uri))) {
          recording.gaps.add(variant); // ffmpeg already deleted it
          continue;
        }
        if (init !== undefined && !recording.linked.has(path.join(dir, init))) {
          await this.#link(variantDir, dir, init);
          recording.linked.add(path.join(dir, init));
        }
        const previous = playlist.segments.at(-1);
        const discontinuity =
          previous !== undefined && (recording.gaps.has(variant) || previous.runId !== segment.runId);
        recording.gaps.delete(variant);
        playlist.segments.push({ ...segment, seq: playlist.segments.length, discontinuity });
      }
      recording.playlists.set(variant, { ...playlist, header });
      await writeAtomic(path.join(dir, MEDIA_PLAYLIST), formatRecording(playlist, false));
      await this.#copyMaster(recording.dir);
      this.#error = null;
    } catch (err) {
      this.#fail(err);
    }
  }

  /** Turns the open recording into VOD. */
  async close(): Promise<void> {
    const recording = this.#open;
    if (recording === null) return;
    this.#open = null;
    try {
      for (const [variant, playlist] of recording.playlists) {
        await writeAtomic(path.join(recording.dir, variant, MEDIA_PLAYLIST), formatRecording(playlist, true));
      }
      await this.#copyMaster(recording.dir); // the published master may have gained CODECS since
      this.#opts.logger.info({ channel: this.#opts.channel, recording: recording.id }, 'recording closed');
      const [first] = recording.playlists.values();
      const seconds = first?.segments.reduce((sum, s) => sum + segmentDuration(s), 0) ?? 0;
      this.#opts.onClose?.({ id: recording.id, durationSec: Math.round(seconds * 1000) / 1000 });
    } catch (err) {
      this.#fail(err);
    }
  }

  async #start(): Promise<OpenRecording> {
    const root = path.join(this.#opts.outDir, RECORDINGS_DIR);
    await mkdir(root, { recursive: true });
    const base = recordingId(new Date());
    let id = base;
    for (let n = 2; ; n++) {
      try {
        await mkdir(path.join(root, id));
        break;
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') throw err;
        id = `${base}-${n}`;
      }
    }
    this.#open = { id, dir: path.join(root, id), playlists: new Map(), linked: new Set(), gaps: new Set() };
    this.#opts.logger.info({ channel: this.#opts.channel, recording: id }, 'recording started');
    return this.#open;
  }

  /** Hard-links a file into the recording. False if it is already gone. */
  async #link(fromDir: string, toDir: string, name: string): Promise<boolean> {
    try {
      await link(path.join(fromDir, name), path.join(toDir, name));
    } catch (err) {
      if (isMissing(err)) return false;
      if (errorCode(err) !== 'EEXIST') throw err;
    }
    return true;
  }

  async #copyMaster(recordingDir: string): Promise<void> {
    try {
      await copyFile(path.join(this.#opts.outDir, MASTER_PLAYLIST), path.join(recordingDir, `${MASTER_PLAYLIST}.tmp`));
      await rename(path.join(recordingDir, `${MASTER_PLAYLIST}.tmp`), path.join(recordingDir, MASTER_PLAYLIST));
    } catch (err) {
      if (!isMissing(err)) throw err; // not published yet: copied with a later segment or on close
    }
  }

  #fail(err: unknown): void {
    const message = `recording failed: ${err instanceof Error ? err.message : String(err)}`;
    if (message !== this.#error) this.#opts.logger.error({ channel: this.#opts.channel, err }, 'recording failed');
    this.#error = message;
  }
}

async function recordingIds(outDir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(outDir, RECORDINGS_DIR))).filter((name) => RECORDING_ID.test(name)).sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

async function variantDirs(recordingDir: string): Promise<string[]> {
  const entries = await readdir(recordingDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Closes recordings a crash or restart left open. Returns their ids. */
export async function finalizeRecordings(outDir: string, except: string | null = null): Promise<string[]> {
  const closed: string[] = [];
  for (const id of await recordingIds(outDir)) {
    if (id === except) continue;
    const dir = path.join(outDir, RECORDINGS_DIR, id);
    let any = false;
    for (const variant of await variantDirs(dir)) {
      const file = path.join(dir, variant, MEDIA_PLAYLIST);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }
      const playlist = parseMediaPlaylist(text);
      if (playlist.trailer.includes('#EXT-X-ENDLIST')) continue;
      await writeAtomic(file, formatRecording(playlist, true));
      any = true;
    }
    if (any) closed.push(id);
  }
  return closed;
}

export async function listRecordings(outDir: string): Promise<RecordingSummary[]> {
  const summaries: RecordingSummary[] = [];
  for (const id of await recordingIds(outDir)) {
    const dir = path.join(outDir, RECORDINGS_DIR, id);
    const variants = await variantDirs(dir);
    let durationSec = 0;
    let open = false;
    let startedAt: string | null = null;
    const [first] = variants;
    if (first !== undefined) {
      try {
        const playlist = parseMediaPlaylist(await readFile(path.join(dir, first, MEDIA_PLAYLIST), 'utf8'));
        durationSec = Math.round(playlist.segments.reduce((sum, s) => sum + segmentDuration(s), 0) * 1000) / 1000;
        open = !playlist.trailer.includes('#EXT-X-ENDLIST');
        const date = playlist.segments[0]?.tags.find((tag) => tag.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
        const time = date === undefined ? Number.NaN : Date.parse(date.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
        if (Number.isFinite(time)) startedAt = new Date(time).toISOString();
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
    const fromId = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
    summaries.push({
      id,
      startedAt: startedAt ?? (fromId ? `${fromId.slice(1, 4).join('-')}T${fromId.slice(4, 7).join(':')}.000Z` : id),
      durationSec,
      open,
      variants,
    });
  }
  return summaries;
}

export async function deleteRecording(outDir: string, id: string): Promise<boolean> {
  if (!RECORDING_ID.test(id)) return false;
  const dir = path.join(outDir, RECORDINGS_DIR, id);
  try {
    await readdir(dir);
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}
