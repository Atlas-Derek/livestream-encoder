import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ChannelManager } from '../channels/manager.ts';
import { loadConfig } from '../config.ts';
import { silentLogger } from '../log.ts';
import { fakeSpawner } from '../testing/fakes.ts';
import { registerRoutes } from './routes.ts';

let varDir: string;
let manager: ChannelManager;
let app: FastifyInstance;

beforeEach(async () => {
  varDir = await mkdtemp(path.join(tmpdir(), 'lse-routes-'));
  manager = new ChannelManager({
    config: loadConfig({ VAR_DIR: varDir }),
    logger: silentLogger,
    defaultLadder: [{ name: '720p', height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128 }],
    spawn: fakeSpawner({ exitOnKill: true }).spawn,
    killStale: async () => {},
    renderSlate: async () => {},
  });
  await manager.init();
  app = Fastify();
  registerRoutes(app, manager);
});

afterEach(async () => {
  await app.close();
  await manager.shutdown();
  await rm(varDir, { recursive: true, force: true });
});

describe('routes', () => {
  it('creates, reads, stops and deletes a channel', async () => {
    const created = await app.inject({ method: 'POST', url: '/channels', payload: { id: 'push', input: { type: 'srt' } } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().ingestUrl, 'srt://localhost:9000?mode=caller');

    assert.equal((await app.inject({ method: 'GET', url: '/channels/push' })).json().id, 'push');
    assert.equal((await app.inject({ method: 'POST', url: '/channels/push/stop' })).json().desired, 'stopped');
    assert.equal((await app.inject({ method: 'DELETE', url: '/channels/push' })).statusCode, 204);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/channels' })).json(), []);
  });

  it('answers bad requests with 4xx and the reason, not 500', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/channels', payload: { id: 'Bad Id', input: { type: 'srt' } } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'invalid request');
    assert.deepEqual(invalid.json().issues.map((issue: { path: string[] }) => issue.path), [['id']]);

    const malformed = await app.inject({
      method: 'POST', url: '/channels', headers: { 'content-type': 'application/json' }, payload: '{"id":',
    });
    assert.equal(malformed.statusCode, 400);

    await app.inject({ method: 'POST', url: '/channels', payload: { id: 'a', input: { type: 'srt' } } });
    const duplicate = await app.inject({ method: 'POST', url: '/channels', payload: { id: 'a', input: { type: 'srt' } } });
    assert.deepEqual([duplicate.statusCode, duplicate.json()], [409, { error: 'channel "a" already exists' }]);

    const missing = await app.inject({ method: 'POST', url: '/channels/nope/start' });
    assert.deepEqual([missing.statusCode, missing.json()], [404, { error: 'channel "nope" not found' }]);
  });

  it('lists and deletes a channel\'s recordings', async () => {
    await app.inject({ method: 'POST', url: '/channels', payload: { id: 'rec', input: { type: 'srt' }, record: true } });
    const dir = path.join(varDir, 'hls', 'rec', 'recordings', '20261023T160000Z', '720p');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\nseg_r1_00000.ts\n#EXT-X-ENDLIST\n');

    const list = await app.inject({ method: 'GET', url: '/channels/rec/recordings' });
    assert.deepEqual(list.json(), [{
      id: '20261023T160000Z', startedAt: '2026-10-23T16:00:00.000Z', durationSec: 4, open: false, variants: ['720p'],
      playbackUrl: 'http://localhost:8080/hls/rec/recordings/20261023T160000Z/master.m3u8',
    }]);
    assert.equal((await app.inject({ method: 'DELETE', url: '/channels/rec/recordings/..%2F720p' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: '/channels/rec/recordings/20261023T160000Z' })).statusCode, 204);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/channels/rec/recordings' })).json(), []);
    assert.equal((await app.inject({ method: 'GET', url: '/channels/nope/recordings' })).statusCode, 404);
  });

  it('mints playback URLs, signed when a secret is set', async () => {
    await app.inject({ method: 'POST', url: '/channels', payload: { id: 'open', input: { type: 'srt' } } });
    assert.deepEqual((await app.inject({ method: 'GET', url: '/channels/open/playback-url' })).json(), {
      playbackUrl: 'http://localhost:8080/hls/open/master.m3u8', expiresAt: null,
    });
    assert.equal((await app.inject({ method: 'GET', url: '/channels/open/playback-url?ttlSeconds=0' })).statusCode, 400);

    const signed = new ChannelManager({
      config: loadConfig({ VAR_DIR: varDir, PLAYBACK_SECRET: 'test-secret-0123456789' }),
      logger: silentLogger,
      defaultLadder: [{ name: '720p', height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128 }],
      spawn: fakeSpawner({ exitOnKill: true }).spawn,
      killStale: async () => {},
      renderSlate: async () => {},
    });
    await signed.init();
    try {
      const { playbackUrl, expiresAt } = signed.playbackUrl('open', 3600);
      assert.match(playbackUrl, /^http:\/\/localhost:8080\/hls\/_s\/\d+\/[A-Za-z0-9_-]{22}\/open\/master\.m3u8$/);
      assert.match(expiresAt ?? '', /T\d\d:00:00\.000Z$/);
      assert.match(signed.get('open').playbackUrl, /\/hls\/_s\//, 'the status URL is signed too');
    } finally {
      await signed.shutdown();
    }
  });
});
