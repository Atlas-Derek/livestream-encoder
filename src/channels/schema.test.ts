import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelSpecSchema } from './schema.ts';

describe('ChannelSpecSchema', () => {
  it('only allows vod for non-looping files', () => {
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'rtmp', streamKey: 'k' }, mode: 'vod' }).success, false);
    assert.equal(
      ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'file', path: 'x', loop: true }, mode: 'vod' }).success,
      false,
    );
  });

  it('rejects options passthrough cannot honour', () => {
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt' }, passthrough: true, debugOverlay: true }).success, false);
    const ladder = [{ name: '720p', height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128 }];
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt' }, passthrough: true, ladder }).success, false);
  });

  it('defaults to live mpegts with the default ladder', () => {
    const parsed = ChannelSpecSchema.parse({ id: 'a', input: { type: 'srt' } });
    assert.equal(parsed.mode, 'live');
    assert.equal(parsed.segmentType, 'mpegts');
    assert.equal(parsed.ladder, undefined);
  });

  it('records live channels only, and keeps the recordings directory name out of ladders', () => {
    assert.equal(ChannelSpecSchema.parse({ id: 'a', input: { type: 'srt' } }).record, false);
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt' }, record: true }).success, true);
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'file', path: 'a.mp4' }, mode: 'vod', record: true }).success, false);
    const ladder = [{ name: 'recordings', height: 720, videoBitrateKbps: 1, audioBitrateKbps: 1 }];
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt' }, ladder }).success, false);
  });

  it('encrypts MPEG-TS only, which is all ffmpeg can encrypt', () => {
    assert.equal(ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt' }, encrypt: true }).success, true);
    const fmp4 = ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt' }, encrypt: true, segmentType: 'fmp4' });
    assert.match(fmp4.error?.issues[0]?.message ?? '', /cannot encrypt fMP4/);
  });

  it('makes thumbnails for VOD output and for any live channel\'s recordings, on demand ones included', () => {
    const parse = (extra: Record<string, unknown>) => ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'file', path: 'a.mp4' }, ...extra });
    assert.equal(parse({ thumbnails: true, mode: 'vod' }).success, true);
    assert.equal(parse({ thumbnails: true, record: true }).success, true);
    assert.equal(parse({ thumbnails: true }).success, true);
  });

  it('allows a DVR window on live channels only', () => {
    const parse = (extra: Record<string, unknown>) => ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'file', path: 'a.mp4' }, ...extra });
    assert.equal(parse({ dvrWindowSeconds: 3600 }).success, true);
    assert.equal(parse({ dvrWindowSeconds: 3600, mode: 'vod' }).success, false);
    assert.equal(parse({ dvrWindowSeconds: 7 * 3600 }).success, false);
  });

  it('gives SRT inputs an internet-sized latency by default, within libsrt-sane bounds', () => {
    const input = (extra: Record<string, unknown> = {}) => ChannelSpecSchema.safeParse({ id: 'a', input: { type: 'srt', ...extra } });
    assert.deepEqual(input().data?.input, { type: 'srt', latencyMs: 1000, audio: true });
    assert.equal(input({ latencyMs: 120 }).success, true);
    assert.equal(input({ latencyMs: 5 }).success, false);
    assert.equal(input({ latencyMs: 1.5 }).success, false);
  });

  it('keeps pull channels reconnecting unless loop is turned off', () => {
    // Also what channels.json written before the option existed parses to.
    assert.deepEqual(ChannelSpecSchema.parse({ id: 'a', input: { type: 'pull', url: 'rtsp://cam/s' } }).input, {
      type: 'pull', url: 'rtsp://cam/s', loop: true,
    });
    const once = { type: 'pull', url: 'https://x/clip.mp4', loop: false };
    assert.deepEqual(ChannelSpecSchema.parse({ id: 'a', input: once }).input, once);
  });
});
