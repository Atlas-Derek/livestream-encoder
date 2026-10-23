import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildThumbnailArgs, THUMBNAIL_GRID, THUMBNAIL_INTERVAL_SECONDS, thumbnailSize } from '../ffmpeg/buildArgs.ts';
import { MASTER_PLAYLIST, parseMediaPlaylist, segmentDuration } from './playlist.ts';

/**
 * Seek thumbnails for VOD output and recordings: sprite sheets and a WebVTT track whose cues point into them
 * (thumb_<id>_000.jpg#xywh=x,y,w,h), as video.js, Shaka, JW Player and most hls.js players show on the seek bar.
 * Live windows have none: where a cue lands on a sliding window's timeline depends on the player.
 */
export const THUMBNAILS_VTT = 'thumbnails.vtt';

const THUMB_FILE = /^thumb_([a-z0-9]+)_\d+\.jpg$/;

function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/**
 * Pure: the WebVTT track for durationSec of video, one cue per thumbnail. ffmpeg takes each thumbnail from the middle
 * of its interval, so there is one only for intervals whose middle is in the video (a 22.4s recording got 11, not 12);
 * the last cue runs to the end.
 */
export function thumbnailsVtt(id: string, durationSec: number, size: { width: number; height: number }): string {
  const lines = ['WEBVTT', ''];
  const perSheet = THUMBNAIL_GRID * THUMBNAIL_GRID;
  const count = durationSec > 0 ? Math.max(1, Math.floor(durationSec / THUMBNAIL_INTERVAL_SECONDS + 0.5)) : 0;
  for (let i = 0; i < count; i++) {
    const start = i * THUMBNAIL_INTERVAL_SECONDS;
    const end = i === count - 1 ? durationSec : start + THUMBNAIL_INTERVAL_SECONDS;
    const cell = i % perSheet;
    const x = (cell % THUMBNAIL_GRID) * size.width;
    const y = Math.floor(cell / THUMBNAIL_GRID) * size.height;
    const sheet = `thumb_${id}_${String(Math.floor(i / perSheet)).padStart(3, '0')}.jpg`;
    lines.push(`${timestamp(start)} --> ${timestamp(end)}`, `${sheet}#xywh=${x},${y},${size.width},${size.height}`, '');
  }
  return lines.join('\n');
}

/** The smallest rendition in a master playlist (cheapest to decode): its URI and RESOLUTION. */
export function smallestRendition(master: string): { uri: string; width: number; height: number } | null {
  const lines = master.split('\n').map((line) => line.trim());
  let best: { uri: string; width: number; height: number } | null = null;
  lines.forEach((line, i) => {
    const resolution = line.startsWith('#EXT-X-STREAM-INF:') ? /RESOLUTION=(\d+)x(\d+)/.exec(line) : null;
    const uri = lines.slice(i + 1).find((next) => next !== '' && !next.startsWith('#'));
    if (resolution === null || uri === undefined) return;
    const width = Number(resolution[1]);
    const height = Number(resolution[2]);
    if (best === null || width * height < best.width * best.height) best = { uri, width, height };
  });
  return best;
}

/**
 * Renders thumbnails for the finished output in dir (a VOD or a recording, with its master.m3u8), writes
 * thumbnails.vtt, and removes an earlier render's sheets. `run` runs ffmpeg once with the given arguments.
 */
export async function generateThumbnails(dir: string, run: (args: string[]) => Promise<unknown>): Promise<void> {
  const rendition = smallestRendition(await readFile(path.join(dir, MASTER_PLAYLIST), 'utf8'));
  if (rendition === null) throw new Error('no rendition with a RESOLUTION in the master playlist');
  const playlist = path.join(dir, rendition.uri);
  const durationSec = parseMediaPlaylist(await readFile(playlist, 'utf8')).segments.reduce((sum, s) => sum + segmentDuration(s), 0);
  const size = thumbnailSize(rendition.width, rendition.height);
  // New names each time: sheets are cached for a day, and a rebuilt VOD's must not be mistaken for the old ones.
  const id = Date.now().toString(36);
  await run(buildThumbnailArgs({ playlist, outDir: dir, id, size }));
  await writeFile(path.join(dir, `${THUMBNAILS_VTT}.tmp`), thumbnailsVtt(id, durationSec, size));
  await rename(path.join(dir, `${THUMBNAILS_VTT}.tmp`), path.join(dir, THUMBNAILS_VTT));
  for (const name of await readdir(dir)) {
    const sheet = THUMB_FILE.exec(name)?.[1];
    if (sheet !== undefined && sheet !== id) await rm(path.join(dir, name), { force: true });
  }
}
