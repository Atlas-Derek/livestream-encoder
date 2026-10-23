import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { silentLogger, type Logger } from '../log.ts';
import { Webhooks, type FetchFn, type WebhookEvent } from './webhooks.ts';

const event = (state: string): WebhookEvent =>
  ({ event: 'channel.state', channel: 'obs', state, previous: null, lastError: null, warnings: [] });

describe('Webhooks', () => {
  it('posts each event to every URL in order, signed when a secret is set', async () => {
    const received: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetch: FetchFn = async (url, init) => {
      // A slow first delivery must not let the second overtake it.
      if (received.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      received.push({ url, body: init.body, headers: init.headers });
      return { status: 204 };
    };
    const hooks = new Webhooks({ urls: ['http://a/hook'], secret: 's3cret', logger: silentLogger, fetch });
    hooks.send(event('starting'));
    hooks.send(event('running'));
    await hooks.flush();

    assert.deepEqual(received.map((r) => JSON.parse(r.body).state), ['starting', 'running']);
    const [first] = received;
    assert.equal(first?.headers['x-lse-event'], 'channel.state');
    assert.equal(first?.headers['x-lse-signature'], `sha256=${createHmac('sha256', 's3cret').update(first?.body ?? '').digest('hex')}`);
    assert.match(JSON.parse(first?.body ?? '{}').at, /^\d{4}-\d\d-\d\dT/);
  });

  it('retries server errors and network failures, gives up on a refusal, and logs what it dropped', async () => {
    const statuses = [500, 503, 204];
    let calls = 0;
    const warned: unknown[] = [];
    const logger: Logger = { ...silentLogger, warn: (obj: unknown) => void warned.push(obj) };
    const retrying = new Webhooks({
      urls: ['http://a/hook'], secret: null, logger, backoffMs: 1,
      fetch: async () => {
        calls++;
        return { status: statuses.shift() ?? 204 };
      },
    });
    retrying.send(event('running'));
    await retrying.flush();
    assert.equal(calls, 3);
    assert.deepEqual(warned, []);

    let refused = 0;
    const refusing = new Webhooks({
      urls: ['https://hooks.example/x?token=secret'], secret: null, logger, backoffMs: 1,
      fetch: async () => {
        refused++;
        return { status: 404 };
      },
    });
    refusing.send(event('running'));
    await refusing.flush();
    assert.equal(refused, 1, 'not retried');
    assert.deepEqual(warned, [{ webhook: 'https://hooks.example', event: 'channel.state', failure: 'HTTP 404' }]);

    const offline = new Webhooks({
      urls: ['http://a/hook'], secret: null, logger: silentLogger, backoffMs: 1, attempts: 2,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    offline.send(event('running'));
    await offline.flush(); // never rejects
  });
});
