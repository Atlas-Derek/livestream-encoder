import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig, type Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { ProbeFn, ProbeResult } from '../ffmpeg/probe.ts';
import { silentLogger } from '../log.ts';
import { fakeSpawner, waitFor } from '../testing/fakes.ts';
import { ChannelManager, rejectWrongStreamKey, type ManagerDeps } from './manager.ts';
import { ChannelSpecSchema, type Rung } from './schema.ts';

const LADDER: Rung[] = [
  { name: '1080p', height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 128 },
  { name: '720p', height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128 },
  { name: '360p', height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
];

let varDir: string;
let config: Config;
let managers: ChannelManager[] = [];

beforeEach(async () => {
  varDir = await mkdtemp(path.join(tmpdir(), 'lse-manager-'));
  config = loadConfig({ VAR_DIR: varDir, RTMP_PORTS: '1935-1936' });
});

afterEach(async () => {
  // Shut down even when a test failed part-way, or a supervisor's watchdog keeps the process alive.
  await Promise.all(managers.map((manager) => manager.shutdown()));
  managers = [];
  await rm(varDir, { recursive: true, force: true });
});

function makeManager(overrides: Partial<ManagerDeps> = {}) {
  const spawner = fakeSpawner({ exitOnKill: true });
  const probed: string[] = [];
  const probe: ProbeFn = async (input) => {
    probed.push(input);
    const result: ProbeResult = { width: 1280, height: 720, fps: 25, videoCodec: 'h264', audioCodec: 'aac' };
    return result;
  };
  const manager = new ChannelManager({
    config,
    logger: silentLogger,
    defaultLadder: LADDER,
    probe,
    spawn: spawner.spawn,
    killStale: async () => {},
    ...overrides,
  });
  managers.push(manager);
  return { manager, spawner, probed };
}

const spec = (value: unknown) => ChannelSpecSchema.parse(value);

async function sampleFile(): Promise<string> {
  const file = path.join(varDir, 'media', 'clip.mp4');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '');
  return file;
}

