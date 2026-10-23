import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channelBaseUrl, playbackExpiry, playbackToken } from './playback.ts';

describe('signed playback URLs', () => {
  it('computes the token nginx\'s secure_link_md5 expects', () => {
    // nginx 1.31 answered 200 for this one (and 403 for any other token).
    assert.equal(playbackToken('sec', 1792810800, 'test-secret-0123456789'), '1MHBzrOY4nI2kvG-4ZUScA');
  });

  it('rounds the expiry up to the hour', () => {
    const now = Date.parse('2026-10-23T20:10:00Z');
    assert.equal(new Date(playbackExpiry(now, 60) * 1000).toISOString(), '2026-10-23T21:00:00.000Z');
    assert.equal(new Date(playbackExpiry(now, 6 * 3600) * 1000).toISOString(), '2026-10-24T03:00:00.000Z');
  });

  it('signs a channel\'s base URL only when a secret is set', () => {
    assert.equal(channelBaseUrl('http://h/hls', 'sec', null, 1), 'http://h/hls/sec');
    assert.equal(
      channelBaseUrl('http://h/hls', 'sec', 'test-secret-0123456789', 1792810800),
      'http://h/hls/_s/1792810800/1MHBzrOY4nI2kvG-4ZUScA/sec',
    );
  });
});
