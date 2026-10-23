import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendSlateSegment,
  longestSegmentOfLastRun,
  orderVariants,
  parseMediaPlaylist,
  playlistReferences,
  publishMasterPlaylist,
  publishMediaPlaylist,
} from './playlist.ts';

function playlist(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const HEADER = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4'];

/** Segment lines as ffmpeg writes them: EXTINF, then PROGRAM-DATE-TIME, then the URI. */
function seg(uri: string): string[] {
  return ['#EXTINF:4.000000,', '#EXT-X-PROGRAM-DATE-TIME:2026-10-23T10:00:00.000-0600', uri];
}

/** Only the tags this module rewrites, plus URIs. */
function skeleton(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#EXTINF') && !line.startsWith('#EXT-X-PROGRAM') && !line.startsWith('## '));
}

const uris = (text: string) => parseMediaPlaylist(text).segments.map((s) => s.uri);

describe('publishMediaPlaylist', () => {
  it('marks run boundaries from segment names and starts at discontinuity sequence 0', () => {
    const source = playlist([
      ...HEADER, '#EXT-X-MEDIA-SEQUENCE:3', '#EXT-X-INDEPENDENT-SEGMENTS',
      ...seg('seg_r1_00003.ts'), '#EXT-X-DISCONTINUITY', ...seg('seg_r2_00004.ts'), ...seg('seg_r2_00005.ts'),
    ]);
    assert.deepEqual(skeleton(publishMediaPlaylist(source, null, 6)), [
      '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA-SEQUENCE:3', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      'seg_r1_00003.ts', '#EXT-X-DISCONTINUITY', 'seg_r2_00004.ts', 'seg_r2_00005.ts',
    ]);
  });

  it('keeps the tag on the first segment until it leaves, then counts it in the discontinuity sequence', () => {
    const v1 = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:4', ...seg('seg_r1_00004.ts'), '#EXT-X-DISCONTINUITY', ...seg('seg_r2_00005.ts')]),
      null,
      2,
    );
    // ffmpeg's playlist after the r1 segment slid out: its predecessor is gone, but the tag must stay.
    const v2 = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:5', ...seg('seg_r2_00005.ts'), ...seg('seg_r2_00006.ts')]),
      v1,
      2,
    );
    assert.deepEqual(skeleton(v2).slice(3), [
      '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-DISCONTINUITY', 'seg_r2_00005.ts', 'seg_r2_00006.ts',
    ]);

    const v3 = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:6', ...seg('seg_r2_00006.ts'), ...seg('seg_r2_00007.ts')]),
      v2,
      2,
    );
    assert.deepEqual(skeleton(v3).slice(3), [
      '#EXT-X-MEDIA-SEQUENCE:6', '#EXT-X-DISCONTINUITY-SEQUENCE:1', 'seg_r2_00006.ts', 'seg_r2_00007.ts',
    ]);
  });

  it('accumulates the discontinuity sequence across several restarts', () => {
    let published: string | null = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:0', ...seg('seg_a_00000.ts'), ...seg('seg_b_00001.ts'), ...seg('seg_c_00002.ts')]),
      null,
      6,
    );
    published = publishMediaPlaylist(playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:3', ...seg('seg_c_00003.ts')]), published, 1);
    assert.equal(parseMediaPlaylist(published).discontinuitySequence, 2);
  });

  it('gives each run its own init section, which ffmpeg does not (real ffmpeg 9 output)', () => {
    // Run r1 as published, then ffmpeg's playlist after run r2 appended to it: one EXT-X-MAP, for r2, at the top,
    // and a stray EXT-X-DISCONTINUITY before the very first segment.
    const r1 = publishMediaPlaylist(
      playlist([
        '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init_r1_a.mp4"',
        '#EXTINF:1.000000,', 'seg_r1_00000.m4s', '#EXTINF:1.000000,', 'seg_r1_00001.m4s',
      ]),
      null,
      6,
    );
    const ffmpeg = playlist([
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init_r2_a.mp4"',
      '#EXT-X-DISCONTINUITY', '#EXTINF:1.000000,', 'seg_r1_00000.m4s', '#EXTINF:1.000000,', 'seg_r1_00001.m4s',
      '#EXT-X-DISCONTINUITY', '#EXTINF:1.000000,', 'seg_r2_00002.m4s', '#EXTINF:1.000000,', 'seg_r2_00003.m4s',
    ]);
    assert.deepEqual(skeleton(publishMediaPlaylist(ffmpeg, r1, 6)), [
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-MAP:URI="init_r1_a.mp4"', 'seg_r1_00000.m4s', 'seg_r1_00001.m4s',
      '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="init_r2_a.mp4"', 'seg_r2_00002.m4s', 'seg_r2_00003.m4s',
    ]);
  });

  it('trusts ffmpeg’s own tags for segments named before run ids', () => {
    const source = playlist([
      ...HEADER, '#EXT-X-MEDIA-SEQUENCE:7', ...seg('seg_00007.ts'), '#EXT-X-DISCONTINUITY', ...seg('seg_00008.ts'), ...seg('seg_00009.ts'),
    ]);
    assert.deepEqual(skeleton(publishMediaPlaylist(source, null, 6)).slice(-4), [
      'seg_00007.ts', '#EXT-X-DISCONTINUITY', 'seg_00008.ts', 'seg_00009.ts',
    ]);
  });

  it('keeps per-segment tags with their segment', () => {
    const source = playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:1', ...seg('seg_r1_00001.ts')]);
    assert.ok(publishMediaPlaylist(source, null, 6).endsWith(`${seg('seg_r1_00001.ts').join('\n')}\n`));
  });
});