describe('ChannelManager', () => {
  it('assigns listener ports per protocol and reports ingest and playback URLs', async () => {
    const { manager } = makeManager();
    await manager.init();
    const a = await manager.create(spec({ id: 'a', input: { type: 'rtmp', streamKey: 'ka' } }));
    const b = await manager.create(spec({ id: 'b', input: { type: 'rtmp', streamKey: 'kb' } }));
    const c = await manager.create(spec({ id: 'c', input: { type: 'srt', passphrase: 'correct horse battery' } }));

    assert.equal(a.port, 1935);
    assert.equal(b.port, 1936);
    assert.equal(c.port, 9000);
    assert.equal(a.ingestUrl, 'rtmp://localhost:1935/live/ka');
    assert.equal(c.ingestUrl, 'srt://localhost:9000?mode=caller');
    assert.equal(a.playbackUrl, 'http://localhost:8080/hls/a/master.m3u8');
    assert.deepEqual(c.spec.input, { type: 'srt', passphrase: '********' });

    await assert.rejects(manager.create(spec({ id: 'd', input: { type: 'rtmp', streamKey: 'kd' } })), {
      message: 'no free rtmp ports in 1935-1936',
    });
    await manager.shutdown();
  });

  it('frees a port when its channel is removed', async () => {
    const { manager } = makeManager();
    await manager.init();
    await manager.create(spec({ id: 'a', input: { type: 'rtmp', streamKey: 'ka' } }));
    await manager.create(spec({ id: 'b', input: { type: 'rtmp', streamKey: 'kb' } }));
    await manager.remove('a');
    const c = await manager.create(spec({ id: 'c', input: { type: 'rtmp', streamKey: 'kc' } }));
    assert.equal(c.port, 1935);
    await manager.shutdown();
  });

  it('rejects duplicate ids and unknown channels', async () => {
    const { manager } = makeManager();
    await manager.init();
    await manager.create(spec({ id: 'a', input: { type: 'srt' } }));
    await assert.rejects(manager.create(spec({ id: 'a', input: { type: 'srt' } })), (err) => err instanceof AppError && err.status === 409);
    assert.throws(() => manager.get('nope'), (err) => err instanceof AppError && err.status === 404);
    await manager.shutdown();
  });

  it('probes file input, drops rungs above the source, and spawns ffmpeg', async () => {
    const file = await sampleFile();
    const { manager, spawner, probed } = makeManager();
    await manager.init();
    await manager.create(spec({ id: 'vod', input: { type: 'file', path: file }, mode: 'vod' }));
    await waitFor(() => spawner.calls.length === 1);

    assert.deepEqual(probed, [file]);
    const args = spawner.calls[0] ?? [];
    assert.equal(args[args.indexOf('-var_stream_map') + 1], 'v:0,a:0,name:720p v:1,a:1,name:360p');
    await access(path.join(config.hlsRoot, 'vod', '720p'));
    assert.equal(manager.get('vod').state, 'starting');
    await manager.shutdown();
  });

  it('keeps SRT passphrases and URL credentials out of logs and status', async () => {
    const logged: string[] = [];
    const record = (obj: object, msg?: string): void => {
      logged.push(`${msg ?? ''} ${JSON.stringify(obj)}`);
    };
    const { manager, spawner } = makeManager({ logger: { debug: record, info: record, warn: record, error: record } });
    await manager.init();
    await manager.create(spec({ id: 'srt', input: { type: 'srt', passphrase: 'correct-horse-battery' } }));
    await manager.create(spec({ id: 'cam', input: { type: 'pull', url: 'rtsp://admin:hunter2@cam.local/stream' } }));
    await waitFor(() => spawner.calls.length === 2);
    assert.ok(spawner.calls.flat().some((arg) => arg.includes('passphrase=correct-horse-battery')), 'ffmpeg gets the real secret');

    const text = [...logged, JSON.stringify(manager.list())].join('\n');
    assert.ok(text.includes('ffmpeg spawned'));
    assert.equal(text.includes('correct-horse-battery'), false);
    assert.equal(text.includes('hunter2'), false);
    assert.deepEqual(manager.get('cam').spec.input, { type: 'pull', url: 'rtsp://admin:********@cam.local/stream' });
    await manager.shutdown();
  });

  it('puts a channel with a missing input file into error without spawning', async () => {
    const { manager, spawner } = makeManager();
    await manager.init();
    await manager.create(spec({ id: 'gone', input: { type: 'file', path: 'media/missing.mp4' }, mode: 'vod' }));
    await waitFor(() => manager.get('gone').state === 'error');
    const status = manager.get('gone');
    assert.equal(status.state, 'error');
    assert.match(status.lastError ?? '', /input file not found/);
    assert.equal(spawner.children.length, 0);
  });

  it('persists channels, autostarts the running ones on boot, and skips completed VOD', async () => {
    const file = await sampleFile();
    const first = makeManager();
    await first.manager.init();
    await first.manager.create(spec({ id: 'live', input: { type: 'rtmp', streamKey: 'k' } }));
    await first.manager.create(spec({ id: 'idle', input: { type: 'srt' } }));
    await first.manager.stop('idle');
    await first.manager.create(spec({ id: 'vod', input: { type: 'file', path: file }, mode: 'vod' }));
    await waitFor(() => first.spawner.calls.some((args) => args.includes(file)));
    const vodChild = first.spawner.children[first.spawner.calls.findIndex((args) => args.includes(file))];
    assert.ok(vodChild);
    vodChild.progress(4);
    await waitFor(() => first.manager.get('vod').state === 'running');
    vodChild.exit(0);
    await waitFor(() => first.manager.get('vod').state === 'completed');
    await first.manager.shutdown();

    const stored = JSON.parse(await readFile(path.join(varDir, 'channels.json'), 'utf8'));
    assert.deepEqual(
      stored.channels.map((c: { spec: { id: string }; desired: string }) => [c.spec.id, c.desired]),
      [['live', 'running'], ['idle', 'stopped'], ['vod', 'stopped']],
    );

    const second = makeManager();
    await second.manager.init();
    await waitFor(() => second.manager.get('live').state === 'waiting_for_publisher');
    assert.equal(second.spawner.children.length, 1);
    assert.deepEqual(
      second.manager.list().map((c) => [c.id, c.state, c.port]),
      [['live', 'waiting_for_publisher', 1935], ['idle', 'idle', 9000], ['vod', 'idle', null]],
    );
    assert.ok(second.manager.get('vod').completedAt);
    await second.manager.shutdown();
  });

  it('deletes the output directory when a channel is removed', async () => {
    const { manager } = makeManager();
    await manager.init();
    await manager.create(spec({ id: 'gone', input: { type: 'srt' } }));
    await waitFor(() => manager.get('gone').state === 'waiting_for_publisher');
    await access(path.join(config.hlsRoot, 'gone'));
    await manager.remove('gone');
    await assert.rejects(access(path.join(config.hlsRoot, 'gone')));
    assert.deepEqual(manager.list(), []);
  });

  it('refuses to start from a corrupt channels.json instead of silently dropping channels', async () => {
    await writeFile(path.join(varDir, 'channels.json'), JSON.stringify({ channels: [{ spec: { id: 'BAD' } }] }));
    const { manager } = makeManager();
    await assert.rejects(manager.init(), /channels\.json is invalid/);
  });
});

describe('rejectWrongStreamKey', () => {
  it('matches ffmpeg’s wrong-key warning only', () => {
    assert.equal(rejectWrongStreamKey('[rtmp @ 0xaaf03c000] Unexpected stream WRONGKEY, expecting abc'), 'rejected publisher with wrong stream key');
    assert.equal(rejectWrongStreamKey('[flv @ 0x1] Failed to update header'), null);
  });
});
