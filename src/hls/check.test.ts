import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkHls, decryptSegment, parseMasterPlaylist, resolveRef, type FirstVideoPacket, type Loader } from './check.ts';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  '1080p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  '360p/index.m3u8',
].join('\n');

function live(seq: number, names: string[], extra: string[] = []): string {
  return [
    '#EXTM3U', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${seq}`, ...extra,
    ...names.flatMap((name) => ['#EXTINF:4.000000,', name]),
  ].join('\n');
}

/** In-memory files; a segment's bytes are its own name, so the fake probe can look its packet up. */
function memory(files: Record<string, string>): Loader {
  const get = (ref: string): string => {
    const text = files[ref];
    if (text === undefined) throw new Error(`no such file: ${ref}`);
    return text;
  };
  return { text: async (ref) => get(ref), bytes: async (ref) => new TextEncoder().encode(get(ref)) };
}

function probeFrom(packets: Record<string, FirstVideoPacket>) {
  const seen: string[] = [];
  const probeSegment = async (data: Uint8Array): Promise<FirstVideoPacket | null> => {
    const key = new TextDecoder().decode(data);
    seen.push(key);
    return packets[key] ?? null;
  };
  return { probeSegment, seen };
}

const DISC = '#EXT-X-DISCONTINUITY-SEQUENCE:0';

describe('checkHls', () => {
  it('passes aligned variants that start every segment on a keyframe', async () => {
    const loader = memory({
      '/s/master.m3u8': MASTER,
      '/s/1080p/index.m3u8': live(5, ['a5', 'a6'], [DISC]),
      '/s/360p/index.m3u8': live(5, ['b5', 'b6'], [DISC]),
      '/s/1080p/a5': 'a5', '/s/1080p/a6': 'a6', '/s/360p/b5': 'b5', '/s/360p/b6': 'b6',
    });
    const { probeSegment } = probeFrom({
      a5: { ptsSec: 21.4, keyframe: true }, b5: { ptsSec: 21.4, keyframe: true },
      a6: { ptsSec: 25.4, keyframe: true }, b6: { ptsSec: 25.401, keyframe: true },
    });
    const report = await checkHls('/s/master.m3u8', { loader, probeSegment, segments: 3 });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.alignment.map((row) => row.seq), [5, 6]);
    assert.equal(report.variants[0]?.live, true);
  });

  it('reports misaligned starts, missing keyframes and only compares segments every variant has', async () => {
    const loader = memory({
      '/s/master.m3u8': MASTER,
      '/s/1080p/index.m3u8': live(5, ['a5', 'a6'], [DISC]),
      '/s/360p/index.m3u8': live(6, ['b6', 'b7'], [DISC]), // fetched one segment later
      '/s/1080p/a6': 'a6', '/s/360p/b6': 'b6',
    });
    const { probeSegment, seen } = probeFrom({ a6: { ptsSec: 25.4, keyframe: true }, b6: { ptsSec: 25.5, keyframe: false } });
    const { problems } = await checkHls('/s/master.m3u8', { loader, probeSegment, segments: 3 });
    assert.deepEqual(seen.sort(), ['a6', 'b6']);
    assert.deepEqual(problems, [
      'segment 6 of 360p/index.m3u8 does not start with a keyframe',
      'segment 6 starts at different times across variants: 25.400, 25.500',
    ]);
  });

  it('checks playlist rules: target duration, discontinuity sequence and discontinuity alignment', async () => {
    const long = live(0, ['a0'], []).replace('#EXTINF:4.000000,', '#EXTINF:4.600000,');
    const loader = memory({
      '/s/master.m3u8': MASTER,
      '/s/1080p/index.m3u8': long,
      '/s/360p/index.m3u8': live(0, ['b0'], ['#EXT-X-DISCONTINUITY-SEQUENCE:2', '#EXT-X-DISCONTINUITY']),
      '/s/1080p/a0': 'a0', '/s/360p/b0': 'b0',
    });
    const { problems } = await checkHls('/s/master.m3u8', { loader, probeSegment: async () => null, segments: 3 });
    assert.deepEqual(problems, [
      '1080p/index.m3u8: a0 lasts 4.6s, over the 4s target duration',
      '1080p/index.m3u8: live playlist without EXT-X-DISCONTINUITY-SEQUENCE',
      'variants at the same media sequence disagree on EXT-X-DISCONTINUITY-SEQUENCE',
      'segment 0: EXT-X-DISCONTINUITY in some variants only',
    ]);
  });

  it('prepends the init section to fMP4 segments and treats ENDLIST playlists as VOD', async () => {
    const vod = (name: string) =>
      ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4.0,', name, '#EXT-X-ENDLIST'].join('\n');
    const loader = memory({
      '/s/master.m3u8': MASTER,
      '/s/1080p/index.m3u8': vod('a0.m4s'), '/s/360p/index.m3u8': vod('b0.m4s'),
      '/s/1080p/init.mp4': 'INIT-A|', '/s/360p/init.mp4': 'INIT-B|', '/s/1080p/a0.m4s': 'a0', '/s/360p/b0.m4s': 'b0',
    });
    const { probeSegment, seen } = probeFrom({});
    const report = await checkHls('/s/master.m3u8', { loader, probeSegment, segments: 3 });
    assert.deepEqual(seen.sort(), ['INIT-A|a0', 'INIT-B|b0']);
    assert.equal(report.variants[0]?.live, false);
    assert.deepEqual(report.problems, []);
  });
});

describe('parseMasterPlaylist and resolveRef', () => {
  it('lists variant URIs and resolves them for URLs and paths', () => {
    assert.deepEqual(parseMasterPlaylist(MASTER), ['1080p/index.m3u8', '360p/index.m3u8']);
    assert.equal(resolveRef('http://localhost:8080/hls/a/master.m3u8', '720p/index.m3u8'), 'http://localhost:8080/hls/a/720p/index.m3u8');
    assert.equal(resolveRef('/var/hls/a/720p/index.m3u8', 'seg_r1_00001.ts'), '/var/hls/a/720p/seg_r1_00001.ts');
  });
});

describe('decryptSegment', () => {
  const key = Buffer.alloc(16, 7);
  const plain = Buffer.from('G'.repeat(188 * 3));
  const encrypt = (iv: Buffer) => {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    return new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final()]));
  };

  it('uses the tag\'s IV, or else the media sequence number', () => {
    const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const tag = '#EXT-X-KEY:METHOD=AES-128,URI="../key_r1.key",IV=0x000102030405060708090a0b0c0d0e0f';
    assert.deepEqual(Buffer.from(decryptSegment(encrypt(iv), key, { key: tag, seq: 99 })), plain);

    const bySeq = Buffer.alloc(16);
    bySeq.writeBigUInt64BE(42n, 8);
    assert.deepEqual(Buffer.from(decryptSegment(encrypt(bySeq), key, { key: '#EXT-X-KEY:METHOD=AES-128,URI="k"', seq: 42 })), plain);
  });
});
