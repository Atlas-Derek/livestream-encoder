/** Test doubles shared by supervisor and manager tests. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnFn } from '../ffmpeg/supervisor.ts';

export class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  /** Exit as ffmpeg would when signalled, instead of waiting for the test to call exit(). */
  readonly exitOnKill: boolean;

  constructor(pid: number, exitOnKill = false) {
    super();
    this.pid = pid;
    this.exitOnKill = exitOnKill;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exitOnKill) setImmediate(() => this.exit(signal === 'SIGKILL' ? null : 255, signal === 'SIGKILL' ? signal : null));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  progress(outTimeSec: number): void {
    this.stdout.write(
      `frame=${outTimeSec * 30}\nfps=30.00\nbitrate=5000.1kbits/s\nout_time_us=${outTimeSec * 1_000_000}\nspeed=1.01x\nprogress=continue\n`,
    );
  }
}

export function fakeSpawner(options: { exitOnKill?: boolean } = {}) {
  const children: FakeChild[] = [];
  const calls: string[][] = [];
  const spawn: SpawnFn = (_command, args) => {
    const child = new FakeChild(1000 + children.length, options.exitOnKill ?? false);
    children.push(child);
    calls.push([...args]);
    return child;
  };
  const last = (): FakeChild => {
    const child = children.at(-1);
    if (!child) throw new Error('nothing spawned yet');
    return child;
  };
  return { spawn, children, calls, last };
}

/** Lets pending promises and stream 'line' events run (setImmediate is not mocked). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Polls with real timers until the condition holds; for code paths that wait on real file system I/O. */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
