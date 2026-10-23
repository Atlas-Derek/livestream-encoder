import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { silentLogger } from '../log.ts';
import { fakeSpawner, flush } from '../testing/fakes.ts';
import { parseProgressBlock, Supervisor, type ChannelState, type SupervisorOptions } from './supervisor.ts';

async function tick(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await flush();
}

function makeSupervisor(overrides: Partial<SupervisorOptions> = {}) {
  const spawner = fakeSpawner();
  const states: ChannelState[] = [];
  const supervisor = new Supervisor({
    id: 'ch',
    command: 'ffmpeg',
    prepare: async () => ['-i', 'in'],
    restart: 'always',
    listener: false,
    logger: silentLogger,
    spawn: spawner.spawn,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });
  return { supervisor, spawner, states };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
});

afterEach(() => {
  mock.timers.reset();
});

describe('parseProgressBlock', () => {
  it('parses ffmpeg -progress values', () => {
    assert.deepEqual(
      parseProgressBlock({ frame: '300', fps: '29.97', bitrate: '5123.4kbits/s', out_time_us: '10000000', speed: '1.01x' }),
      { frame: 300, fps: 29.97, bitrateKbps: 5123.4, speed: 1.01, outTimeSec: 10 },
    );
  });

  it('maps N/A and negative times to null', () => {
    const progress = parseProgressBlock({ bitrate: 'N/A', out_time_us: '-9223372036854775807' });
    assert.equal(progress.bitrateKbps, null);
    assert.equal(progress.outTimeSec, null);
  });
});

