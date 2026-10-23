import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  audioCodecString,
  avcCodecString,
  codecsFromProbe,
  fillMissingCodecs,
  hevcCodecString,
  parseHexdump,
} from './codecs.ts';

// ffprobe 9 -show_data output for media/test/hevc.mp4 (x265 Main, level 4): an hvcC record.
const HVCC_DUMP = '\n00000000: 0101 6000 0000 9000 0000 0000 78f0 00fc  ..`.........x...\n';
// The same stream in an MPEG-TS segment: Annex B VPS then SPS, with emulation-prevention bytes (00 00 03).
const ANNEXB_DUMP = [
  '00000000: 0000 0001 4001 0c01 ffff 0160 0000 0300  ....@......`....',
  '00000010: 9000 0003 0000 0300 7895 9809 0000 0000  ........x.......',
  '00000020: 0142 0101 0160 0000 0300 9000 0003 0000  .B...`..........',
  '00000030: 0300 78a0 03c0 8010 e596 5669 24ca f016  ..x.......Vi$...',
].join('\n');

describe('codec strings', () => {
  it('reads ffprobe hexdumps', () => {
    assert.deepEqual([...parseHexdump(HVCC_DUMP).subarray(0, 4)], [0x01, 0x01, 0x60, 0x00]);
    assert.equal(parseHexdump(ANNEXB_DUMP).length, 64);
  });

  it('builds the HEVC string from hvcC and from an Annex B SPS alike', () => {
    assert.equal(hevcCodecString(parseHexdump(HVCC_DUMP), 'hvc1'), 'hvc1.1.6.L120.90');
    assert.equal(hevcCodecString(parseHexdump(ANNEXB_DUMP), 'hev1'), 'hev1.1.6.L120.90');
  });

  it('encodes Main 10, high tier and profile space', () => {
    // hvcC: space 0, high tier, profile 2; compatibility 0x20000000; constraints B0; level 153.
    const main10High = Uint8Array.from([1, 0x22, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 153]);
    assert.equal(hevcCodecString(main10High, 'hvc1'), 'hvc1.2.4.H153.B0');
    const spaceA = Uint8Array.from([1, 0x41, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 93]);
    assert.equal(hevcCodecString(spaceA, 'hvc1'), 'hvc1.A1.6.L93');
  });

  it('builds the H.264 string from avcC and from an Annex B SPS', () => {
    assert.equal(avcCodecString(Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff])), 'avc1.640028');
    assert.equal(avcCodecString(Uint8Array.from([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0x9a])), 'avc1.4d401f');
    assert.equal(avcCodecString(Uint8Array.from([])), null);
  });

  it('maps audio codecs, and refuses ones it does not know', () => {
    assert.equal(audioCodecString('aac', 'LC'), 'mp4a.40.2');
    assert.equal(audioCodecString('aac', 'HE-AACv2'), 'mp4a.40.29');
    assert.equal(audioCodecString('eac3', null), 'ec-3');
    assert.equal(audioCodecString('opus', null), null);
  });

  it('combines video and audio, and gives up rather than guess', () => {
    const video = { codec_type: 'video', codec_name: 'hevc', codec_tag_string: 'hvc1', extradata: HVCC_DUMP };
    const audio = { codec_type: 'audio', codec_name: 'aac', profile: 'LC' };
    assert.equal(codecsFromProbe({ streams: [video, audio] }), 'hvc1.1.6.L120.90,mp4a.40.2');
    assert.equal(codecsFromProbe({ streams: [video, { ...audio, codec_name: 'opus' }] }), null);
    assert.equal(codecsFromProbe({ streams: [{ ...video, codec_name: 'av1' }] }), null);
  });
});

describe('fillMissingCodecs', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'lse-codecs-'));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const master = (codecs = '') =>
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080${codecs}\nsource/index.m3u8\n`;
  const hevc = { streams: [{ codec_type: 'video', codec_name: 'hevc', codec_tag_string: 'hvc1', extradata: HVCC_DUMP }] };

  it('adds CODECS from the first segment, with its init section', async () => {
    await mkdir(path.join(outDir, 'source'));
    await writeFile(
      path.join(outDir, 'source', 'index.m3u8'),
      '#EXTM3U\n#EXT-X-MAP:URI="init_r1.mp4"\n#EXTINF:4.0,\nseg_r1_00000.m4s\n#EXTINF:4.0,\nseg_r1_00001.m4s\n',
    );
    const calls: Array<[string, string | null]> = [];
    const filled = await fillMissingCodecs(master(), outDir, async (segment, init) => {
      calls.push([path.relative(outDir, segment), init === null ? null : path.relative(outDir, init)]);
      return hevc;
    });
    assert.deepEqual(calls, [['source/seg_r1_00000.m4s', 'source/init_r1.mp4']]);
    assert.equal(filled.text, master(',CODECS="hvc1.1.6.L120.90"'));
    assert.deepEqual([filled.complete, filled.errors], [true, []]);
  });

  it('leaves variants that already have CODECS alone, and waits for live variants without segments', async () => {
    const untouched = await fillMissingCodecs(master(',CODECS="avc1.640028"'), outDir, async () => assert.fail('no probe'));
    assert.equal(untouched.text, master(',CODECS="avc1.640028"'));

    const notYet = await fillMissingCodecs(master(), outDir, async () => hevc); // no variant playlist yet
    assert.deepEqual([notYet.text, notYet.complete, notYet.errors], [master(), false, []]);
  });

  it('reports a variant it cannot read instead of writing a guess', async () => {
    await mkdir(path.join(outDir, 'source'));
    await writeFile(path.join(outDir, 'source', 'index.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg_r1_00000.ts\n');
    const filled = await fillMissingCodecs(master(), outDir, async () => {
      throw new Error('ffprobe failed');
    });
    assert.deepEqual([filled.text, filled.complete, filled.errors], [master(), true, ['source/index.m3u8: ffprobe failed']]);
  });
});
