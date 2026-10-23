import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { Logger } from '../log.ts';

export type ChannelState =
  | 'idle'
  | 'starting'
  | 'waiting_for_publisher'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'error';

/** The parts of ChildProcess the supervisor uses; tests pass a fake. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (command: string, args: readonly string[]) => ChildLike;

export const defaultSpawn: SpawnFn = (command, args) => nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * always: restart on every exit (pull, looping files, listeners re-arming after a publisher leaves).
 * on-failure: a clean exit means the input ended (live playout of a non-looping file).
 * never: run once (VOD).
 */
export type RestartPolicy = 'always' | 'on-failure' | 'never';

export interface SupervisorTimings {
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** A run at least this long resets the backoff. */
  healthyResetMs: number;
  /** Kill ffmpeg if out_time stops advancing for this long. */
  stallTimeoutMs: number;
  /** Delay between SIGTERM and SIGKILL. */
  killGraceMs: number;
  watchdogIntervalMs: number;
  /** A listener exiting cleanly faster than this counts as a failure, not a publisher leaving. */
  minCleanRunMs: number;
  /** Real-time channels: the window over which output speed is measured against the wall clock. */
  realtimeWindowMs: number;
}

export const DEFAULT_TIMINGS: SupervisorTimings = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  healthyResetMs: 60_000,
  stallTimeoutMs: 15_000,
  killGraceMs: 5_000,
  watchdogIntervalMs: 1_000,
  minCleanRunMs: 1_000,
  realtimeWindowMs: 120_000,
};

/**
 * A real-time channel whose output advances slower than this, over the window, gets a warning; it clears at
 * RECOVERED_AT. Progress arrives every 0.5s, which bounds the measurement's error at about 0.5s per half window.
 */
const FALLING_BEHIND_BELOW = 0.97;
const RECOVERED_AT = 0.99;

export interface Progress {
  frame: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  speed: number | null;
  outTimeSec: number | null;
}

export interface SupervisorStatus {
  state: ChannelState;
  pid: number | null;
  /** When the current run started producing output. */
  runningSince: string | null;
  uptimeSec: number | null;
  restarts: number;
  /** Most recent failure; kept after recovery as history, so check lastErrorAt against runningSince. */
  lastError: string | null;
  lastErrorAt: string | null;
  progress: Progress | null;
  /**
   * Real-time channels: output media seconds per wall-clock second over the last realtimeWindowMs, measured on how the
   * lag behind the wall clock grows, so input arriving in bursts (a segment at a time) reads 1; null until the run has
   * that much history. ffmpeg's own speed is an average since it started, so it hides a recent slowdown.
   */
  realtimeFactor: number | null;
  /**
   * Problems that don't stop the channel, such as a real-time channel falling behind: it still runs, but players
   * rebuffer and latency grows. Empty when there are none.
   */
  warnings: string[];
  stderrTail: string[];
}

export interface SupervisorOptions {
  id: string;
  command: string;
  /** Runs before every spawn (re-probe, prepare output dirs) and returns fresh args. */
  prepare: () => Promise<string[]>;
  restart: RestartPolicy;
  /** rtmp/srt: ffmpeg waits for a publisher, so the stall watchdog is off until output flows. */
  listener: boolean;
  /** Input arrives at real time (live channels), so output slower than that is reported as falling behind. */
  realtime?: boolean;
  /** Returns a reason when a stderr line means the publisher must be dropped (killed and re-armed). */
  rejectPublisher?: (line: string) => string | null;
  /** Masks secrets (passphrases, URL credentials) in logged args, stderr lines and error messages. */
  redact?: (text: string) => string;
  logger: Logger;
  spawn?: SpawnFn;
  timings?: Partial<SupervisorTimings>;
  onStateChange?: (state: ChannelState) => void;
  onPid?: (pid: number | null) => void;
}

