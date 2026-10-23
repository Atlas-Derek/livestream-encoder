import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { prepareOutputDir, removeStaleSlates, slateReady, sweepKeys, sweepVariantDir } from './output.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lse-output-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function touch(file: string, content = ''): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('prepareOutputDir', () => {
  it('wipes previous VOD output', async () => {
    const outDir = path.join(root, 'ch');
    await touch(path.join(outDir, '720p', 'seg_00000.ts'));
    await prepareOutputDir(outDir, ['1080p', '720p'], 'vod');
    assert.deepEqual((await readdir(outDir)).sort(), ['1080p', '720p']);
    assert.deepEqual(await readdir(path.join(outDir, '720p')), []);
  });

  it('keeps what either playlist references and sweeps orphans, temp files and retired variants', async () => {
    const outDir = path.join(root, 'ch');
    const variant = path.join(outDir, '720p');
    // ffmpeg only knows its current run's init section; the published playlist still needs run r1's.
    await touch(
      path.join(variant, 'ffmpeg.m3u8'),
      '#EXTM3U\n#EXT-X-MAP:URI="init_r2_720p.mp4"\n#EXTINF:4.0,\nseg_r1_00009.ts\n#EXTINF:4.0,\nseg_r2_00010.ts\n',
    );
    await touch(
      path.join(variant, 'index.m3u8'),
      '#EXTM3U\n#EXT-X-MAP:URI="init_r1_720p.mp4"\n#EXTINF:4.0,\nseg_r1_00009.ts\n' +
        '#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_r2_720p.mp4"\n#EXTINF:4.0,\nseg_r2_00010.ts\n',
    );
    await touch(path.join(variant, 'seg_00002.ts')); // named before run ids existed
    await touch(path.join(variant, 'seg_r1_00003.ts'));
    await touch(path.join(variant, 'seg_r1_00009.ts'));
    await touch(path.join(variant, 'seg_r2_00010.ts'));
    await touch(path.join(variant, 'seg_r2_00011.ts.tmp'));
    await touch(path.join(variant, 'index.m3u8.tmp'));
    await touch(path.join(variant, 'init_r0_720p.mp4'));
    await touch(path.join(variant, 'init_r1_720p.mp4'));
    await touch(path.join(variant, 'init_r2_720p.mp4'));
    await touch(path.join(variant, 'init_1.mp4'));
    await touch(path.join(outDir, '1440p', 'index.m3u8'));
    await touch(path.join(outDir, 'recordings', '20261023T160000Z', '720p', 'seg_r1_00003.ts'));
    await touch(path.join(outDir, 'master.m3u8'));

    await prepareOutputDir(outDir, ['720p', '360p'], 'live');

    assert.deepEqual((await readdir(outDir)).sort(), ['360p', '720p', 'master.m3u8', 'recordings']);
    assert.deepEqual((await readdir(variant)).sort(), [
      'ffmpeg.m3u8', 'index.m3u8', 'init_r1_720p.mp4', 'init_r2_720p.mp4', 'seg_r1_00009.ts', 'seg_r2_00010.ts',
    ]);
  });

  it('seeds ffmpeg.m3u8 from a playlist ffmpeg wrote as index.m3u8, so numbering carries on', async () => {
    const outDir = path.join(root, 'ch');
    const legacy = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:41\n#EXTINF:4.0,\nseg_00041.ts\n';
    await touch(path.join(outDir, '720p', 'index.m3u8'), legacy);
    await touch(path.join(outDir, '720p', 'seg_00041.ts'));
    await touch(path.join(outDir, '360p', 'index.m3u8'), 'published');
    await touch(path.join(outDir, '360p', 'ffmpeg.m3u8'), 'ffmpeg');

    await prepareOutputDir(outDir, ['720p', '360p'], 'live');

    assert.equal(await readFile(path.join(outDir, '720p', 'ffmpeg.m3u8'), 'utf8'), legacy);
    assert.ok((await readdir(path.join(outDir, '720p'))).includes('seg_00041.ts'));
    assert.equal(await readFile(path.join(outDir, '360p', 'ffmpeg.m3u8'), 'utf8'), 'ffmpeg', 'never overwritten');
  });
});

describe('sweepVariantDir', () => {
  it('keeps unreferenced segments a player may still be fetching, but never temp files', async () => {
    const variant = path.join(root, 'ch', '720p');
    await touch(path.join(variant, 'ffmpeg.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg_r1_00010.ts\n');
    await touch(path.join(variant, 'seg_r1_00010.ts'));
    await touch(path.join(variant, 'seg_r1_00009.ts'));
    await touch(path.join(variant, 'seg_r1_00008.ts'));
    await touch(path.join(variant, 'seg_r1_00011.ts.tmp'));
    const now = Date.now();
    const old = new Date(now - 60_000);
    await utimes(path.join(variant, 'seg_r1_00008.ts'), old, old);

    const removed = await sweepVariantDir(variant, 28_000, now);

    assert.deepEqual(removed.sort(), ['seg_r1_00008.ts', 'seg_r1_00011.ts.tmp']);
    assert.deepEqual((await readdir(variant)).sort(), ['ffmpeg.m3u8', 'seg_r1_00009.ts', 'seg_r1_00010.ts']);
  });
});

describe('slates', () => {
  it('knows when every variant has a slate, and removes other renders unless a player may still fetch them', async () => {
    const outDir = path.join(root, 'ch');
    await touch(path.join(outDir, '720p', 'slate.m3u8'), '#EXTM3U\nslate_new_000.ts\n');
    assert.equal(await slateReady(outDir, ['720p'], 'new'), true);
    assert.equal(await slateReady(outDir, ['720p'], 'other'), false);
    assert.equal(await slateReady(outDir, ['720p', '360p'], 'new'), false, 'a variant without one');

    await touch(path.join(outDir, '720p', 'index.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nslate_old_001.ts\n');
    for (const name of ['slate_new_000.ts', 'slate_old_000.ts', 'slate_old_001.ts', 'slate_old_init_720p.mp4', 'seg_r1_00001.ts']) {
      await touch(path.join(outDir, '720p', name));
    }
    await removeStaleSlates(outDir, ['720p'], 'new');
    assert.deepEqual((await readdir(path.join(outDir, '720p'))).sort(), [
      'index.m3u8', 'seg_r1_00001.ts', 'slate.m3u8', 'slate_new_000.ts', 'slate_old_001.ts',
    ]);
  });
});

describe('sweepKeys', () => {
  it('removes keys no playlist uses once they are old, and keeps new ones', async () => {
    const outDir = path.join(root, 'ch');
    await touch(path.join(outDir, '720p', 'index.m3u8'), '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key_r1.key",IV=0x1\n#EXTINF:4,\nseg_r1_00000.ts\n');
    await touch(path.join(outDir, '720p', 'ffmpeg.m3u8'), '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key_r2.key",IV=0x1\n');
    for (const name of ['key_r0.key', 'key_r1.key', 'key_r2.key', 'key_r3.key']) await touch(path.join(outDir, name));
    const now = Date.now();
    const old = new Date(now - 60_000);
    for (const name of ['key_r0.key', 'key_r1.key', 'key_r2.key']) await utimes(path.join(outDir, name), old, old);

    assert.deepEqual(await sweepKeys(outDir, ['720p'], 28_000, now), ['key_r0.key']);
    assert.deepEqual((await readdir(outDir)).filter((n) => n.endsWith('.key')).sort(), ['key_r1.key', 'key_r2.key', 'key_r3.key']);
  });
});
