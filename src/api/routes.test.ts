import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
});
