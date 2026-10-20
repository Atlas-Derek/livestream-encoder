import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFrameRate, parseProbeOutput } from './probe.ts';

describe('parseFrameRate', () => {
  it('handles fractional and integer rates', () => {
    assert.equal(parseFrameRate('30/1'), 30);
    assert.ok(Math.abs((parseFrameRate('30000/1001') ?? 0) - 29.97) < 0.01);
    assert.equal(parseFrameRate('25'), 25);
  });

  it('returns null for unknown rates', () => {
    assert.equal(parseFrameRate('0/0'), null);
    assert.equal(parseFrameRate(undefined), null);
  });
});

describe('parseProbeOutput', () => {
  it('extracts video and audio details', () => {
    const result = parseProbeOutput({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '0/0', r_frame_rate: '25/1' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    assert.deepEqual(result, { width: 1280, height: 720, fps: 25, videoCodec: 'h264', audioCodec: 'aac' });
  });

  it('tolerates missing streams', () => {
    assert.deepEqual(parseProbeOutput({}), { width: null, height: null, fps: null, videoCodec: null, audioCodec: null });
  });
});
