import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChannelStatus } from '../channels/manager.ts';
import { ChannelSpecSchema } from '../channels/schema.ts';
import { formatMetrics } from './metrics.ts';

function channel(id: string, extra: Partial<ChannelStatus> = {}): ChannelStatus {
  return {
    id, recording: null, spec: ChannelSpecSchema.parse({ id, input: { type: 'srt' } }), port: 9000, desired: 'running',
    completedAt: null, ingestUrl: null, playbackUrl: '', state: 'running', pid: 1, runningSince: null, uptimeSec: 120,
    restarts: 2, lastError: null, lastErrorAt: null, realtimeFactor: 0.998, warnings: [], stderrTail: [],
    progress: { frame: 1, fps: 30, bitrateKbps: 10450.2, speed: 1, outTimeSec: 120 },
    ...extra,
  };
}

describe('formatMetrics', () => {
  it('writes one sample per channel, the state one-hot, and skips values a channel does not have', () => {
    const text = formatMetrics([
      channel('a'),
      channel('b', { state: 'waiting_for_publisher', progress: null, realtimeFactor: null, uptimeSec: null, warnings: ['x'] }),
    ]);
    assert.match(text, /^# TYPE lse_channel_state gauge$/m);
    assert.match(text, /^lse_channel_state\{channel="a",state="running"\} 1$/m);
    assert.match(text, /^lse_channel_state\{channel="a",state="error"\} 0$/m);
    assert.match(text, /^lse_channel_state\{channel="b",state="waiting_for_publisher"\} 1$/m);
    assert.match(text, /^# TYPE lse_channel_restarts_total counter$/m);
    assert.match(text, /^lse_channel_realtime_factor\{channel="a"\} 0\.998$/m);
    assert.doesNotMatch(text, /lse_channel_realtime_factor\{channel="b"\}/);
    assert.match(text, /^lse_channel_warnings\{channel="b"\} 1$/m);
    assert.doesNotMatch(text, /lse_channel_recording\{/, 'only channels that record');
    assert.ok(text.endsWith('\n'));
  });

  it('reports whether recording channels are writing a recording', () => {
    const spec = ChannelSpecSchema.parse({ id: 'r', input: { type: 'srt' }, record: true });
    assert.match(formatMetrics([channel('r', { spec, recording: '20261023T160000Z' })]), /^lse_channel_recording\{channel="r"\} 1$/m);
  });
});
