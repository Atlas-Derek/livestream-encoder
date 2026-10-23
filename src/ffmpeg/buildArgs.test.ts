import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelSpecSchema, type Rung } from '../channels/schema.ts';
import { AppError } from '../errors.ts';
import { buildArgs, inputArgs, redactSecrets, selectRungs, type EncoderConfig } from './buildArgs.ts';
import type { ProbeResult } from './probe.ts';

const LADDER: Rung[] = [
  { name: '1080p', height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 128 },
  { name: '720p', height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128 },
  { name: '360p', height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
];

const ENCODER: EncoderConfig = { videoEncoder: 'libx264', x264Preset: 'veryfast', segmentSeconds: 4, liveListSize: 6 };

const PROBE_1080: ProbeResult = { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac' };

function spec(input: unknown, extra: Record<string, unknown> = {}) {
  return ChannelSpecSchema.parse({ id: 'ch', input, ...extra });
}

/** Value following a flag, e.g. valueOf(args, '-hls_flags'). */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('selectRungs', () => {
  it('keeps the whole ladder when the source height is unknown', () => {
    assert.deepEqual(selectRungs(LADDER, null), LADDER);
  });

  it('drops rungs taller than the source', () => {
    assert.deepEqual(selectRungs(LADDER, 720).map((r) => r.name), ['720p', '360p']);
  });

  it('falls back to one rendition at source height when the source is smaller than every rung', () => {
    assert.deepEqual(selectRungs(LADDER, 241), [{ ...LADDER[2], height: 240 }]);
  });
});

describe('inputArgs', () => {
  it('paces live file playout and loops when asked', () => {
    assert.deepEqual(inputArgs({ type: 'file', path: '/m/a.mp4', loop: true }, 'live', null), [
      '-re', '-stream_loop', '-1', '-i', '/m/a.mp4',
    ]);
  });

  it('reads VOD files as fast as possible', () => {
    assert.deepEqual(inputArgs({ type: 'file', path: '/m/a.mp4', loop: false }, 'vod', null), ['-i', '/m/a.mp4']);
  });

  it('uses TCP and the demuxer timeout for RTSP pulls', () => {
    assert.deepEqual(inputArgs({ type: 'pull', url: 'rtsp://cam/stream' }, 'live', null), [
      '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', 'rtsp://cam/stream',
    ]);
  });

  it('uses rw_timeout for other pulls', () => {
    assert.deepEqual(inputArgs({ type: 'pull', url: 'https://x/live.m3u8' }, 'live', null), [
      '-rw_timeout', '10000000', '-i', 'https://x/live.m3u8',
    ]);
  });

  it('listens for RTMP on the assigned port and key', () => {
    assert.deepEqual(inputArgs({ type: 'rtmp', streamKey: 'abc' }, 'live', 1936), [
      '-listen', '1', '-i', 'rtmp://0.0.0.0:1936/live/abc',
    ]);
  });

  it('listens for SRT with an encoded passphrase', () => {
    assert.deepEqual(inputArgs({ type: 'srt', passphrase: 'pass word&123' }, 'live', 9001), [
      '-i', 'srt://0.0.0.0:9001?mode=listener&passphrase=pass%20word%26123&pbkeylen=16',
    ]);
  });

  it('refuses a listener without a port', () => {
    assert.throws(() => inputArgs({ type: 'srt' }, 'live', null), AppError);
  });
});

describe('buildArgs', () => {
  it('builds a VOD ABR ladder from a probed file', () => {
    const { args, variants } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: ENCODER,
    });
    assert.deepEqual(variants, ['1080p', '720p', '360p']);
    assert.deepEqual(args, [
      '-hide_banner', '-nostdin', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-y',
      '-i', '/m/a.mp4',
      '-filter_complex',
      '[0:v]split=3[s0][s1][s2];[s0]scale=-2:1080,format=yuv420p[v0];[s1]scale=-2:720,format=yuv420p[v1];[s2]scale=-2:360,format=yuv420p[v2]',
      '-map', '[v0]', '-map', '0:a:0', '-map', '[v1]', '-map', '0:a:0', '-map', '[v2]', '-map', '0:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
      '-force_key_frames', 'expr:gte(t,n_forced*4)', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0',
      '-b:v:0', '5000k', '-maxrate:v:0', '5350k', '-bufsize:v:0', '7500k',
      '-b:v:1', '2800k', '-maxrate:v:1', '2996k', '-bufsize:v:1', '4200k',
      '-b:v:2', '800k', '-maxrate:v:2', '856k', '-bufsize:v:2', '1200k',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a:0', '128k', '-b:a:1', '128k', '-b:a:2', '96k',
      '-max_muxing_queue_size', '1024',
      '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', '/hls/ch/%v/seg_r1_%05d.ts',
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', 'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:360p',
      '-hls_playlist_type', 'vod', '-hls_list_size', '0', '-hls_flags', 'independent_segments+temp_file',
      '/hls/ch/%v/index.m3u8',
    ]);
  });

  it('uses a rolling, appendable playlist for live output', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4', loop: true }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: ENCODER,
    });
    assert.equal(args[args.indexOf('-i') - 3], '-re');
    assert.equal(valueOf(args, '-hls_list_size'), '6');
    assert.equal(
      valueOf(args, '-hls_flags'),
      'delete_segments+independent_segments+temp_file+program_date_time+append_list+omit_endlist',
    );
    assert.equal(args.includes('-hls_playlist_type'), false);
    assert.equal(args.includes('-hls_start_number_source'), false);
  });

  it('drops rungs above a 720p source', () => {
    const { variants, args } = buildArgs(spec({ type: 'pull', url: 'https://x/live.m3u8' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, height: 720 }, encoder: ENCODER,
    });
    assert.deepEqual(variants, ['720p', '360p']);
    assert.equal(valueOf(args, '-var_stream_map'), 'v:0,a:0,name:720p v:1,a:1,name:360p');
  });

  it('encodes the full ladder for push inputs and sizes the GOP for up to 60 fps', () => {
    const { variants, args } = buildArgs(spec({ type: 'rtmp', streamKey: 'abc' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 1935, probe: null, encoder: ENCODER,
    });
    assert.deepEqual(variants, ['1080p', '720p', '360p']);
    assert.equal(valueOf(args, '-g'), '240');
    assert.equal(args.includes('-keyint_min'), false);
    assert.equal(valueOf(args, '-force_key_frames'), 'expr:gte(t,n_forced*4)');
  });

  it('builds the SRT listener with the full ladder', () => {
    const { args } = buildArgs(spec({ type: 'srt' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    assert.equal(valueOf(args, '-i'), 'srt://0.0.0.0:9000?mode=listener');
  });

  it('leaves audio out when the source has none', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, audioCodec: null }, encoder: ENCODER,
    });
    assert.equal(args.includes('0:a:0'), false);
    assert.equal(args.includes('-c:a'), false);
    assert.equal(valueOf(args, '-var_stream_map'), 'v:0,name:1080p v:1,name:720p v:2,name:360p');
  });

  it('copies compatible streams in passthrough mode', () => {
    const { args, variants } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', passthrough: true }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: ENCODER,
    });
    assert.deepEqual(variants, ['source']);
    assert.equal(args.includes('-filter_complex'), false);
    assert.equal(valueOf(args, '-c'), 'copy');
    assert.equal(valueOf(args, '-var_stream_map'), 'v:0,a:0,name:source');
  });

  it('rejects passthrough for codecs HLS cannot carry', () => {
    assert.throws(
      () =>
        buildArgs(spec({ type: 'file', path: '/m/a.mkv' }, { mode: 'vod', passthrough: true }), {
          outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, videoCodec: 'vp9' }, encoder: ENCODER,
        }),
      /H\.264 or HEVC/,
    );
  });

  it('writes fMP4 segments', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', segmentType: 'fmp4' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: ENCODER,
    });
    assert.equal(valueOf(args, '-hls_segment_type'), 'fmp4');
    assert.equal(valueOf(args, '-hls_fmp4_init_filename'), 'init.mp4');
    assert.equal(valueOf(args, '-hls_segment_filename'), '/hls/ch/%v/seg_r1_%05d.m4s');
  });

  it('switches to VideoToolbox without the x264-only flags', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: { ...ENCODER, videoEncoder: 'h264_videotoolbox' },
    });
    assert.equal(valueOf(args, '-c:v'), 'h264_videotoolbox');
    assert.equal(args.includes('-preset'), false);
    assert.equal(args.includes('-sc_threshold'), false);
  });
});

