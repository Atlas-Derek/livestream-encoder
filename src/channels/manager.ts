import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { buildArgs, redactSecrets } from '../ffmpeg/buildArgs.ts';
import { killStaleFfmpeg, writePidFile } from '../ffmpeg/pids.ts';
import { createProbe, createSegmentStreamProbe, type ProbeFn } from '../ffmpeg/probe.ts';
import { fillMissingCodecs, type ProbeSegmentStreams } from '../hls/codecs.ts';
import { MASTER_PLAYLIST } from '../hls/playlist.ts';
import {
  Supervisor,
  type ChannelState,
  type RestartPolicy,
  type SpawnFn,
  type SupervisorStatus,
  type SupervisorTimings,
} from '../ffmpeg/supervisor.ts';
import { PlaylistPublisher } from '../hls/publisher.ts';
import type { Logger } from '../log.ts';
import { prepareOutputDir, removeOutputDir } from './output.ts';
import { ChannelSpecSchema, type ChannelSpec, type Rung } from './schema.ts';

const ChannelRecordSchema = z.object({
  spec: ChannelSpecSchema,
  port: z.number().int().positive().nullable(),
  desired: z.enum(['running', 'stopped']),
  /** Set when a VOD encode finishes, so it isn't re-encoded on the next boot. */
  completedAt: z.string().nullable(),
});
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>;

const StoreSchema = z.object({ channels: z.array(ChannelRecordSchema) });

export interface ChannelStatus extends SupervisorStatus {
  id: string;
  spec: ChannelSpec;
  port: number | null;
  desired: ChannelRecord['desired'];
  completedAt: string | null;
  ingestUrl: string | null;
  playbackUrl: string;
}

export interface ManagerDeps {
  config: Config;
  logger: Logger;
  defaultLadder: Rung[];
  probe?: ProbeFn;
  /** Reads an output segment's codec configuration, to add the CODECS ffmpeg leaves out (HEVC). */
  probeStreams?: ProbeSegmentStreams;
  spawn?: SpawnFn;
  timings?: Partial<SupervisorTimings>;
  killStale?: (pidDir: string) => Promise<unknown>;
}

interface Entry {
  record: ChannelRecord;
  supervisor: Supervisor;
  /** Live channels only; VOD playlists are served as ffmpeg writes them. */
  publisher: PlaylistPublisher | null;
}

/** States in which ffmpeg may be writing playlists, so the publisher keeps polling. */
const PUBLISHING_STATES = new Set<ChannelState>(['starting', 'waiting_for_publisher', 'running', 'restarting', 'stopping']);

/** ffmpeg only warns about a wrong RTMP stream key and accepts the publish anyway, so enforce it here. */
export function rejectWrongStreamKey(line: string): string | null {
  return /Unexpected stream \S+, expecting/.test(line) ? 'rejected publisher with wrong stream key' : null;
}

/**
 * A push channel maps audio unless created with audio: false. A video-only publisher makes ffmpeg fail with
 * "Stream map '' matches no streams" on every reconnect, so say what to change instead.
 */
export function rejectMissingAudio(line: string): string | null {
  return /^Stream map '.*' matches no streams/.test(line)
    ? 'publisher sent no audio; recreate the channel with "audio": false in its input for a video-only source'
    : null;
}

function publisherCheck(spec: ChannelSpec): ((line: string) => string | null) | null {
  const { input } = spec;
  if (input.type !== 'rtmp' && input.type !== 'srt') return null;
  const checks = [...(input.type === 'rtmp' ? [rejectWrongStreamKey] : []), ...(input.audio ? [rejectMissingAudio] : [])];
  if (checks.length === 0) return null;
  return (line) => {
    for (const check of checks) {
      const reason = check(line);
      if (reason !== null) return reason;
    }
    return null;
  };
}

function restartPolicy(spec: ChannelSpec): RestartPolicy {
  if (spec.mode === 'vod') return 'never';
  if (spec.input.type === 'file' && !spec.input.loop) return 'on-failure';
  return 'always';
}

function redact(spec: ChannelSpec): ChannelSpec {
  if (spec.input.type === 'srt' && spec.input.passphrase !== undefined) {
    return { ...spec, input: { ...spec.input, passphrase: '********' } };
  }
  if (spec.input.type === 'pull') return { ...spec, input: { ...spec.input, url: redactSecrets(spec.input.url) } };
  return spec;
}

export class ChannelManager {
  readonly #deps: ManagerDeps;
  readonly #probe: ProbeFn;
  readonly #probeStreams: ProbeSegmentStreams;
  /** CODECS fills of finished VOD masters, so shutdown() can wait for them. */
  readonly #codecFills = new Set<Promise<void>>();
  readonly #entries = new Map<string, Entry>();
  #writing: Promise<void> = Promise.resolve();
  readonly #pidWrites = new Set<Promise<void>>();

