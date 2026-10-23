import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelSpecSchema, type Rung } from '../channels/schema.ts';
import { AppError } from '../errors.ts';
import {
  buildArgs,
  buildSlateArgs,
  buildThumbnailArgs,
  colorPlan,
  inputArgs,
  publishedWindow,
  redactSecrets,
  retainedAfterRemoval,
  rungFps,
  rungVideoKbps,
  selectRungs,
  slateId,
  thumbnailSize,
  type EncoderConfig,
  type SlateOptions,
} from './buildArgs.ts';
import type { ProbeResult } from './probe.ts';

const LADDER: Rung[] = [
  { name: '1080p', height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 128 },
  { name: '720p', height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128 },
  { name: '360p', height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
];

const ENCODER: EncoderConfig = { videoEncoder: 'libx264', x264Preset: 'veryfast', segmentSeconds: 4, liveListSize: 6 };

const PROBE_1080: ProbeResult = {
  width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', colorSpace: 'bt709', colorTransfer: 'bt709',
  durationSec: null,
};

const RECONNECT = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5'];

const TO_709 = ':in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv';

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

describe('DVR window and segment retention', () => {
  it('lengthens the published window to cover the DVR window, and keeps segments on disk to match', () => {
    assert.equal(publishedWindow(spec({ type: 'srt' }), ENCODER), 6);
    assert.equal(retainedAfterRemoval(6), 7, 'one segment plus the playlist');

    const dvr = spec({ type: 'srt' }, { dvrWindowSeconds: 120 });
    assert.equal(publishedWindow(dvr, ENCODER), 30);
    const { args } = buildArgs(dvr, { outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER });
    // ffmpeg keeps at most its own list size + 1 removed segments, whatever the threshold, so its list is the window.
    assert.equal(valueOf(args, '-hls_list_size'), '30');
    assert.equal(valueOf(args, '-hls_delete_threshold'), '31');
    assert.equal(publishedWindow(spec({ type: 'srt' }, { dvrWindowSeconds: 10 }), ENCODER), 6, 'never shorter than the live window');
  });
});

describe('rungFps', () => {
  it('divides by a whole number so the cadence stays even', () => {
    assert.equal(rungFps(60, 30), 30);
    assert.ok(Math.abs(rungFps(59.94, 30) - 29.97) < 0.001);
    assert.equal(rungFps(50, 30), 25);
    assert.ok(Math.abs(rungFps(29.97, 30) - 29.97) < 0.001);
    assert.equal(rungFps(120, 30), 30);
    assert.equal(rungFps(60, undefined), 60);
  });
});

describe('colorPlan', () => {
  it('converts a tagged source matrix to BT.709', () => {
    const plan = colorPlan({ ...PROBE_1080, colorSpace: 'smpte170m', colorTransfer: 'smpte170m' });
    assert.equal(plan.tonemap, null);
    assert.equal(plan.scale, ':in_color_matrix=smpte170m:out_color_matrix=bt709:out_range=tv');
    assert.equal(colorPlan({ ...PROBE_1080, colorSpace: 'bt470bg' }).scale, ':in_color_matrix=bt470:out_color_matrix=bt709:out_range=tv');
  });

  it('assumes what players do for an untagged source: BT.709 from 720 lines, BT.601 below', () => {
    const untagged = { ...PROBE_1080, colorSpace: null, colorTransfer: null };
    assert.match(colorPlan(untagged).scale, /in_color_matrix=bt709:/);
    assert.match(colorPlan({ ...untagged, width: 720, height: 480 }).scale, /in_color_matrix=smpte170m:/);
    assert.match(colorPlan({ ...untagged, width: 480, height: 854 }).scale, /in_color_matrix=smpte170m:/, 'short side of portrait');
  });

  it('tone maps PQ and HLG sources to BT.709 SDR', () => {
    for (const transfer of ['smpte2084', 'arib-std-b67']) {
      const plan = colorPlan({ ...PROBE_1080, colorSpace: 'bt2020nc', colorTransfer: transfer });
      assert.match(plan.tonemap ?? '', new RegExp(`^zscale=tin=${transfer}:.*tonemap=tonemap=mobius.*,format=yuv420p$`));
      assert.match(plan.scale, /in_color_matrix=bt709:/, 'the tone mapper outputs BT.709');
      assert.deepEqual(plan.output, ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']);
    }
  });

  it('leaves unprobed push sources as the publisher tagged them', () => {
    assert.deepEqual(colorPlan(null), { tonemap: null, scale: '', output: [] });
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
    assert.deepEqual(inputArgs({ type: 'pull', url: 'rtsp://cam/stream', loop: true }, 'live', null), [
      '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', 'rtsp://cam/stream',
    ]);
  });

  it('uses rw_timeout for other pulls, and lets HTTP ones resume after a dropped connection', () => {
    assert.deepEqual(inputArgs({ type: 'pull', url: 'https://x/live.m3u8', loop: true }, 'live', null), [
      '-rw_timeout', '10000000', ...RECONNECT, '-i', 'https://x/live.m3u8',
    ]);
    assert.deepEqual(inputArgs({ type: 'pull', url: 'srt://x:9000', loop: true }, 'live', null), [
      '-rw_timeout', '10000000', '-i', 'srt://x:9000',
    ]);
  });

  it('paces a pull whose source has a duration (an HTTP file or VOD playlist)', () => {
    assert.deepEqual(inputArgs({ type: 'pull', url: 'https://x/vod.m3u8', loop: true }, 'live', null, { ...PROBE_1080, durationSec: 60 }), [
      '-re', '-rw_timeout', '10000000', ...RECONNECT, '-i', 'https://x/vod.m3u8',
    ]);
    assert.equal(inputArgs({ type: 'pull', url: 'https://x/live.m3u8', loop: true }, 'live', null, PROBE_1080).includes('-re'), false);
  });

  it('plays a finite pull once, and refuses a live one that would end at its first dropout', () => {
    const once = { type: 'pull', url: 'https://x/clip.mp4', loop: false } as const;
    assert.deepEqual(inputArgs(once, 'live', null, { ...PROBE_1080, durationSec: 60 }), [
      '-re', '-rw_timeout', '10000000', ...RECONNECT, '-i', 'https://x/clip.mp4',
    ]);
    assert.throws(
      () => inputArgs(once, 'live', null, PROBE_1080),
      (err) => err instanceof AppError && err.status === 422 && /finite source/.test(err.message),
    );
  });

  it('listens for RTMP on the assigned port and key', () => {
    assert.deepEqual(inputArgs({ type: 'rtmp', streamKey: 'abc', audio: true }, 'live', 1936), [
      '-listen', '1', '-i', 'rtmp://0.0.0.0:1936/live/abc',
    ]);
  });

  it('listens for SRT, with an encoded passphrase when one is set', () => {
    assert.deepEqual(inputArgs({ type: 'srt', passphrase: 'pass word&123', latencyMs: 1000, audio: true }, 'live', 9001), [
      '-i', 'srt://0.0.0.0:9001?mode=listener&latency=1000000&passphrase=pass%20word%26123&pbkeylen=16',
    ]);
    assert.deepEqual(inputArgs({ type: 'srt', latencyMs: 2500, audio: true }, 'live', 9000), [
      '-i', 'srt://0.0.0.0:9000?mode=listener&latency=2500000',
    ]);
  });

  it('refuses a listener without a port', () => {
    assert.throws(() => inputArgs({ type: 'srt', latencyMs: 1000, audio: true }, 'live', null), AppError);
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
      '[0:v]bwdif=mode=send_frame:parity=auto:deint=interlaced,split=3[s0][s1][s2];' +
        `[s0]scale=-2:1080${TO_709},format=yuv420p[v0];[s1]scale=-2:720${TO_709},format=yuv420p[v1];` +
        `[s2]scale=-2:360${TO_709},format=yuv420p[v2];` +
        '[0:a]aresample=async=1:first_pts=0,asplit=3[a0][a1][a2]',
      '-map', '[v0]', '-map', '[a0]', '-map', '[v1]', '-map', '[a1]', '-map', '[v2]', '-map', '[a2]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-force_key_frames', 'expr:gte(t,n_forced*4)',
      '-g:v:0', '120', '-keyint_min:v:0', '120', '-g:v:1', '120', '-keyint_min:v:1', '120', '-g:v:2', '120', '-keyint_min:v:2', '120',
      '-sc_threshold', '0',
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
    // Removed segments stay for one segment plus the playlist's duration (RFC 8216 6.2.2).
    assert.equal(valueOf(args, '-hls_delete_threshold'), '7');
    assert.equal(
      valueOf(args, '-hls_flags'),
      'delete_segments+independent_segments+temp_file+program_date_time+append_list+omit_endlist',
    );
    assert.equal(args.includes('-hls_playlist_type'), false);
    assert.equal(args.includes('-hls_start_number_source'), false);
    // Players get the published copies (src/hls/playlist.ts), not ffmpeg's own.
    assert.equal(valueOf(args, '-master_pl_name'), 'ffmpeg-master.m3u8');
    assert.equal(args.at(-1), '/hls/ch/%v/ffmpeg.m3u8');
  });

  it('encodes the full ladder for push inputs and sizes the GOP for up to 60 fps', () => {
    const { variants, args } = buildArgs(spec({ type: 'rtmp', streamKey: 'abc' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 1935, probe: null, encoder: ENCODER,
    });
    assert.deepEqual(variants, ['1080p', '720p', '360p']);
    assert.equal(valueOf(args, '-g:v:0'), '240');
    assert.equal(args.some((arg) => arg.startsWith('-keyint_min')), false);
    assert.equal(valueOf(args, '-force_key_frames'), 'expr:gte(t,n_forced*4)');
  });

  it('tone maps HDR once, before the split', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/hlg.mov' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, encoder: ENCODER,
      probe: { ...PROBE_1080, colorSpace: 'bt2020nc', colorTransfer: 'arib-std-b67' },
    });
    const filter = valueOf(args, '-filter_complex') ?? '';
    assert.match(filter, /^\[0:v\]bwdif=[^,]*,zscale=tin=arib-std-b67:[^;]*,format=yuv420p,split=3/);
    assert.equal(filter.match(/tonemap=mobius/g)?.length, 1);
  });

  it('scales portrait sources by width and picks rungs by the short side', () => {
    const { variants, args } = buildArgs(spec({ type: 'file', path: '/m/phone.mov' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, width: 1080, height: 1920 }, encoder: ENCODER,
    });
    assert.deepEqual(variants, ['1080p', '720p', '360p']);
    assert.match(valueOf(args, '-filter_complex') ?? '', /\[s0\]scale=1080:-2[:,].*\[s1\]scale=720:-2[:,].*\[s2\]scale=360:-2[:,]/);
  });

  it('caps the frame rate of rungs with maxFps and sizes their GOP to match', () => {
    const ladder: Rung[] = [LADDER[0] as Rung, { ...(LADDER[2] as Rung), maxFps: 30 }];
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder, port: null, probe: { ...PROBE_1080, fps: 60 }, encoder: ENCODER,
    });
    const filter = valueOf(args, '-filter_complex') ?? '';
    assert.match(filter, /\[s1\]fps=fps=source_fps\/ceil\(source_fps\/30\),scale=-2:360/);
    assert.doesNotMatch(filter, /\[s0\]fps/);
    assert.equal(valueOf(args, '-g:v:0'), '240'); // 60 fps x 4s
    assert.equal(valueOf(args, '-g:v:1'), '120'); // 30 fps x 4s
    assert.equal(valueOf(args, '-keyint_min:v:1'), '120');
    // Only the rung that keeps 60 fps gets the high frame rate bitrate.
    assert.deepEqual([valueOf(args, '-b:v:0'), valueOf(args, '-maxrate:v:0'), valueOf(args, '-b:v:1')], ['7500k', '8025k', '800k']);
  });

  it('raises the bitrate only for rungs that keep a probed source above 30 fps', () => {
    const rung = LADDER[0] as Rung; // 5000k
    assert.equal(rungVideoKbps(rung, 60), 7500);
    assert.equal(rungVideoKbps(rung, 50), 7500);
    assert.equal(rungVideoKbps(rung, 30), 5000);
    assert.equal(rungVideoKbps(rung, 29.97), 5000);
    assert.equal(rungVideoKbps({ ...rung, maxFps: 30 }, 60), 5000, 'capped to 30');
    assert.equal(rungVideoKbps(rung, null), 5000, 'push source: unknown');
  });

  it('deinterlaces before scaling and keeps audio in sync, but not in passthrough', () => {
    const { args } = buildArgs(spec({ type: 'srt' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    const filter = valueOf(args, '-filter_complex') ?? '';
    assert.match(filter, /^\[0:v\]bwdif=mode=send_frame:parity=auto:deint=interlaced,split=3/);
    // One resampler shared through asplit: one per rendition (-af) froze ffmpeg 9 at the first audio gap.
    assert.match(filter, /;\[0:a\]aresample=async=1:first_pts=0,asplit=3\[a0\]\[a1\]\[a2\]$/);
    assert.equal(args.includes('-af'), false);

    const copy = buildArgs(spec({ type: 'srt' }, { passthrough: true }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    assert.equal(copy.args.includes('-filter_complex'), false);
  });

  it('labels each rendition when debugOverlay is set', () => {
    const { args } = buildArgs(spec({ type: 'srt' }, { debugOverlay: true }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    const filter = valueOf(args, '-filter_complex') ?? '';
    assert.match(filter, /\[s1\]scale=-2:720,drawtext=text='720p':[^,;]*,format=yuv420p\[v1\]/);
  });

  it('leaves audio out of a push channel declared video-only', () => {
    const { args } = buildArgs(spec({ type: 'srt', audio: false }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    assert.equal(args.includes('[a0]'), false);
    assert.doesNotMatch(valueOf(args, '-filter_complex') ?? '', /\[0:a\]/);
    assert.equal(valueOf(args, '-var_stream_map'), 'v:0,name:1080p v:1,name:720p v:2,name:360p');
  });

  it('resamples audio without asplit for a single rendition', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, height: 400 }, encoder: ENCODER,
    });
    assert.match(valueOf(args, '-filter_complex') ?? '', /;\[0:a\]aresample=async=1:first_pts=0\[a0\]$/);
    assert.deepEqual(args.filter((_, i) => args[i - 1] === '-map'), ['[v0]', '[a0]']);
  });

  it('leaves audio out when the source has none', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, audioCodec: null }, encoder: ENCODER,
    });
    assert.equal(args.includes('[a0]'), false);
    assert.doesNotMatch(valueOf(args, '-filter_complex') ?? '', /\[0:a\]/);
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
    assert.equal(args.includes('-tag:v'), false);
  });

  it('packages HEVC passthrough as fMP4 with the hvc1 sample entry players require', () => {
    const hevc = { ...PROBE_1080, videoCodec: 'hevc' };
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', passthrough: true, segmentType: 'fmp4' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: hevc, encoder: ENCODER,
    });
    assert.equal(valueOf(args, '-tag:v'), 'hvc1');
    assert.throws(
      () =>
        buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', passthrough: true }), {
          outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: hevc, encoder: ENCODER,
        }),
      (err) => err instanceof AppError && err.status === 422 && /segmentType.*fmp4/.test(err.message),
    );
  });

  it('converts ADTS AAC for fMP4 passthrough and declares a bitrate for push passthrough', () => {
    const push = buildArgs(spec({ type: 'srt' }, { passthrough: true, segmentType: 'fmp4' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    assert.equal(valueOf(push.args, '-bsf:a'), 'aac_adtstoasc');
    assert.equal(valueOf(push.args, '-b:v'), '5000k'); // the tallest rung
    assert.equal(valueOf(push.args, '-b:a'), '128k');

    const ts = buildArgs(spec({ type: 'srt', audio: false }, { passthrough: true }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER,
    });
    assert.equal(ts.args.includes('-bsf:a'), false); // MPEG-TS carries ADTS as is
    assert.equal(ts.args.includes('-b:a'), false);

    const mp3File = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', passthrough: true, segmentType: 'fmp4' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: { ...PROBE_1080, audioCodec: 'mp3' }, encoder: ENCODER,
    });
    assert.equal(mp3File.args.includes('-bsf:a'), false);
    assert.equal(mp3File.args.includes('-b:v'), false); // the container knows the bitrate
  });

  it('rejects passthrough for codecs HLS cannot carry', () => {
    const passthrough = (probe: ProbeResult) => () =>
      buildArgs(spec({ type: 'file', path: '/m/a.mkv' }, { mode: 'vod', passthrough: true }), {
        outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe, encoder: ENCODER,
      });
    const unprocessable = (pattern: RegExp) => (err: unknown) => err instanceof AppError && err.status === 422 && pattern.test(err.message);
    assert.throws(passthrough({ ...PROBE_1080, videoCodec: 'vp9' }), unprocessable(/H\.264 or HEVC video, source is vp9/));
    assert.throws(passthrough({ ...PROBE_1080, videoCodec: null }), unprocessable(/source is missing/));
    assert.throws(passthrough({ ...PROBE_1080, audioCodec: 'opus' }), unprocessable(/cannot carry opus audio/));
  });

  it('writes fMP4 segments', () => {
    const { args } = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', segmentType: 'fmp4' }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: ENCODER,
    });
    assert.equal(valueOf(args, '-hls_segment_type'), 'fmp4');
    assert.equal(valueOf(args, '-hls_fmp4_init_filename'), 'init_r1_%v.mp4');

    // ffmpeg leaves %v unexpanded with a single variant, which would put a literal "%v" in the URL.
    const single = buildArgs(spec({ type: 'file', path: '/m/a.mp4' }, { mode: 'vod', segmentType: 'fmp4', passthrough: true }), {
      outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: null, probe: PROBE_1080, encoder: ENCODER,
    });
    assert.equal(valueOf(single.args, '-hls_fmp4_init_filename'), 'init_r1.mp4');
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

describe('encryption', () => {
  it('passes ffmpeg the key info file, and nothing without one', () => {
    const options = { outDir: '/hls/ch', runId: 'r1', ladder: LADDER, port: 9000, probe: null, encoder: ENCODER };
    assert.equal(valueOf(buildArgs(spec({ type: 'srt' }), { ...options, keyInfoFile: '/var/keys/ch.keyinfo' }).args, '-hls_key_info_file'), '/var/keys/ch.keyinfo');
    assert.equal(buildArgs(spec({ type: 'srt' }), options).args.includes('-hls_key_info_file'), false);
  });
});

describe('thumbnailSize', () => {
  it('is 160 wide with an even height that keeps the rendition\'s shape', () => {
    assert.deepEqual(thumbnailSize(426, 240), { width: 160, height: 90 });
    assert.deepEqual(thumbnailSize(1080, 1920), { width: 160, height: 284 });
    assert.deepEqual(thumbnailSize(640, 480), { width: 160, height: 120 });
  });
});

describe('buildThumbnailArgs', () => {
  it('lets the HLS demuxer fetch an encrypted recording\'s key, and numbers sheets from 0', () => {
    const args = buildThumbnailArgs({ playlist: '/r/720p/index.m3u8', outDir: '/r', id: 'ab', size: { width: 160, height: 90 } });
    // Without it ffmpeg refuses the key_<run>.key URI, so only encrypted recordings would lose their thumbnails.
    assert.ok(args.indexOf('-allowed_extensions') < args.indexOf('-i'), 'an input option');
    assert.equal(valueOf(args, '-allowed_extensions'), 'ALL');
    assert.equal(valueOf(args, '-start_number'), '0');
    assert.equal(args.at(-1), '/r/thumb_ab_%03d.jpg');
  });
});

describe('buildSlateArgs', () => {
  const options: SlateOptions = { outDir: '/hls/ch', rungs: LADDER, hasAudio: true, segmentType: 'mpegts', encoder: ENCODER };

  it('renders eight segments per variant through the channel\'s own ladder, named after what shapes them', () => {
    const args = buildSlateArgs(options);
    const id = slateId(options);
    assert.match(id, /^[a-z0-9]{10}$/);
    assert.match(valueOf(args, '-i') ?? '', /^color=.*drawtext=text='Be right back'.*\[out0\];anullsrc=r=48000:cl=stereo\[out1\]$/);
    assert.equal(valueOf(args, '-t'), '32');
    assert.equal(valueOf(args, '-b:v:0'), '5000k', 'the ladder\'s encoder settings');
    assert.equal(valueOf(args, '-hls_segment_filename'), `/hls/ch/%v/slate_${id}_%03d.ts`);
    assert.equal(valueOf(args, '-hls_playlist_type'), 'vod');
    assert.equal(valueOf(args, '-var_stream_map'), 'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:360p');
    assert.equal(args.at(-1), '/hls/ch/%v/slate.m3u8');
    assert.equal(args.includes('-master_pl_name'), false);
  });

  it('follows the channel: no audio, fMP4 init sections, and a new id when the renditions change', () => {
    const silent = buildSlateArgs({ ...options, hasAudio: false });
    assert.doesNotMatch(valueOf(silent, '-i') ?? '', /anullsrc/);
    assert.equal(valueOf(silent, '-var_stream_map'), 'v:0,name:1080p v:1,name:720p v:2,name:360p');
    const fmp4 = buildSlateArgs({ ...options, segmentType: 'fmp4' });
    assert.equal(valueOf(fmp4, '-hls_fmp4_init_filename'), `slate_${slateId({ ...options, segmentType: 'fmp4' })}_init_%v.mp4`);
    // A source below every rung gets one rendition, and ffmpeg would leave a literal "%v" in the URL.
    const single: SlateOptions = { ...options, segmentType: 'fmp4', rungs: LADDER.slice(2) };
    assert.equal(valueOf(buildSlateArgs(single), '-hls_fmp4_init_filename'), `slate_${slateId(single)}_init.mp4`);
    assert.notEqual(slateId(options), slateId({ ...options, rungs: LADDER.slice(1) }));
    const elsewhere: SlateOptions = { ...options, outDir: '/elsewhere' };
    assert.equal(slateId(options), slateId(elsewhere), 'the same slate wherever it is written');
  });
});
