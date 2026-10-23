import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { silentLogger, type Logger } from '../log.ts';
import { waitFor } from '../testing/fakes.ts';
import { PlaylistPublisher } from './publisher.ts';

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'lse-publisher-'));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const VARIANT = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:4.0,\nseg_r1_00009.ts\n';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/ffmpeg.m3u8\n';

async function writeFfmpegOutput(variant = VARIANT): Promise<void> {
  await mkdir(path.join(outDir, '720p'), { recursive: true });
  await writeFile(path.join(outDir, '720p', 'ffmpeg.m3u8'), variant);
  await writeFile(path.join(outDir, 'ffmpeg-master.m3u8'), MASTER);
}

const read = (...parts: string[]) => readFile(path.join(outDir, ...parts), 'utf8');

describe('PlaylistPublisher', () => {
  it('publishes the master and variant playlists players fetch', async () => {
    await writeFfmpegOutput();
    await new PlaylistPublisher({ outDir, channel: 'ch', logger: silentLogger }).sync();
    assert.equal(await read('master.m3u8'), MASTER.replace('ffmpeg.m3u8', 'index.m3u8'));
    assert.match(await read('720p', 'index.m3u8'), /#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXTINF:4\.0,\nseg_r1_00009\.ts\n$/);
  });

  it('only rewrites a playlist when ffmpeg has changed it', async () => {
    await writeFfmpegOutput();
    const publisher = new PlaylistPublisher({ outDir, channel: 'ch', logger: silentLogger });
    await publisher.sync();
    await writeFile(path.join(outDir, '720p', 'index.m3u8'), 'marker');
    await publisher.sync();
    assert.equal(await read('720p', 'index.m3u8'), 'marker');

    await writeFfmpegOutput(VARIANT.replace('MEDIA-SEQUENCE:9', 'MEDIA-SEQUENCE:10').replace('00009', '00010'));
    await publisher.sync();
    assert.match(await read('720p', 'index.m3u8'), /seg_r1_00010\.ts/);
  });

  it('warns about segments much longer than hls_time, with advice for passthrough, and logs it once per run', async () => {
    const warned: unknown[] = [];
    const logger: Logger = { ...silentLogger, warn: (obj: unknown) => void warned.push(obj) };
    const variant = (seconds: string[]) =>
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n${seconds.map((s, i) => `#EXTINF:${s},\nseg_r1_0000${i}.ts\n`).join('')}`;
    const publisher = new PlaylistPublisher({ outDir, channel: 'ch', logger, segmentSeconds: 4, passthrough: true });

    await writeFfmpegOutput(variant(['4.000000', '4.966667']));
    await publisher.sync();
    assert.deepEqual(publisher.warnings(), [], 'within 1.25x');

    await writeFfmpegOutput(variant(['4.000000', '4.966667', '8.333333']));
    await publisher.sync();
    const [warning] = publisher.warnings();
    assert.match(warning ?? '', /^segments are up to 8\.3s long instead of 4s, which adds latency: passthrough can only cut/);
    assert.match(warning ?? '', /keyframe interval to 4s/);

    await writeFfmpegOutput(variant(['4.000000', '4.966667', '8.333333', '8.333333']));
    await publisher.sync();
    assert.equal(warned.length, 1, 'logged once per run');

    const encoded = new PlaylistPublisher({ outDir, channel: 'ch', logger: silentLogger, segmentSeconds: 4 });
    await encoded.sync();
    assert.doesNotMatch(encoded.warnings()[0] ?? '', /passthrough/);
    assert.deepEqual(new PlaylistPublisher({ outDir, channel: 'ch', logger: silentLogger }).warnings(), []);
  });

  it('polls while resumed and publishes once more when paused', async () => {
    const publisher = new PlaylistPublisher({ outDir, channel: 'ch', logger: silentLogger, intervalMs: 10 });
    publisher.resume();
    await writeFfmpegOutput();
    await waitFor(() => existsSync(path.join(outDir, '720p', 'index.m3u8')));
    // ffmpeg finalizes its playlist as it exits, after the last poll; pause() must still publish it.
    await publisher.pause();
    await writeFfmpegOutput(VARIANT.replace('00009', '00042'));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.doesNotMatch(await read('720p', 'index.m3u8'), /00042/, 'no polling once paused');
    await publisher.pause();
    assert.match(await read('720p', 'index.m3u8'), /00042/);
  });

  it('adds missing CODECS once the variant has a segment, and stops probing after that', async () => {
    await mkdir(path.join(outDir, '720p'), { recursive: true });
    await writeFile(path.join(outDir, 'ffmpeg-master.m3u8'), MASTER);
    let probes = 0;
    const probeStreams = async (): Promise<unknown> => {
      probes++;
      return { streams: [{ codec_type: 'video', codec_name: 'h264', extradata: '00000000: 0164 0028  .d.(' }] };
    };
    const publisher = new PlaylistPublisher({ outDir, channel: 'ch', logger: silentLogger, probeStreams });

    await publisher.sync(); // no variant playlist yet: published without CODECS, to be retried
    assert.doesNotMatch(await read('master.m3u8'), /CODECS/);
    await writeFfmpegOutput();
    await publisher.sync();
    assert.match(await read('master.m3u8'), /BANDWIDTH=1000,CODECS="avc1\.640028"\n720p\/index\.m3u8/);
    await publisher.sync();
    assert.equal(probes, 1);
  });

  it('tolerates a missing output directory and logs other failures once', async () => {
    const errors: string[] = [];
    const logger: Logger = { ...silentLogger, error: (_obj, msg) => errors.push(msg ?? '') };
    await new PlaylistPublisher({ outDir: path.join(outDir, 'missing'), channel: 'ch', logger }).sync();
    assert.deepEqual(errors, []);

    await writeFfmpegOutput();
    await mkdir(path.join(outDir, '720p', 'index.m3u8.tmp')); // a directory where the temp file must go
    const publisher = new PlaylistPublisher({ outDir, channel: 'ch', logger });
    await publisher.sync();
    await publisher.sync();
    assert.deepEqual(errors, ['failed to publish playlists']);
  });
});
