import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('reads webhook URLs and refuses anything but http(s)', () => {
    assert.deepEqual(loadConfig({}).webhookUrls, []);
    const config = loadConfig({ WEBHOOK_URLS: 'http://localhost:9000/hook, https://hooks.example/x', WEBHOOK_SECRET: 's' });
    assert.deepEqual(config.webhookUrls, ['http://localhost:9000/hook', 'https://hooks.example/x']);
    assert.equal(config.webhookSecret, 's');
    assert.throws(() => loadConfig({ WEBHOOK_URLS: 'file:///etc/passwd' }), /http or https/);
    assert.throws(() => loadConfig({ WEBHOOK_URLS: 'not a url' }), /comma-separated/);
  });
});