describe('redactSecrets', () => {
  it('masks SRT passphrases and URL credentials', () => {
    assert.equal(
      redactSecrets('srt://0.0.0.0:9000?mode=listener&passphrase=correct%20horse&pbkeylen=16'),
      'srt://0.0.0.0:9000?mode=listener&passphrase=********&pbkeylen=16',
    );
    assert.equal(
      redactSecrets('[rtsp @ 0x1] method DESCRIBE failed: rtsp://admin:hunter2@cam.local:554/stream'),
      '[rtsp @ 0x1] method DESCRIBE failed: rtsp://admin:********@cam.local:554/stream',
    );
  });

  it('leaves URLs without secrets alone', () => {
    for (const text of ['rtmp://0.0.0.0:1935/live/key', 'https://cdn.example/live.m3u8', 'srt://0.0.0.0:9000?mode=listener']) {
      assert.equal(redactSecrets(text), text);
    }
  });
});

describe('ChannelSpecSchema', () => {
  it('only allows vod for non-looping files', () => {
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'rtmp', streamKey: 'k' }, mode: 'vod' }).success, false);
    assert.equal(
      ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'file', path: 'x', loop: true }, mode: 'vod' }).success,
      false,
    );
  });

  it('defaults to live mpegts with the default ladder', () => {
    const parsed = ChannelSpecSchema.parse({ id: 'a', input: { type: 'srt' } });
    assert.equal(parsed.mode, 'live');
    assert.equal(parsed.segmentType, 'mpegts');
    assert.equal(parsed.ladder, undefined);
  });
});
