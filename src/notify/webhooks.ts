import { createHmac } from 'node:crypto';
import type { Logger } from '../log.ts';

/** What WEBHOOK_URLS receive, as a JSON POST body. */
export type WebhookEvent =
  | {
      event: 'channel.state';
      channel: string;
      state: string;
      previous: string | null;
      lastError: string | null;
      warnings: string[];
    }
  | {
      event: 'recording.closed';
      channel: string;
      recording: string;
      durationSec: number;
      playbackUrl: string;
    };

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ status: number }>;

export interface WebhookOptions {
  urls: string[];
  /** Signs each body: X-LSE-Signature: sha256=<HMAC-SHA256 of the body, hex>. */
  secret: string | null;
  logger: Logger;
  fetch?: FetchFn;
  /** Attempts per event and URL. */
  attempts?: number;
  /** Waits 1x, 2x, 4x… this between attempts. */
  backoffMs?: number;
  timeoutMs?: number;
}

/**
 * Posts events to the configured URLs. Delivery runs in the background and never holds up a channel: each URL gets its
 * events in order, retried with backoff on network errors, 5xx and 429; a failure is logged and the event dropped.
 */
export class Webhooks {
  readonly #opts: WebhookOptions;
  readonly #fetch: FetchFn;
  /** Per URL, the delivery the next event waits for, so events arrive in order. */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: WebhookOptions) {
    this.#opts = options;
    this.#fetch = options.fetch ?? (async (url, init) => fetch(url, init));
  }

  send(event: WebhookEvent): void {
    const body = JSON.stringify({ ...event, at: new Date().toISOString() });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-lse-event': event.event };
    if (this.#opts.secret !== null) {
      headers['x-lse-signature'] = `sha256=${createHmac('sha256', this.#opts.secret).update(body).digest('hex')}`;
    }
    for (const url of this.#opts.urls) {
      const previous = this.#queues.get(url) ?? Promise.resolve();
      const delivery = (async () => {
        await previous;
        await this.#deliver(url, headers, body, event.event);
      })();
      this.#queues.set(url, delivery);
    }
  }

  /** Waits for every queued delivery. */
  async flush(): Promise<void> {
    await Promise.all(this.#queues.values());
  }

  async #deliver(url: string, headers: Record<string, string>, body: string, name: string): Promise<void> {
    const attempts = this.#opts.attempts ?? 4;
    const backoffMs = this.#opts.backoffMs ?? 1_000;
    let failure = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
      try {
        const { status } = await this.#fetch(url, {
          method: 'POST', headers, body, signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 5_000),
        });
        if (status >= 200 && status < 300) return;
        failure = `HTTP ${status}`;
        if (status < 500 && status !== 429) break; // the receiver refused it; resending won't help
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    }
    // Only the origin: webhook URLs often carry a token.
    this.#opts.logger.warn({ webhook: new URL(url).origin, event: name, failure }, 'webhook not delivered');
  }
}