describe('publishing as an append log', () => {
  /** ffmpeg's playlist for a window of segment numbers in run r1. */
  const ffmpeg = (from: number, to: number, run = 'r1') =>
    playlist([
      ...HEADER, `#EXT-X-MEDIA-SEQUENCE:${from}`,
      ...Array.from({ length: to - from + 1 }, (_, i) => seg(`seg_${run}_${String(from + i).padStart(5, '0')}.ts`)).flat(),
    ]);
  const slate = playlist([
    '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:4.000000,', 'slate_h1_000.ts', '#EXTINF:4.000000,', 'slate_h1_001.ts', '#EXT-X-ENDLIST',
  ]);

  it('appends only what ffmpeg added, numbers its own segments and records ffmpeg\'s last number', () => {
    const v1 = publishMediaPlaylist(ffmpeg(3, 5), null, 3);
    const v2 = publishMediaPlaylist(ffmpeg(4, 6), v1, 3);
    assert.deepEqual(uris(v2), ['seg_r1_00004.ts', 'seg_r1_00005.ts', 'seg_r1_00006.ts']);
    assert.equal(parseMediaPlaylist(v2).mediaSequence, 4);
    assert.match(v2, /^## source-sequence:6$/m);
    assert.equal(publishMediaPlaylist(ffmpeg(4, 6), v2, 3), v2, 'nothing new');
  });

  it('fills a gap with slate segments in a loop, then resumes the source after a discontinuity', () => {
    let published = publishMediaPlaylist(ffmpeg(0, 1), null, 4);
    for (let i = 0; i < 3; i++) published = appendSlateSegment(published, slate, 4) ?? assert.fail('slate');
    assert.deepEqual(skeleton(published).slice(5), [
      'seg_r1_00001.ts', '#EXT-X-DISCONTINUITY', 'slate_h1_000.ts', 'slate_h1_001.ts', '#EXT-X-DISCONTINUITY', 'slate_h1_000.ts',
    ]);
    // Slate takes numbers of its own; ffmpeg's segment 1 is not published again.
    assert.equal(parseMediaPlaylist(published).mediaSequence, 1);
    assert.match(published, /^## source-sequence:1$/m);
    // Program date time carries on from the source's: 10:00:00 + 4s.
    assert.match(published, /#EXT-X-PROGRAM-DATE-TIME:2026-10-23T16:00:04\.000Z\nslate_h1_000\.ts/);

    // The publisher is back: ffmpeg's playlist (append_list) still lists run r1, then run r2's first segment.
    const resumed = playlist([
      ...HEADER, '#EXT-X-MEDIA-SEQUENCE:0', ...seg('seg_r1_00000.ts'), ...seg('seg_r1_00001.ts'),
      '#EXT-X-DISCONTINUITY', ...seg('seg_r2_00002.ts'),
    ]);
    published = publishMediaPlaylist(resumed, published, 4);
    assert.deepEqual(skeleton(published).slice(3), [
      '#EXT-X-MEDIA-SEQUENCE:2', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-DISCONTINUITY', 'slate_h1_000.ts', 'slate_h1_001.ts', '#EXT-X-DISCONTINUITY', 'slate_h1_000.ts',
      '#EXT-X-DISCONTINUITY', 'seg_r2_00002.ts',
    ]);
  });

  it('needs a published segment and a slate to continue', () => {
    assert.equal(appendSlateSegment(playlist(HEADER), slate, 4), null);
    assert.equal(appendSlateSegment(publishMediaPlaylist(ffmpeg(0, 0), null, 4), playlist(HEADER), 4), null);
  });

  it('starts over when ffmpeg\'s numbering goes back, and reads playlists published before the comment', () => {
    const before = publishMediaPlaylist(ffmpeg(40, 41), null, 4).replace(/^## .*\n/m, '');
    const after = publishMediaPlaylist(ffmpeg(0, 0, 'r9'), before, 4);
    assert.deepEqual(skeleton(after).slice(5), ['seg_r1_00040.ts', 'seg_r1_00041.ts', '#EXT-X-DISCONTINUITY', 'seg_r9_00000.ts']);
    assert.equal(publishMediaPlaylist(ffmpeg(41, 42), before, 4).match(/seg_r1_00041/g)?.length, 1, 'watermark from the last segment');
  });

  it('widens the target duration to fit every segment it lists', () => {
    const long = playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:8.333000,', 'seg_r1_00000.ts']);
    const v1 = publishMediaPlaylist(long, null, 4);
    assert.match(publishMediaPlaylist(ffmpeg(1, 1), v1, 4), /^#EXT-X-TARGETDURATION:8$/m);
  });
});

describe('publishMasterPlaylist', () => {
  it('points the variants at the published playlists', () => {
    const master = playlist([
      '#EXTM3U', '#EXT-X-VERSION:6',
      '#EXT-X-STREAM-INF:BANDWIDTH=5499000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"', '1080p/ffmpeg.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=969328,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"', '360p/ffmpeg.m3u8',
    ]);
    assert.equal(publishMasterPlaylist(master), master.replaceAll('/ffmpeg.m3u8', '/index.m3u8'));
  });
});

describe('playlistReferences', () => {
  it('lists segments and init sections', () => {
    const text = playlist([
      '#EXTM3U', '#EXT-X-MAP:URI="init_r1_a.mp4"', '#EXTINF:1.0,', 'seg_r1_00000.m4s',
      '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="init_r2_a.mp4"', '#EXTINF:1.0,', 'seg_r2_00001.m4s',
    ]);
    assert.deepEqual([...playlistReferences(text)].sort(), ['init_r1_a.mp4', 'init_r2_a.mp4', 'seg_r1_00000.m4s', 'seg_r2_00001.m4s']);
  });
});

describe('orderVariants', () => {
  // As ffmpeg writes it for the default ladder: top rung first, a blank line after each URI.
  const variant = (bandwidth: number, name: string) => [`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=x`, `${name}/index.m3u8`, ''];
  const master = (...variants: string[][]) => playlist(['#EXTM3U', '#EXT-X-VERSION:6', ...variants.flat()]);
  const order = (text: string) => [...text.matchAll(/^(\w+)\/index\.m3u8$/gm)].map((m) => m[1]);

  it('lists first the highest variant within the start bandwidth, and keeps the others in order', () => {
    const text = master(variant(5_499_000, '1080p'), variant(3_144_488, '720p'), variant(1_634_472, '480p'), variant(969_328, '360p'));
    const ordered = orderVariants(text);
    assert.deepEqual(order(ordered), ['720p', '1080p', '480p', '360p']);
    assert.ok(ordered.startsWith('#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=3144488,RESOLUTION=x\n720p/index.m3u8\n'));
    assert.equal(orderVariants(ordered), ordered, 'stable when republished');
  });

  it('starts on the lowest variant when every one is above the start bandwidth', () => {
    assert.deepEqual(order(orderVariants(master(variant(8_000_000, '4k'), variant(5_000_000, '1080p')))), ['1080p', '4k']);
  });

  it('leaves a master it does not fully understand as it is', () => {
    const iframes = master(variant(5_000_000, '1080p'), ['#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes.m3u8"'], variant(900_000, '360p'));
    assert.equal(orderVariants(iframes), iframes);
    const noBandwidth = master(['#EXT-X-STREAM-INF:RESOLUTION=x', 'a/index.m3u8'], variant(900_000, '360p'));
    assert.equal(orderVariants(noBandwidth), noBandwidth);
    assert.equal(orderVariants('#EXTM3U\n'), '#EXTM3U\n');
  });
});

describe('longestSegmentOfLastRun', () => {
  it('measures only the newest run', () => {
    const text = playlist([
      ...HEADER,
      '#EXTINF:12.000000,', 'seg_r1_00007.ts',
      '#EXT-X-DISCONTINUITY', '#EXTINF:8.341667,', 'seg_r2_00008.ts', '#EXTINF:4.004000,', 'seg_r2_00009.ts',
    ]);
    assert.deepEqual(longestSegmentOfLastRun(text), { runId: 'r2', seconds: 8.341667 });
    assert.equal(longestSegmentOfLastRun(playlist(HEADER)), null);
  });
});