const STDERR_TAIL_LINES = 50;

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Parses one `-progress` block (key=value lines up to `progress=continue|end`). */
export function parseProgressBlock(block: Record<string, string>): Progress {
  const outTimeUs = toNumber(block.out_time_us);
  return {
    frame: toNumber(block.frame),
    fps: toNumber(block.fps),
    bitrateKbps: toNumber(block.bitrate), // "5123.4kbits/s"
    speed: toNumber(block.speed), // "1.01x"
    outTimeSec: outTimeUs === null || outTimeUs < 0 ? null : outTimeUs / 1_000_000,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Owns one ffmpeg child: spawns it, tracks progress, and restarts it according to its policy. */
export class Supervisor {
  readonly #opts: SupervisorOptions;
  readonly #timings: SupervisorTimings;
  readonly #spawn: SpawnFn;
  readonly #redact: (text: string) => string;

  #state: ChannelState = 'idle';
  #desired: 'running' | 'stopped' = 'stopped';
  /** Bumped by start/stop so an in-flight prepare() can tell it has been superseded. */
  #generation = 0;
  #child: ChildLike | null = null;
  /** The in-flight launch, so stop() can wait for prepare() to finish touching the output directory. */
  #launching: Promise<void> | null = null;
  #spawnedAt: number | null = null;
  #runningSince: number | null = null;

  #restartTimer: NodeJS.Timeout | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;

  #restarts = 0;
  #consecutiveFailures = 0;
  #lastError: string | null = null;
  #lastErrorAt: number | null = null;
  #rejection: string | null = null;
  #stallReason: string | null = null;
  /** Set by stop() for the child it terminates, so that exit isn't a failure even if start() runs before it. */
  #stopRequested = false;

  #progress: Progress | null = null;
  #progressBlock: Record<string, string> = {};
  #lastOutTime: number | null = null;
  #lastAdvanceAt = 0;
  /** (wall ms, out_time) pairs covering the last realtimeWindowMs, oldest first. */
  #samples: Array<{ at: number; outTime: number }> = [];
  #realtimeFactor: number | null = null;
  /** The falling-behind warning while it lasts. */
  #fallingBehind: string | null = null;
  #stderrTail: string[] = [];
  #exitWaiters: Array<() => void> = [];

  constructor(options: SupervisorOptions) {
    this.#opts = options;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#redact = options.redact ?? ((text) => text);
  }

  get state(): ChannelState {
    return this.#state;
  }

  status(): SupervisorStatus {
    return {
      state: this.#state,
      pid: this.#child?.pid ?? null,
      runningSince: this.#runningSince === null ? null : new Date(this.#runningSince).toISOString(),
      uptimeSec: this.#runningSince === null ? null : Math.round((Date.now() - this.#runningSince) / 1000),
      restarts: this.#restarts,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt === null ? null : new Date(this.#lastErrorAt).toISOString(),
      progress: this.#progress,
      realtimeFactor: this.#realtimeFactor === null ? null : Math.round(this.#realtimeFactor * 1000) / 1000,
      warnings: this.#fallingBehind === null ? [] : [this.#fallingBehind],
      stderrTail: [...this.#stderrTail],
    };
  }

  start(): void {
    if (this.#desired === 'running') return;
    this.#desired = 'running';
    this.#consecutiveFailures = 0;
    this.#lastError = null;
    this.#lastErrorAt = null;
    // A stop() is still waiting for ffmpeg to exit; #afterExit relaunches then, so two never run at once.
    if (this.#child !== null) return;
    this.#run();
  }

  async stop(): Promise<void> {
    this.#desired = 'stopped';
    this.#generation++;
    this.#clearRestartTimer();
    if (this.#launching !== null) await this.#launching; // it sees the new generation and won't spawn
    if (this.#desired !== 'stopped') return; // start() was called meanwhile; its run must not be killed
    const child = this.#child;
    if (child === null) {
      if (this.#state !== 'completed' && this.#state !== 'error' && this.#state !== 'idle') this.#setState('stopped');
      return;
    }
    this.#setState('stopping');
    this.#stopRequested = true;
    const exited = new Promise<void>((resolve) => this.#exitWaiters.push(resolve));
    this.#terminate(child, 'SIGTERM');
    await exited;
  }

  #run(): void {
    const launch = this.#launch();
    this.#launching = launch;
    void (async () => {
      await launch;
      if (this.#launching === launch) this.#launching = null;
    })();
  }

  async #launch(): Promise<void> {
    const generation = ++this.#generation;
    this.#setState('starting');

    let args: string[];
    try {
      args = await this.#opts.prepare();
    } catch (err) {
      if (generation !== this.#generation) return;
      this.#handleFailure(`prepare failed: ${errorMessage(err)}`, 0);
      return;
    }
    if (generation !== this.#generation || this.#desired !== 'running') return;

    let child: ChildLike;
    try {
      child = this.#spawn(this.#opts.command, args);
    } catch (err) {
      this.#handleFailure(`spawn failed: ${errorMessage(err)}`, 0);
      return;
    }

    this.#child = child;
    this.#spawnedAt = Date.now();
    this.#runningSince = null;
    this.#progress = null;
    this.#progressBlock = {};
    this.#lastOutTime = null;
    this.#lastAdvanceAt = Date.now();
    this.#resetRealtime();
    this.#rejection = null;
    this.#stallReason = null;
    this.#opts.onPid?.(child.pid ?? null);
    this.#opts.logger.info({ channel: this.#opts.id, ffmpegPid: child.pid, args: args.map(this.#redact) }, 'ffmpeg spawned');
    this.#setState(this.#opts.listener ? 'waiting_for_publisher' : 'starting');

    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (line) => this.#onProgressLine(line));
    if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', (line) => this.#onStderrLine(line));
    child.once('error', (err) => this.#onExit(child, null, null, `ffmpeg process error: ${err.message}`));
    child.once('close', (code, signal) => this.#onExit(child, code, signal, null));
    this.#startWatchdog(child);
  }

  #onProgressLine(line: string): void {
    const eq = line.indexOf('=');
    if (eq <= 0) return;
    const key = line.slice(0, eq).trim();
    this.#progressBlock[key] = line.slice(eq + 1).trim();
    if (key !== 'progress') return;

    this.#progress = parseProgressBlock(this.#progressBlock);
    this.#progressBlock = {};
    const outTime = this.#progress.outTimeSec;
    if (outTime !== null && outTime > 0 && (this.#lastOutTime === null || outTime > this.#lastOutTime)) {
      this.#lastOutTime = outTime;
      this.#lastAdvanceAt = Date.now();
      if (this.#state === 'starting' || this.#state === 'waiting_for_publisher') {
        this.#runningSince = Date.now();
        this.#setState('running');
      }
    }
    if (this.#opts.realtime === true && this.#lastOutTime !== null) this.#measureRealtime(this.#lastOutTime);
  }

  #measureRealtime(outTime: number): void {
    const now = Date.now();
    const windowMs = this.#timings.realtimeWindowMs;
    this.#samples.push({ at: now, outTime });
    // Keep one sample at or before the window's start, so the measured span covers the whole window.
    while (this.#samples.length > 1 && (this.#samples[1]?.at ?? now) <= now - windowMs) this.#samples.shift();
    const oldest = this.#samples[0];
    if (oldest === undefined || now - oldest.at < windowMs) return;
    // How far output lags behind the wall clock since the oldest sample. Input that arrives a segment at a time (an
    // HLS pull) makes the lag rise and fall by a segment without growing, and a plain rate over the window then read
    // 0.93 or 1.06 by turns for a healthy pull. So compare the lag's lowest point in each half of the window: it grows
    // only when the channel really falls behind, by exactly (1 - speed) per second for a steady slowdown.
    const halfMs = (now - oldest.at) / 2;
    let firstHalf = Number.POSITIVE_INFINITY;
    let secondHalf = Number.POSITIVE_INFINITY;
    for (const sample of this.#samples) {
      const lag = (sample.at - oldest.at) / 1000 - (sample.outTime - oldest.outTime);
      if (sample.at - oldest.at < halfMs) firstHalf = Math.min(firstHalf, lag);
      else secondHalf = Math.min(secondHalf, lag);
    }
    const factor = 1 - (secondHalf - firstHalf) / (halfMs / 1000);
    this.#realtimeFactor = factor;

    const behind = this.#fallingBehind === null ? factor < FALLING_BEHIND_BELOW : factor < RECOVERED_AT;
    if (behind) {
      if (this.#fallingBehind === null) {
        this.#opts.logger.warn({ channel: this.#opts.id, realtimeFactor: factor }, 'falling behind real time');
      }
      // Kept current while it lasts.
      this.#fallingBehind =
        `falling behind: output at ${factor.toFixed(2)}x real time over the last ${Math.round(windowMs / 1000)}s ` +
        '(the encoder is too slow for the ladder, or the input is arriving late)';
    } else if (this.#fallingBehind !== null) {
      this.#fallingBehind = null;
      this.#opts.logger.info({ channel: this.#opts.id, realtimeFactor: factor }, 'caught up with real time');
    }
  }

  #resetRealtime(): void {
    this.#samples = [];
    this.#realtimeFactor = null;
    this.#fallingBehind = null;
  }

  #onStderrLine(raw: string): void {
    if (raw.trim() === '') return;
    // ffmpeg echoes input URLs in its errors, and the tail is served by the API.
    const line = this.#redact(raw);
    this.#stderrTail.push(line);
    if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
    this.#opts.logger.debug({ channel: this.#opts.id, ffmpeg: line }, 'ffmpeg stderr');

    const child = this.#child;
    const reason = this.#opts.rejectPublisher?.(raw) ?? null;
    if (reason !== null && child !== null && this.#rejection === null) {
      this.#rejection = reason;
      this.#opts.logger.warn({ channel: this.#opts.id, reason }, 'rejecting publisher');
      // SIGKILL so ffmpeg can't flush the rejected publisher's frames into the playlist.
      this.#terminate(child, 'SIGKILL');
    }
  }

  #startWatchdog(child: ChildLike): void {
    this.#stopWatchdog();
    this.#watchdog = setInterval(() => {
      if (this.#child !== child || this.#stallReason !== null) return;
      if (this.#state !== 'starting' && this.#state !== 'running') return; // a listener may wait forever
      const idleMs = Date.now() - this.#lastAdvanceAt;
      if (idleMs >= this.#timings.stallTimeoutMs) {
        this.#stallReason = `stalled: no output progress for ${Math.round(idleMs / 1000)}s`;
        this.#opts.logger.warn({ channel: this.#opts.id, idleMs }, 'ffmpeg stalled, killing');
        this.#terminate(child, 'SIGTERM');
      }
    }, this.#timings.watchdogIntervalMs);
  }

  #stopWatchdog(): void {
    if (this.#watchdog !== null) clearInterval(this.#watchdog);
    this.#watchdog = null;
  }

  #terminate(child: ChildLike, signal: NodeJS.Signals): void {
    child.kill(signal);
    if (signal === 'SIGKILL' || this.#killTimer !== null) return;
    this.#killTimer = setTimeout(() => {
      this.#killTimer = null;
      if (this.#child === child) child.kill('SIGKILL');
    }, this.#timings.killGraceMs);
  }

  #onExit(child: ChildLike, code: number | null, signal: NodeJS.Signals | null, processError: string | null): void {
    if (this.#child !== child) return; // 'error' and 'close' can both fire
    this.#child = null;
    if (this.#killTimer !== null) clearTimeout(this.#killTimer);
    this.#killTimer = null;
    this.#stopWatchdog();
    this.#opts.onPid?.(null);
    const stopRequested = this.#stopRequested;
    this.#stopRequested = false;
    const ranMs = this.#spawnedAt === null ? 0 : Date.now() - this.#spawnedAt;
    this.#spawnedAt = null;
    this.#runningSince = null;
    this.#resetRealtime();
    this.#opts.logger.info({ channel: this.#opts.id, code, signal, ranMs }, 'ffmpeg exited');

    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    try {
      this.#afterExit(code, signal, processError, ranMs, stopRequested);
    } finally {
      for (const resolve of waiters) resolve();
    }
  }

  #afterExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    processError: string | null,
    ranMs: number,
    stopRequested: boolean,
  ): void {
    if (stopRequested || this.#desired === 'stopped') {
      if (this.#desired === 'running') this.#run(); // start() arrived while stop() waited for this exit
      else this.#setState('stopped');
      return;
    }

    if (this.#rejection !== null) {
      this.#recordError(this.#rejection);
      this.#scheduleRestart(this.#timings.initialBackoffMs);
      return;
    }

    const clean = code === 0 && processError === null && this.#stallReason === null;
    if (clean && this.#opts.listener && ranMs >= this.#timings.minCleanRunMs) {
      this.#opts.logger.info({ channel: this.#opts.id }, 'publisher disconnected, re-arming listener');
      this.#consecutiveFailures = 0;
      this.#scheduleRestart(0);
      return;
    }
    if (clean && this.#opts.restart !== 'always') {
      this.#desired = 'stopped';
      this.#setState('completed');
      return;
    }

    const lastLine = this.#stderrTail.at(-1);
    // A clean exit after output flowed means the input ended (a pull source's upstream stopped). Media time, not
    // wall time: an unpaced finite source can encode minutes of output in seconds.
    const cleanReason =
      this.#lastOutTime === null
        ? 'ffmpeg exited before producing output'
        : `input ended: ffmpeg exited cleanly after ${Math.round(this.#lastOutTime)}s of output`;
    const reason =
      processError ??
      this.#stallReason ??
      (clean
        ? cleanReason
        : `ffmpeg exited with ${signal === null ? `code ${code}` : `signal ${signal}`}${lastLine ? `: ${lastLine}` : ''}`);
    this.#handleFailure(reason, ranMs);
  }

  #handleFailure(unredacted: string, ranMs: number): void {
    const reason = this.#redact(unredacted); // prepare errors can quote ffprobe's stderr, URL included
    this.#recordError(reason);
    this.#opts.logger.error({ channel: this.#opts.id, reason }, 'ffmpeg run failed');
    if (this.#opts.restart === 'never' || this.#desired === 'stopped') {
      this.#desired = 'stopped';
      this.#setState('error');
      return;
    }
    if (ranMs >= this.#timings.healthyResetMs) this.#consecutiveFailures = 0;
    const delay = Math.min(this.#timings.initialBackoffMs * 2 ** this.#consecutiveFailures, this.#timings.maxBackoffMs);
    this.#consecutiveFailures++;
    this.#scheduleRestart(delay);
  }

  #recordError(reason: string): void {
    this.#lastError = reason;
    this.#lastErrorAt = Date.now();
  }

  #scheduleRestart(delayMs: number): void {
    this.#clearRestartTimer();
    this.#restarts++;
    this.#setState('restarting');
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#desired === 'running') this.#run();
    }, delayMs);
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #setState(state: ChannelState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#opts.onStateChange?.(state);
  }
}
