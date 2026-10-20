import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ChannelSpec } from './schema.ts';

const SEGMENT_FILE = /^seg_\d+\.(ts|m4s)$/;

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function readPlaylistEntries(playlistPath: string): Promise<Set<string>> {
  try {
    const text = await readFile(playlistPath, 'utf8');
    return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')));
  } catch (err) {
    if (isMissing(err)) return new Set();
    throw err;
  }
}

/**
 * Removes ffmpeg's leftover temp files and any segment the variant playlist no longer references.
 * delete_segments only cleans up within one ffmpeg run, so restarts and crashes leave orphans behind.
 */
export async function sweepVariantDir(variantDir: string): Promise<string[]> {
  const referenced = await readPlaylistEntries(path.join(variantDir, 'index.m3u8'));
  const removed: string[] = [];
  for (const name of await readdir(variantDir)) {
    if (name.endsWith('.tmp') || (SEGMENT_FILE.test(name) && !referenced.has(name))) {
      await rm(path.join(variantDir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
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
    if (mode === 'live') await sweepVariantDir(variantDir);
  }
}

export async function removeOutputDir(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
}
