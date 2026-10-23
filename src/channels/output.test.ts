import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

  it('keeps referenced live segments and sweeps orphans, temp files and retired variants', async () => {
    const outDir = path.join(root, 'ch');
    const variant = path.join(outDir, '720p');
    await touch(path.join(variant, 'index.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg_r1_00009.ts\n#EXTINF:4.0,\nseg_r2_00010.ts\n');
    await touch(path.join(variant, 'seg_00002.ts')); // named before run ids existed
    await touch(path.join(variant, 'seg_r1_00003.ts'));
    await touch(path.join(variant, 'seg_r1_00009.ts'));
    await touch(path.join(variant, 'seg_r2_00010.ts'));
    await touch(path.join(variant, 'seg_r2_00011.ts.tmp'));
    await touch(path.join(variant, 'init_1.mp4'));
    await touch(path.join(outDir, '1440p', 'index.m3u8'));
    await touch(path.join(outDir, 'master.m3u8'));

    await prepareOutputDir(outDir, ['720p', '360p'], 'live');

    assert.deepEqual((await readdir(outDir)).sort(), ['360p', '720p', 'master.m3u8']);
    assert.deepEqual((await readdir(variant)).sort(), ['index.m3u8', 'init_1.mp4', 'seg_r1_00009.ts', 'seg_r2_00010.ts']);
  });
});
