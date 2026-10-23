import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { generateThumbnails, smallestRendition, thumbnailsVtt } from './thumbnails.ts';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=3144112,RESOLUTION=1280x720', '720p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=545199,RESOLUTION=426x240', '240p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=7815160,RESOLUTION=1920x1080', '1080p/index.m3u8', '',
].join('\n');

describe('thumbnailsVtt', () => {
  it('writes one cue per 2s, the last one cut to the duration, moving to the next sheet after 100', () => {
    const vtt = thumbnailsVtt('ab', 203.5, { width: 160, height: 90 });
    assert.ok(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nthumb_ab_000.jpg#xywh=0,0,160,90\n'));
    assert.match(vtt, /00:00:22\.000 --> 00:00:24\.000\nthumb_ab_000\.jpg#xywh=160,90,160,90\n/, 'the 12th: row 1, column 1');
    assert.match(vtt, /00:03:20\.000 --> 00:03:22\.000\nthumb_ab_001\.jpg#xywh=0,0,160,90\n/, 'the 101st starts sheet 1');
    assert.match(vtt, /00:03:22\.000 --> 00:03:23\.500\nthumb_ab_001\.jpg#xywh=160,0,160,90\n$/);
    assert.equal(vtt.match(/-->/g)?.length, 102);
  });

  it('has a cue only where ffmpeg made a thumbnail: the middle of its interval is in the video', () => {
    // A real 22.367s recording: ffmpeg made 11 thumbnails (the clock on them 2s apart), not 12.
    const vtt = thumbnailsVtt('ab', 22.367, { width: 160, height: 90 });
    assert.equal(vtt.match(/-->/g)?.length, 11);
    assert.match(vtt, /00:00:20\.000 --> 00:00:22\.367\nthumb_ab_000\.jpg#xywh=0,90,160,90\n$/, 'the last runs to the end');
    assert.equal(thumbnailsVtt('ab', 0.4, { width: 160, height: 90 }).match(/-->/g)?.length, 1);
    assert.equal(thumbnailsVtt('ab', 0, { width: 160, height: 90 }), 'WEBVTT\n');
  });
});

describe('smallestRendition', () => {
  it('picks the rendition with the fewest pixels', () => {
    assert.deepEqual(smallestRendition(MASTER), { uri: '240p/index.m3u8', width: 426, height: 240 });
    assert.equal(smallestRendition('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na/index.m3u8\n'), null);
  });
});

describe('generateThumbnails', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lse-thumbs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders from the smallest rendition, writes the track, and removes an earlier render\'s sheets', async () => {
    await writeFile(path.join(dir, 'master.m3u8'), MASTER);
    await mkdir(path.join(dir, '240p'));
    await writeFile(path.join(dir, '240p', 'index.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg_r_00000.ts\n#EXTINF:2.0,\nseg_r_00001.ts\n#EXT-X-ENDLIST\n');
    await writeFile(path.join(dir, 'thumb_old_000.jpg'), '');
    const runs: string[][] = [];
    await generateThumbnails(dir, async (args) => {
      runs.push(args);
      await writeFile((args.at(-1) ?? '').replace('%03d', '000'), 'jpeg');
    });

    const [args] = runs;
    assert.equal(args?.[args.indexOf('-i') + 1], path.join(dir, '240p', 'index.m3u8'));
    assert.match(args?.[args.indexOf('-vf') + 1] ?? '', /scale=160:90,tile=10x10$/);
    const vtt = await readFile(path.join(dir, 'thumbnails.vtt'), 'utf8');
    assert.equal(vtt.match(/-->/g)?.length, 3, '6s of video');
    const sheets = (await readdir(dir)).filter((name) => name.startsWith('thumb_'));
    assert.equal(sheets.length, 1);
    assert.ok(vtt.includes(`${sheets[0]}#xywh=0,0,160,90`));
  });
});
