import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG_MEDIA_PLAYLIST, MEDIA_PLAYLIST, playlistReferences } from '../hls/playlist.ts';
import type { ChannelSpec } from './schema.ts';

// seg_<runId>_<n>; plain seg_<n> is the naming used before run ids, still swept from existing output.
const SEGMENT_FILE = /^seg_(?:[a-z0-9]+_)?\d+\.(ts|m4s)$/;
// fMP4 init sections: init_<runId>_<variant>.mp4, or init_<n>.mp4 from before run ids.
const INIT_FILE = /^init_[A-Za-z0-9_-]+\.mp4$/;

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
 */
export async function sweepVariantDir(variantDir: string): Promise<string[]> {
  const referenced = new Set([
    ...(await readReferences(path.join(variantDir, FFMPEG_MEDIA_PLAYLIST))),
    ...(await readReferences(path.join(variantDir, MEDIA_PLAYLIST))),
  ]);
  const removed: string[] = [];
  for (const name of await readdir(variantDir)) {
    const media = SEGMENT_FILE.test(name) || INIT_FILE.test(name);
    if (name.endsWith('.tmp') || (media && !referenced.has(name))) {
      await rm(path.join(variantDir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
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
 * but drops variant directories that are no longer in the ladder.
 */
export async function prepareOutputDir(outDir: string, variants: string[], mode: ChannelSpec['mode']): Promise<void> {
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
      await sweepVariantDir(variantDir);
    }
  }
}

export async function removeOutputDir(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
}
