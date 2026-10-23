import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { silentLogger } from '../log.ts';
import { parseMediaPlaylist, type Segment } from './playlist.ts';
import { deleteRecording, finalizeRecordings, listRecordings, Recorder, RECORDING_ID } from './recorder.ts';

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'lse-recorder-'));
  await mkdir(path.join(outDir, '720p'));
  await writeFile(path.join(outDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/index.m3u8\n');
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const HEADER = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4'];

/** A published segment whose file exists in the variant directory. */
async function segment(uri: string, runId = 'r1', map: string | null = null): Promise<Segment> {
  await writeFile(path.join(outDir, '720p', uri), uri);
  return {
    seq: 0, uri, runId, discontinuity: false, map, key: null,
    tags: ['#EXTINF:4.000000,', '#EXT-X-PROGRAM-DATE-TIME:2026-10-23T16:00:00.000Z'],
  };
}

const variantDir = () => path.join(outDir, '720p');
const recordingDir = (id: string) => path.join(outDir, 'recordings', id);

describe('Recorder', () => {
  it('hard-links segments into an EVENT recording, and turns it into VOD when closed', async () => {
    const recorder = new Recorder({ outDir, channel: 'ch', logger: silentLogger });
    assert.equal(recorder.current, null);
    await recorder.record('720p', variantDir(), HEADER, [await segment('seg_r1_00000.ts'), await segment('seg_r1_00001.ts')]);
    const id = recorder.current ?? assert.fail('open');
    assert.match(id, RECORDING_ID);

    const file = path.join(recordingDir(id), '720p', 'seg_r1_00000.ts');
    assert.equal((await stat(file)).ino, (await stat(path.join(variantDir(), 'seg_r1_00000.ts'))).ino, 'a link, not a copy');
    await rm(path.join(variantDir(), 'seg_r1_00000.ts')); // ffmpeg deleting its copy
    assert.equal(await readFile(file, 'utf8'), 'seg_r1_00000.ts');

    const open = await readFile(path.join(recordingDir(id), '720p', 'index.m3u8'), 'utf8');
    assert.match(open, /#EXT-X-PLAYLIST-TYPE:EVENT/);
    assert.doesNotMatch(open, /ENDLIST/);
    assert.equal(await readFile(path.join(recordingDir(id), 'master.m3u8'), 'utf8'), await readFile(path.join(outDir, 'master.m3u8'), 'utf8'));

    await recorder.close();
    assert.equal(recorder.current, null);
    const closed = await readFile(path.join(recordingDir(id), '720p', 'index.m3u8'), 'utf8');
    assert.match(closed, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(closed, /#EXT-X-ENDLIST\n$/);
    assert.deepEqual(parseMediaPlaylist(closed).segments.map((s) => s.uri), ['seg_r1_00000.ts', 'seg_r1_00001.ts']);

    await recorder.record('720p', variantDir(), HEADER, [await segment('seg_r2_00002.ts', 'r2')]);
    assert.notEqual(recorder.current, id, 'the next segment opens a new recording');
  });

  it('marks run changes and missed segments with a discontinuity, and links each init section', async () => {
    const recorder = new Recorder({ outDir, channel: 'ch', logger: silentLogger });
    await writeFile(path.join(variantDir(), 'init_r1_720p.mp4'), 'init');
    const map = '#EXT-X-MAP:URI="init_r1_720p.mp4"';
    const gone: Segment = { ...(await segment('seg_r1_00001.m4s', 'r1', map)) };
    await rm(path.join(variantDir(), 'seg_r1_00001.m4s'));
    await recorder.record('720p', variantDir(), HEADER, [
      await segment('seg_r1_00000.m4s', 'r1', map), gone, await segment('seg_r1_00002.m4s', 'r1', map),
      await segment('seg_r2_00003.m4s', 'r2'),
    ]);
    const dir = path.join(recordingDir(recorder.current ?? ''), '720p');
    const recorded = parseMediaPlaylist(await readFile(path.join(dir, 'index.m3u8'), 'utf8')).segments;
    assert.deepEqual(recorded.map((s) => [s.uri, s.discontinuity]), [
      ['seg_r1_00000.m4s', false], ['seg_r1_00002.m4s', true], ['seg_r2_00003.m4s', true],
    ]);
    assert.ok((await readdir(dir)).includes('init_r1_720p.mp4'));
    assert.equal(recorder.error, null);
  });

  it('links the key into the recording\'s root, where the same relative URI finds it', async () => {
    const recorder = new Recorder({ outDir, channel: 'ch', logger: silentLogger });
    await writeFile(path.join(outDir, 'key_r1.key'), 'k'.repeat(16));
    const key = '#EXT-X-KEY:METHOD=AES-128,URI="../key_r1.key",IV=0x01';
    await recorder.record('720p', variantDir(), HEADER, [{ ...(await segment('seg_r1_00000.ts')), key }]);
    const dir = recordingDir(recorder.current ?? '');
    assert.equal(await readFile(path.join(dir, 'key_r1.key'), 'utf8'), 'k'.repeat(16));
    assert.match(await readFile(path.join(dir, '720p', 'index.m3u8'), 'utf8'), /#EXT-X-KEY:METHOD=AES-128,URI="\.\.\/key_r1\.key"/);

    await recorder.record('720p', variantDir(), HEADER, [{ ...(await segment('seg_r1_00001.ts')), key: '#EXT-X-KEY:METHOD=AES-128,URI="../../x.key"' }]);
    assert.match(recorder.error ?? '', /refusing to record \.\.\/\.\.\/x\.key/);
  });
});

describe('recordings on disk', () => {
  it('closes recordings left open, lists them, and deletes only real recording ids', async () => {
    const recorder = new Recorder({ outDir, channel: 'ch', logger: silentLogger });
    await recorder.record('720p', variantDir(), HEADER, [await segment('seg_r1_00000.ts'), await segment('seg_r1_00001.ts')]);
    const id = recorder.current ?? assert.fail('open');

    assert.deepEqual(
      (await listRecordings(outDir)).map((r) => [r.id, r.open, r.durationSec, r.startedAt, r.variants]),
      [[id, true, 8, '2026-10-23T16:00:00.000Z', ['720p']]],
    );
    assert.deepEqual(await finalizeRecordings(outDir), [id], 'as after a crash');
    assert.equal((await listRecordings(outDir))[0]?.open, false);
    assert.deepEqual(await finalizeRecordings(outDir), [], 'nothing left open');

    assert.equal(await deleteRecording(outDir, '../720p'), false);
    assert.equal(await deleteRecording(outDir, '20200101T000000Z'), false);
    assert.equal(await deleteRecording(outDir, id), true);
    assert.deepEqual(await listRecordings(outDir), []);
    assert.ok((await readdir(variantDir())).includes('seg_r1_00000.ts'), 'the live output is untouched');
  });
});
