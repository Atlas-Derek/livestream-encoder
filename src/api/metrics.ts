import type { ChannelStatus } from '../channels/manager.ts';
import type { ChannelState } from '../ffmpeg/supervisor.ts';

const STATES: ChannelState[] = [
  'idle', 'starting', 'waiting_for_publisher', 'running', 'restarting', 'stopping', 'stopped', 'completed', 'error',
];

interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Array<{ labels: Record<string, string>; value: number }>;
}

/** Prometheus label values escape backslash, double quote and newline. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function format(metrics: Metric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
    for (const { labels, value } of metric.samples) {
      const pairs = Object.entries(labels).map(([key, v]) => `${key}="${escapeLabel(v)}"`);
      lines.push(`${metric.name}{${pairs.join(',')}} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** One sample per channel, skipping channels without a value. */
function perChannel(
  name: string,
  help: string,
  type: Metric['type'],
  channels: ChannelStatus[],
  value: (channel: ChannelStatus) => number | null,
): Metric {
  return {
    name,
    help,
    type,
    samples: channels.flatMap((c) => {
      const v = value(c);
      return v === null ? [] : [{ labels: { channel: c.id }, value: v }];
    }),
  };
}

/** Pure: GET /metrics, in Prometheus's text format, from the channels' status. */
export function formatMetrics(channels: ChannelStatus[]): string {
  const recording = channels.filter((c) => c.spec.mode === 'live' && c.spec.record);
  return format([
    {
      name: 'lse_channel_state',
      help: 'The channel state: 1 for the current one.',
      type: 'gauge',
      samples: channels.flatMap((c) =>
        STATES.map((state) => ({ labels: { channel: c.id, state }, value: c.state === state ? 1 : 0 })),
      ),
    },
    perChannel('lse_channel_desired_running', '1 if the channel should be running, 0 if stopped or completed.', 'gauge',
      channels, (c) => (c.desired === 'running' ? 1 : 0)),
    perChannel('lse_channel_restarts_total', 'ffmpeg restarts since the API started.', 'counter', channels, (c) => c.restarts),
    perChannel('lse_channel_uptime_seconds', 'Seconds since the current run started producing output.', 'gauge',
      channels, (c) => c.uptimeSec),
    perChannel('lse_channel_realtime_factor',
      'Live channels: output seconds per wall-clock second over the last 30s. Below 0.97 it is falling behind.', 'gauge',
      channels, (c) => c.realtimeFactor),
    perChannel('lse_channel_fps', 'Frames per second ffmpeg is encoding.', 'gauge', channels, (c) => c.progress?.fps ?? null),
    perChannel('lse_channel_warnings', 'Problems that do not stop the channel (see GET /channels/:id).', 'gauge',
      channels, (c) => c.warnings.length),
    perChannel('lse_channel_recording', '1 while a recording channel is writing a recording.', 'gauge',
      recording, (c) => (c.recording === null ? 0 : 1)),
  ]);
}