  constructor(deps: ManagerDeps) {
    this.#deps = deps;
    this.#probe = deps.probe ?? createProbe(deps.config.ffprobePath);
    this.#probeStreams = deps.probeStreams ?? createSegmentStreamProbe(deps.config.ffprobePath);
  }

  get #storePath(): string {
    return path.join(this.#deps.config.varDir, 'channels.json');
  }

  get #pidDir(): string {
    return path.join(this.#deps.config.varDir, 'pids');
  }

  async init(): Promise<void> {
    const { config, logger } = this.#deps;
    await mkdir(config.hlsRoot, { recursive: true });
    await (this.#deps.killStale ?? ((dir: string) => killStaleFfmpeg(dir, logger)))(this.#pidDir);

    for (const record of await this.#load()) {
      this.#entries.set(record.spec.id, this.#makeEntry(record));
      if (record.desired === 'running' && record.completedAt === null) this.#supervisor(record.spec.id).start();
    }
    logger.info({ channels: this.#entries.size }, 'channels loaded');
  }

  list(): ChannelStatus[] {
    return [...this.#entries.values()].map((entry) => this.#status(entry));
  }

  get(id: string): ChannelStatus {
    return this.#status(this.#entry(id));
  }

  async create(spec: ChannelSpec): Promise<ChannelStatus> {
    if (this.#entries.has(spec.id)) throw new AppError(`channel "${spec.id}" already exists`, 409);
    const record: ChannelRecord = { spec, port: this.#allocatePort(spec), desired: 'running', completedAt: null };
    const entry = this.#makeEntry(record);
    this.#entries.set(spec.id, entry);
    await this.#persist();
    entry.supervisor.start();
    return this.#status(entry);
  }

  async start(id: string): Promise<ChannelStatus> {
    const entry = this.#entry(id);
    entry.record.desired = 'running';
    entry.record.completedAt = null;
    await this.#persist();
    entry.supervisor.start();
    return this.#status(entry);
  }

  async stop(id: string): Promise<ChannelStatus> {
    const entry = this.#entry(id);
    entry.record.desired = 'stopped';
    await this.#persist();
    await this.#halt(entry);
    return this.#status(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = this.#entry(id);
    await this.#halt(entry); // the publisher's last write must land before the directory goes
    this.#entries.delete(id);
    await this.#persist();
    await removeOutputDir(this.#outDir(id));
  }

  /** Stops every ffmpeg so playlists are finalized, without changing what should autostart next boot. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => this.#halt(entry)));
    await Promise.all([this.#writing, ...this.#pidWrites, ...this.#codecFills]);
  }

  /** Stops ffmpeg, then publishes whatever it wrote while finalizing. */
  async #halt(entry: Entry): Promise<void> {
    await entry.supervisor.stop();
    await entry.publisher?.pause();
  }

  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new AppError(`channel "${id}" not found`, 404);
    return entry;
  }

  #supervisor(id: string): Supervisor {
    return this.#entry(id).supervisor;
  }

  #outDir(id: string): string {
    return path.join(this.#deps.config.hlsRoot, id);
  }

  #allocatePort(spec: ChannelSpec): number | null {
    const type = spec.input.type;
    if (type !== 'rtmp' && type !== 'srt') return null;
    const range = type === 'rtmp' ? this.#deps.config.rtmpPorts : this.#deps.config.srtPorts;
    const used = new Set(
      [...this.#entries.values()].filter((e) => e.record.spec.input.type === type).map((e) => e.record.port),
    );
    for (let port = range.start; port <= range.end; port++) {
      if (!used.has(port)) return port;
    }
    throw new AppError(`no free ${type} ports in ${range.start}-${range.end}`, 409);
  }

  #makeEntry(record: ChannelRecord): Entry {
    const { spec } = record;
    const publisher =
      spec.mode === 'live'
        ? new PlaylistPublisher({
            outDir: this.#outDir(spec.id),
            channel: spec.id,
            logger: this.#deps.logger,
            probeStreams: this.#probeStreams,
          })
        : null;
    return { record, publisher, supervisor: this.#makeSupervisor(record, publisher) };
  }

  #makeSupervisor(record: ChannelRecord, publisher: PlaylistPublisher | null): Supervisor {
    const { spec } = record;
    const listener = spec.input.type === 'rtmp' || spec.input.type === 'srt';
    const rejectPublisher = publisherCheck(spec);
    return new Supervisor({
      id: spec.id,
      command: this.#deps.config.ffmpegPath,
      prepare: () => this.#prepare(record),
      restart: restartPolicy(spec),
      listener,
      ...(rejectPublisher ? { rejectPublisher } : {}),
      redact: redactSecrets,
      logger: this.#deps.logger,
      ...(this.#deps.spawn ? { spawn: this.#deps.spawn } : {}),
      ...(this.#deps.timings ? { timings: this.#deps.timings } : {}),
      onStateChange: (state) => this.#onStateChange(record, publisher, state),
      onPid: (pid) => this.#onPid(spec.id, pid),
    });
  }

  #onStateChange(record: ChannelRecord, publisher: PlaylistPublisher | null, state: ChannelState): void {
    this.#deps.logger.info({ channel: record.spec.id, state }, 'channel state');
    if (publisher !== null) {
      if (PUBLISHING_STATES.has(state)) publisher.resume();
      else void publisher.pause(); // stop/remove/shutdown await it themselves through #halt
    }
    if (state !== 'completed') return;
    record.completedAt = new Date().toISOString();
    record.desired = 'stopped';
    void this.#persistLogged();
    if (record.spec.mode === 'vod') {
      const fill = this.#fillVodCodecs(record.spec.id);
      this.#codecFills.add(fill);
      void (async () => {
        await fill;
        this.#codecFills.delete(fill);
      })();
    }
  }

  /** A VOD master is ffmpeg's own (live ones go through the publisher), so add the CODECS it left out once done. */
  async #fillVodCodecs(id: string): Promise<void> {
    const { logger } = this.#deps;
    const masterPath = path.join(this.#outDir(id), MASTER_PLAYLIST);
    try {
      const text = await readFile(masterPath, 'utf8');
      const filled = await fillMissingCodecs(text, this.#outDir(id), this.#probeStreams);
      for (const error of filled.errors) logger.warn({ channel: id, error }, 'CODECS not added');
      if (filled.text === text) return;
      await writeFile(`${masterPath}.tmp`, filled.text);
      await rename(`${masterPath}.tmp`, masterPath);
    } catch (err) {
      logger.error({ channel: id, err }, 'failed to add CODECS to the master playlist');
    }
  }

  /** Tracked so shutdown() can wait for the last pid file removal before the process exits. */
  #onPid(id: string, pid: number | null): void {
    const write = (async () => {
      try {
        await writePidFile(this.#pidDir, id, pid);
      } catch (err) {
        this.#deps.logger.error({ channel: id, err }, 'failed to write pid file');
      }
    })();
    this.#pidWrites.add(write);
    void (async () => {
      await write;
      this.#pidWrites.delete(write);
    })();
  }

  async #prepare(record: ChannelRecord): Promise<string[]> {
    const { config, defaultLadder } = this.#deps;
    let spec = record.spec;
    let probeTarget: string | null = null;

    if (spec.input.type === 'file') {
      const filePath = path.resolve(config.rootDir, spec.input.path);
      try {
        await access(filePath);
      } catch {
        throw new AppError(`input file not found: ${filePath}`, 422);
      }
      spec = { ...spec, input: { ...spec.input, path: filePath } };
      probeTarget = filePath;
    } else if (spec.input.type === 'pull') {
      probeTarget = spec.input.url;
    }

    const probe = probeTarget === null ? null : await this.#probe(probeTarget);
    const outDir = this.#outDir(spec.id);
    const { args, variants } = buildArgs(spec, {
      outDir,
      runId: Date.now().toString(36),
      ladder: spec.ladder ?? defaultLadder,
      port: record.port,
      probe,
      encoder: config,
    });
    await prepareOutputDir(outDir, variants, spec.mode);
    return args;
  }

  #status(entry: Entry): ChannelStatus {
    const { record, supervisor } = entry;
    const { spec, port } = record;
    const { ingestHost, publicHlsBaseUrl } = this.#deps.config;
    let ingestUrl: string | null = null;
    if (spec.input.type === 'rtmp') ingestUrl = `rtmp://${ingestHost}:${port}/live/${spec.input.streamKey}`;
    if (spec.input.type === 'srt') ingestUrl = `srt://${ingestHost}:${port}?mode=caller`;
    return {
      id: spec.id,
      spec: redact(spec),
      port,
      desired: record.desired,
      completedAt: record.completedAt,
      ingestUrl,
      playbackUrl: `${publicHlsBaseUrl}/${spec.id}/master.m3u8`,
      ...supervisor.status(),
    };
  }

  async #load(): Promise<ChannelRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#storePath, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
      throw err;
    }
    const parsed = StoreSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new AppError(`${this.#storePath} is invalid: ${z.prettifyError(parsed.error)}`, 500);
    }
    return parsed.data.channels;
  }

  /** Serialized so overlapping writes can't land out of order. */
  async #persist(): Promise<void> {
    const previous = this.#writing;
    let release = (): void => {};
    this.#writing = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const data = { channels: [...this.#entries.values()].map((entry) => entry.record) };
      const tmp = `${this.#storePath}.tmp`;
      await mkdir(path.dirname(this.#storePath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
      await rename(tmp, this.#storePath);
    } finally {
      release();
    }
  }

  async #persistLogged(): Promise<void> {
    try {
      await this.#persist();
    } catch (err) {
      this.#deps.logger.error({ err }, 'failed to persist channels');
    }
  }
}
