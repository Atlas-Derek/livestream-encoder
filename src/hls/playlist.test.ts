import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMediaPlaylist, playlistReferences, publishMasterPlaylist, publishMediaPlaylist } from './playlist.ts';

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
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('#EXTINF') && !line.startsWith('#EXT-X-PROGRAM'));
}

describe('publishMediaPlaylist', () => {
  it('marks run boundaries from segment names and starts at discontinuity sequence 0', () => {
    const source = playlist([
      ...HEADER, '#EXT-X-MEDIA-SEQUENCE:3', '#EXT-X-INDEPENDENT-SEGMENTS',
      ...seg('seg_r1_00003.ts'), '#EXT-X-DISCONTINUITY', ...seg('seg_r2_00004.ts'), ...seg('seg_r2_00005.ts'),
    ]);
    assert.deepEqual(skeleton(publishMediaPlaylist(source, null)), [
      '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA-SEQUENCE:3', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      'seg_r1_00003.ts', '#EXT-X-DISCONTINUITY', 'seg_r2_00004.ts', 'seg_r2_00005.ts',
    ]);
  });

  it('keeps the tag on the first segment until it leaves, then counts it in the discontinuity sequence', () => {
    const v1 = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:4', ...seg('seg_r1_00004.ts'), '#EXT-X-DISCONTINUITY', ...seg('seg_r2_00005.ts')]),
      null,
    );
    // ffmpeg's playlist after the r1 segment slid out: its predecessor is gone, but the tag must stay.
    const v2 = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:5', ...seg('seg_r2_00005.ts'), ...seg('seg_r2_00006.ts')]),
      v1,
    );
    assert.deepEqual(skeleton(v2).slice(3), [
      '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-DISCONTINUITY', 'seg_r2_00005.ts', 'seg_r2_00006.ts',
    ]);

    const v3 = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:6', ...seg('seg_r2_00006.ts'), ...seg('seg_r2_00007.ts')]),
      v2,
    );
    assert.deepEqual(skeleton(v3).slice(3), [
      '#EXT-X-MEDIA-SEQUENCE:6', '#EXT-X-DISCONTINUITY-SEQUENCE:1', 'seg_r2_00006.ts', 'seg_r2_00007.ts',
    ]);
  });

  it('accumulates the discontinuity sequence across several restarts', () => {
    let published: string | null = publishMediaPlaylist(
      playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:0', ...seg('seg_a_00000.ts'), ...seg('seg_b_00001.ts'), ...seg('seg_c_00002.ts')]),
      null,
    );
    published = publishMediaPlaylist(playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:3', ...seg('seg_c_00003.ts')]), published);
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
    );
    const ffmpeg = playlist([
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init_r2_a.mp4"',
      '#EXT-X-DISCONTINUITY', '#EXTINF:1.000000,', 'seg_r1_00000.m4s', '#EXTINF:1.000000,', 'seg_r1_00001.m4s',
      '#EXT-X-DISCONTINUITY', '#EXTINF:1.000000,', 'seg_r2_00002.m4s', '#EXTINF:1.000000,', 'seg_r2_00003.m4s',
    ]);
    assert.deepEqual(skeleton(publishMediaPlaylist(ffmpeg, r1)), [
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-MAP:URI="init_r1_a.mp4"', 'seg_r1_00000.m4s', 'seg_r1_00001.m4s',
      '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="init_r2_a.mp4"', 'seg_r2_00002.m4s', 'seg_r2_00003.m4s',
    ]);
  });

  it('trusts ffmpeg’s own tags for segments named before run ids', () => {
    const source = playlist([
      ...HEADER, '#EXT-X-MEDIA-SEQUENCE:7', ...seg('seg_00007.ts'), '#EXT-X-DISCONTINUITY', ...seg('seg_00008.ts'), ...seg('seg_00009.ts'),
    ]);
    assert.deepEqual(skeleton(publishMediaPlaylist(source, null)).slice(-4), [
      'seg_00007.ts', '#EXT-X-DISCONTINUITY', 'seg_00008.ts', 'seg_00009.ts',
    ]);
  });

  it('keeps per-segment tags with their segment', () => {
    const source = playlist([...HEADER, '#EXT-X-MEDIA-SEQUENCE:1', ...seg('seg_r1_00001.ts')]);
    assert.ok(publishMediaPlaylist(source, null).endsWith(`${seg('seg_r1_00001.ts').join('\n')}\n`));
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