describe('Supervisor', () => {
  it('waits for a publisher, runs once output flows, and re-arms when the publisher leaves', async () => {
    const { supervisor, spawner, states } = makeSupervisor({ listener: true });
    supervisor.start();
    await flush();
    assert.equal(supervisor.state, 'waiting_for_publisher');

    spawner.last().progress(4);
    await flush();
    assert.equal(supervisor.state, 'running');
    assert.equal(supervisor.status().progress?.fps, 30);

    await tick(5_000);
    spawner.last().exit(0);
    await tick(0);
    assert.equal(spawner.children.length, 2);
    assert.equal(supervisor.state, 'waiting_for_publisher');
    assert.deepEqual(states, ['starting', 'waiting_for_publisher', 'running', 'restarting', 'starting', 'waiting_for_publisher']);
    assert.equal(supervisor.status().restarts, 1);
  });

  it('backs off exponentially between failed runs', async () => {
    const { supervisor, spawner } = makeSupervisor();
    supervisor.start();
    await flush();

    for (const delay of [1_000, 2_000, 4_000]) {
      const before = spawner.children.length;
      spawner.last().stderr.write('Connection refused\n');
      await flush();
      spawner.last().exit(1);
      await flush();
      assert.equal(supervisor.state, 'restarting');
      await tick(delay - 1);
      assert.equal(spawner.children.length, before, `no restart before ${delay}ms`);
      await tick(1);
      assert.equal(spawner.children.length, before + 1, `restart after ${delay}ms`);
    }
    assert.match(supervisor.status().lastError ?? '', /code 1: Connection refused/);
  });

  it('resets the backoff after a healthy run', async () => {
    const { supervisor, spawner } = makeSupervisor();
    supervisor.start();
    await flush();
    spawner.last().exit(1);
    await tick(1_000);
    spawner.last().exit(1);
    await tick(2_000);
    // Third run stays up past healthyResetMs, so the next failure waits the initial delay again.
    for (let t = 1; t <= 61; t++) {
      spawner.last().progress(t);
      await tick(1_000);
    }
    spawner.last().exit(1);
    await tick(1_000);
    assert.equal(spawner.children.length, 4);
  });

  it('completes on a clean exit, without restarting, for VOD and non-looping live files', async () => {
    for (const restart of ['never', 'on-failure'] as const) {
      const { supervisor, spawner } = makeSupervisor({ restart });
      supervisor.start();
      await flush();
      spawner.last().progress(4);
      await tick(5_000);
      spawner.last().exit(0);
      await tick(60_000);
      assert.equal(supervisor.state, 'completed', restart);
      assert.equal(spawner.children.length, 1, restart);
    }
  });

  it('restarts a non-looping live file after a failure', async () => {
    const { supervisor, spawner } = makeSupervisor({ restart: 'on-failure' });
    supervisor.start();
    await flush();
    spawner.last().progress(4);
    await tick(5_000);
    spawner.last().stderr.write('Error while decoding stream #0:0\n');
    await flush();
    spawner.last().exit(1);
    await flush();
    assert.equal(supervisor.state, 'restarting');
    await tick(1_000);
    assert.equal(spawner.children.length, 2);
    assert.match(supervisor.status().lastError ?? '', /code 1: Error while decoding/);
  });

  it('reports a failed VOD run as an error with the last ffmpeg line', async () => {
    const { supervisor, spawner } = makeSupervisor({ restart: 'never' });
    supervisor.start();
    await flush();
    spawner.last().stderr.write('media/missing.mp4: No such file or directory\n');
    await flush();
    spawner.last().exit(254);
    await tick(60_000);
    assert.equal(supervisor.state, 'error');
    assert.match(supervisor.status().lastError ?? '', /code 254: media\/missing\.mp4: No such file/);
    assert.equal(spawner.children.length, 1);
  });

  it('kills a stalled ffmpeg, escalating to SIGKILL, then restarts it', async () => {
    const { supervisor, spawner } = makeSupervisor({ timings: { stallTimeoutMs: 15_000, killGraceMs: 5_000 } });
    supervisor.start();
    await flush();
    spawner.last().progress(1);
    await flush();
    await tick(14_000);
    assert.deepEqual(spawner.last().signals, []);
    await tick(1_000);
    assert.deepEqual(spawner.last().signals, ['SIGTERM']);
    await tick(5_000);
    assert.deepEqual(spawner.last().signals, ['SIGTERM', 'SIGKILL']);

    spawner.last().exit(null, 'SIGKILL');
    await flush();
    assert.match(supervisor.status().lastError ?? '', /^stalled: no output progress/);
    await tick(1_000);
    assert.equal(spawner.children.length, 2);
  });

  it('does not treat a listener waiting for a publisher as stalled', async () => {
    const { supervisor, spawner } = makeSupervisor({ listener: true });
    supervisor.start();
    await flush();
    await tick(10 * 60_000);
    assert.deepEqual(spawner.last().signals, []);
    assert.equal(supervisor.state, 'waiting_for_publisher');
  });

  it('kills and re-arms when the publisher is rejected', async () => {
    const { supervisor, spawner } = makeSupervisor({
      listener: true,
      rejectPublisher: (line) => (line.includes('Unexpected stream') ? 'wrong key' : null),
    });
    supervisor.start();
    await flush();
    spawner.last().stderr.write('[rtmp @ 0x1] Unexpected stream WRONG, expecting abc\n');
    await flush();
    assert.deepEqual(spawner.last().signals, ['SIGKILL']);
    spawner.last().exit(null, 'SIGKILL');
    await tick(1_000);
    assert.equal(spawner.children.length, 2);
    assert.equal(supervisor.status().lastError, 'wrong key');
  });

  it('stops gracefully and stays stopped', async () => {
    const { supervisor, spawner } = makeSupervisor();
    supervisor.start();
    await flush();
    const stopped = supervisor.stop();
    assert.equal(supervisor.state, 'stopping');
    assert.deepEqual(spawner.last().signals, ['SIGTERM']);
    spawner.last().exit(255);
    await stopped;
    await tick(60_000);
    assert.equal(supervisor.state, 'stopped');
    assert.equal(spawner.children.length, 1);
  });

  it('relaunches a start() that arrives during stop() only after the old ffmpeg has exited', async () => {
    const { supervisor, spawner } = makeSupervisor();
    supervisor.start();
    await flush();
    const stopping = supervisor.stop();
    supervisor.start();
    await flush();
    assert.equal(spawner.children.length, 1, 'no second ffmpeg while the first is still exiting');
    await tick(5_000);
    assert.deepEqual(spawner.last().signals, ['SIGTERM', 'SIGKILL'], 'the old ffmpeg still gets SIGKILL');

    spawner.last().exit(null, 'SIGKILL');
    await stopping;
    await flush();
    assert.equal(spawner.children.length, 2);
    assert.equal(supervisor.state, 'starting');
    assert.equal(supervisor.status().lastError, null, 'the requested stop is not a failure');
  });

  it('does not kill the new run when start() arrives while stop() waits for prepare', async () => {
    const releases: Array<() => void> = [];
    const { supervisor, spawner } = makeSupervisor({
      prepare: () => new Promise<string[]>((resolve) => releases.push(() => resolve([]))),
    });
    supervisor.start();
    await flush();
    const stopping = supervisor.stop();
    supervisor.start();
    await flush();
    for (const release of releases) release();
    await stopping;
    await flush();
    assert.equal(spawner.children.length, 1);
    assert.deepEqual(spawner.last().signals, []);
    assert.equal(supervisor.state, 'starting');
  });

  it('redacts secrets from the stderr tail and the last error', async () => {
    const { supervisor, spawner } = makeSupervisor({ redact: (text) => text.replaceAll('hunter2', '***') });
    supervisor.start();
    await flush();
    spawner.last().stderr.write('Error opening input srt://x?passphrase=hunter2\n');
    await flush();
    spawner.last().exit(1);
    await flush();
    assert.deepEqual(supervisor.status().stderrTail, ['Error opening input srt://x?passphrase=***']);
    assert.match(supervisor.status().lastError ?? '', /passphrase=\*\*\*$/);
  });

  it('retries when prepare fails for a live channel and errors for VOD', async () => {
    let attempts = 0;
    const live = makeSupervisor({
      prepare: async () => {
        attempts++;
        if (attempts === 1) throw new Error('ffprobe failed');
        return [];
      },
    });
    live.supervisor.start();
    await flush();
    assert.equal(live.supervisor.state, 'restarting');
    assert.equal(live.supervisor.status().lastError, 'prepare failed: ffprobe failed');
    await tick(1_000);
    assert.equal(live.spawner.children.length, 1);

    const vod = makeSupervisor({ restart: 'never', prepare: async () => Promise.reject(new Error('input file not found')) });
    vod.supervisor.start();
    await flush();
    assert.equal(vod.supervisor.state, 'error');
    assert.equal(vod.spawner.children.length, 0);
  });

  it('waits for an in-flight prepare on stop(), then does not spawn', async () => {
    let release = (): void => {};
    const { supervisor, spawner } = makeSupervisor({
      prepare: () => new Promise<string[]>((resolve) => {
        release = () => resolve([]);
      }),
    });
    supervisor.start();
    await flush();
    let stopped = false;
    const stopping = (async () => {
      await supervisor.stop();
      stopped = true;
    })();
    await flush();
    assert.equal(stopped, false, 'stop() must not return while prepare() may still write the output dir');
    release();
    await stopping;
    assert.equal(spawner.children.length, 0);
    assert.equal(supervisor.state, 'stopped');
  });
});
