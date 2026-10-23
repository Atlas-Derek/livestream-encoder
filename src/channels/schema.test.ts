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
});
