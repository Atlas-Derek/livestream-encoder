import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { prepareOutputDir } from './output.ts';

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
    await touch(path.join(outDir, 'master.m3u8'));

    await prepareOutputDir(outDir, ['720p', '360p'], 'live');

    assert.deepEqual((await readdir(outDir)).sort(), ['360p', '720p', 'master.m3u8']);
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
