import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG_MEDIA_PLAYLIST, MEDIA_PLAYLIST, playlistReferences, SLATE_PLAYLIST } from '../hls/playlist.ts';
import type { ChannelSpec } from './schema.ts';

// seg_<runId>_<n>; plain seg_<n> is the naming used before run ids, still swept from existing output.
const SEGMENT_FILE = /^seg_(?:[a-z0-9]+_)?\d+\.(ts|m4s)$/;
// fMP4 init sections: init_<runId>_<variant>.mp4, or init_<n>.mp4 from before run ids.
const INIT_FILE = /^init_[A-Za-z0-9_-]+\.mp4$/;
// Slate segments and init sections, slate_<slateId>_…; the sweep leaves them, removeStaleSlates handles them.
const SLATE_FILE = /^slate_([a-z0-9]+)_/;

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function readReferences(playlistPath: string): Promise<Set<string>> {
  try {
    return playlistReferences(await readFile(playlistPath, 'utf8'));
  } catch (err) {
    if (isMissing(err)) return new Set();
    throw err;
  }
}

/**
 * Removes leftover temp files and any segment or init section that neither ffmpeg's playlist nor the published one
 * references. delete_segments only cleans up within one ffmpeg run, so restarts and crashes leave orphans behind,
 * and only the published playlist knows which earlier runs' init sections are still needed.
 * Unreferenced files modified within retainMs are kept: a player may still hold a playlist listing them
 * (RFC 8216 6.2.2). The next run's sweep removes them.
 */
export async function sweepVariantDir(variantDir: string, retainMs = 0, now = Date.now()): Promise<string[]> {
  const referenced = new Set([
    ...(await readReferences(path.join(variantDir, FFMPEG_MEDIA_PLAYLIST))),
    ...(await readReferences(path.join(variantDir, MEDIA_PLAYLIST))),
  ]);
  const removed: string[] = [];
  for (const name of await readdir(variantDir)) {
    const file = path.join(variantDir, name);
    const media = SEGMENT_FILE.test(name) || INIT_FILE.test(name);
    if (name.endsWith('.tmp') || (media && !referenced.has(name) && !(await modifiedWithin(file, retainMs, now)))) {
      await rm(file, { force: true });
      removed.push(name);
    }
  }
  return removed;
}

async function modifiedWithin(file: string, ms: number, now: number): Promise<boolean> {
  if (ms <= 0) return false;
  try {
    return now - (await stat(file)).mtimeMs < ms;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Output written before live playlists were published had ffmpeg write index.m3u8 itself. Seed ffmpeg's playlist
 * from it so append_list carries on the numbering players have already seen instead of restarting at 0.
 */
async function adoptLegacyPlaylist(variantDir: string): Promise<void> {
  try {
    await copyFile(path.join(variantDir, MEDIA_PLAYLIST), path.join(variantDir, FFMPEG_MEDIA_PLAYLIST), constants.COPYFILE_EXCL);
  } catch (err) {
    if (isMissing(err) || (err instanceof Error && 'code' in err && err.code === 'EEXIST')) return;
    throw err;
  }
}

/**
 * Gets a channel's output directory ready for an ffmpeg run.
 * VOD starts from scratch. Live keeps the existing playlists so append_list can continue them,
 * but drops variant directories that are no longer in the ladder. retainMs: see sweepVariantDir.
 */
export async function prepareOutputDir(
  outDir: string,
  variants: string[],
  mode: ChannelSpec['mode'],
  retainMs = 0,
): Promise<void> {
  if (mode === 'vod') await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  if (mode === 'live') {
    for (const entry of await readdir(outDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !variants.includes(entry.name)) {
        await rm(path.join(outDir, entry.name), { recursive: true, force: true });
      }
    }
  }
  for (const variant of variants) {
    const variantDir = path.join(outDir, variant);
    await mkdir(variantDir, { recursive: true });
    if (mode === 'live') {
      await adoptLegacyPlaylist(variantDir);
      await sweepVariantDir(variantDir, retainMs);
    }
  }
}

/** Whether every variant already has slate `id` rendered (see buildSlateArgs). */
export async function slateReady(outDir: string, variants: string[], id: string): Promise<boolean> {
  for (const variant of variants) {
    try {
      if (!(await readFile(path.join(outDir, variant, SLATE_PLAYLIST), 'utf8')).includes(`slate_${id}_`)) return false;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }
  return true;
}

/** Removes other renders' slate files, except those the published playlist still lists (a player may fetch them). */
export async function removeStaleSlates(outDir: string, variants: string[], id: string): Promise<void> {
  for (const variant of variants) {
    const dir = path.join(outDir, variant);
    const referenced = await readReferences(path.join(dir, MEDIA_PLAYLIST));
    for (const name of await readdir(dir)) {
      const slate = SLATE_FILE.exec(name)?.[1];
      if (slate !== undefined && slate !== id && !referenced.has(name)) await rm(path.join(dir, name), { force: true });
    }
  }
}

/**
 * Where a VOD encode is written: beside the served directory, swapped in by publishVodOutput when complete, so a
 * rebuild never takes the previous output away mid-encode or serves a master whose variant playlists don't exist yet
 * (ffmpeg writes VOD media playlists only when it finishes). Channel ids can't start with a dot, so this can't collide.
 */
export function vodStagingDir(outDir: string): string {
  return path.join(path.dirname(outDir), `.building-${path.basename(outDir)}`);
}

/** Replaces outDir with a finished VOD encode. The served directory is missing only between two renames. */
export async function publishVodOutput(stagingDir: string, outDir: string): Promise<void> {
  const previous = path.join(path.dirname(outDir), `.previous-${path.basename(outDir)}`);
  await rm(previous, { recursive: true, force: true });
  try {
    await rename(outDir, previous);
  } catch (err) {
    if (!isMissing(err)) throw err; // first encode
  }
  await rename(stagingDir, outDir);
  await rm(previous, { recursive: true, force: true });
}

export async function removeOutputDir(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await rm(vodStagingDir(outDir), { recursive: true, force: true });
}
