import type { EventListener, InboundMessage, TimedAgentEvent } from '@textagent/core';
import {
  INGEST_PATH,
  MAX_BATCH_BYTES,
  MAX_MESSAGES_PER_BATCH,
  MAX_TRACES_PER_BATCH,
  PROTOCOL_VERSION,
} from './protocol.ts';
import type { ExportedMessage, ExportedTrace, IngestBatch } from './protocol.ts';
import { hasher, redactMessage, redactTrace } from './redact.ts';
import type { Hash } from './redact.ts';

export interface ExporterOptions {
  /** Dashboard base URL. Must be https, except on localhost. Default: TEXTAGENT_INGEST_URL */
  url?: string;
  /** The project's ingestion key. Default: TEXTAGENT_KEY */
  key?: string;
  /** Hashes ids before they're sent; never sent itself. At least 32 characters. Default: TEXTAGENT_HASH_SECRET */
  hashSecret?: string;
  /** Also send message text (ids stay hashed). Default: false */
  includeText?: boolean;
  /** Send span attributes. Turn off if yours may contain personal data. Default: true */
  attributes?: boolean;
  /** A rejected key, an unreachable dashboard, dropped data. Default: console.warn */
  onError?: (error: Error) => void;
}

/** An event listener for `agent.on('event', ...)` that ships turn traces to the dashboard. */
export type Exporter = EventListener & {
  /** Send everything buffered now. On serverless hosts: `waitUntil(exporter.flush())`. */
  flush(): Promise<void>;
  /** Stop listening and make one last attempt to send what's buffered. Call after `agent.stop()`. */
  close(): Promise<void>;
};

const FLUSH_INTERVAL_MS = 5_000;
const ENVELOPE_BYTES = 64;
const MAX_BUFFERED = 1_000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** `agent.on('event', exporter())`: traces go to the dashboard with person-naming ids hashed. */
export function exporter(options: ExporterOptions = {}): Exporter {
  const url = options.url || process.env.TEXTAGENT_INGEST_URL;
  const key = options.key || process.env.TEXTAGENT_KEY;
  const secret = options.hashSecret || process.env.TEXTAGENT_HASH_SECRET;
  if (!url) throw new Error('exporter(): set TEXTAGENT_INGEST_URL to the dashboard URL');
  if (!key) throw new Error("exporter(): set TEXTAGENT_KEY to the project's ingestion key");
  if (!secret) throw new Error('exporter(): set TEXTAGENT_HASH_SECRET (at least 32 random characters, kept private)');

  const queue = new ExportQueue(ingestUrl(url), key, hasher(secret), {
    includeText: options.includeText ?? false,
    attributes: options.attributes ?? true,
    onError: options.onError ?? ((error) => console.warn(`textagent exporter: ${error.message}`)),
  });
  const listener: EventListener = (event) => queue.handle(event);
  return Object.assign(listener, { flush: () => queue.flush(), close: () => queue.close() });
}

function ingestUrl(base: string): URL {
  let url: URL;
  try {
    url = new URL(base.endsWith('/') ? base : `${base}/`);
  } catch {
    throw new Error(`exporter(): invalid dashboard URL ${JSON.stringify(base)}`);
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('exporter(): the dashboard URL must be https (http only on localhost); requests carry the key');
  }
  // Relative, so a dashboard mounted under a path prefix keeps it.
  return new URL(INGEST_PATH.slice(1), url);
}

interface QueueOptions {
  includeText: boolean;
  attributes: boolean;
  onError: (error: Error) => void;
}

class ExportQueue {
  readonly #url: URL;
  readonly #key: string;
  readonly #hash: Hash;
  readonly #options: QueueOptions;
  readonly #timer: ReturnType<typeof setInterval>;
  #traces: ExportedTrace[] = [];
  #messages: ExportedMessage[] = [];
  /**
   * Inbound texts wait here until their turn completes: `message.received` fires before dedupe and
   * filtering, and texts from people the agent ignores must never leave the machine.
   */
  readonly #held = new Map<string, { source: InboundMessage; message: ExportedMessage }>();
  #dropped = 0;
  #sending: Promise<void> = Promise.resolve();
  #failures = 0;
  #retryAt = 0;
  #autoFlushQueued = false;
  /** `rejected`: the dashboard refused the key; nothing more is sent. */
  #state: 'running' | 'closed' | 'rejected' = 'running';

  constructor(url: URL, key: string, hash: Hash, options: QueueOptions) {
    this.#url = url;
    this.#key = key;
    this.#hash = hash;
    this.#options = options;
    // unref: a quiet exporter must not keep the process alive.
    this.#timer = setInterval(() => this.#flushIfDue(), FLUSH_INTERVAL_MS).unref();
  }

  handle(event: TimedAgentEvent): void {
    if (this.#state !== 'running') return;
    switch (event.type) {
      case 'turn.completed': {
        const { trace } = event;
        this.#push(this.#traces, redactTrace(trace, this.#hash, this.#options.attributes));
        for (const id of trace.messageIds) {
          const held = this.#held.get(heldKey(trace.channel, id));
          if (!held) continue;
          this.#held.delete(heldKey(trace.channel, id));
          this.#push(this.#messages, held.message);
        }
        if (this.#traces.length >= MAX_TRACES_PER_BATCH) this.#flushIfDue();
        return;
      }
      case 'message.received': {
        if (!this.#options.includeText) return;
        const key = heldKey(event.message.channel, event.message.id);
        if (this.#held.has(key)) return; // a redelivery while the original is still pending
        if (this.#held.size >= MAX_BUFFERED) {
          this.#held.delete(this.#held.keys().next().value!); // size > 0, so there is a first key
          this.#dropped++;
        }
        this.#held.set(key, { source: event.message, message: redactMessage(event, this.#hash)! });
        return;
      }
      case 'message.duplicate':
      case 'message.filtered': {
        // Only the entry this very delivery created: a duplicate must not discard a pending original.
        const key = heldKey(event.message.channel, event.message.id);
        if (this.#held.get(key)?.source === event.message) this.#held.delete(key);
        return;
      }
      case 'message.sent':
        if (this.#options.includeText) this.#push(this.#messages, redactMessage(event, this.#hash)!);
        return;
    }
  }

  flush(): Promise<void> {
    this.#sending = this.#sending.then(() => this.#sendAll());
    return this.#sending;
  }

  async close(): Promise<void> {
    if (this.#state === 'running') this.#state = 'closed';
    clearInterval(this.#timer);
    this.#held.clear();
    await this.flush();
  }

  /**
   * Timer and size-triggered flushes: at most one waiting at a time, and it checks the backoff when it runs,
   * so a burst of turns during an outage can't queue a burst of retries. An explicit `flush()` ignores backoff.
   */
  #flushIfDue(): void {
    if (this.#autoFlushQueued) return;
    this.#autoFlushQueued = true;
    this.#sending = this.#sending.then(() => {
      this.#autoFlushQueued = false;
      return Date.now() >= this.#retryAt ? this.#sendAll() : undefined;
    });
  }

  async #sendAll(): Promise<void> {
    while (this.#state !== 'rejected' && (this.#traces.length > 0 || this.#messages.length > 0)) {
      if (!(await this.#send(this.#takeBatch()))) break;
    }
    if (this.#dropped > 0) {
      this.#report(
        `dropped ${this.#dropped} trace(s)/message(s): buffer full while the dashboard was unreachable, or over 1 MB`,
      );
      this.#dropped = 0;
    }
  }

  /** Takes items off the queues, oldest first, within the protocol's per-batch limits. */
  #takeBatch(): IngestBatch {
    const budget = MAX_BATCH_BYTES - ENVELOPE_BYTES;
    const traces = this.#take(this.#traces, MAX_TRACES_PER_BATCH, budget);
    const messages = this.#take(this.#messages, MAX_MESSAGES_PER_BATCH, budget - traces.bytes);
    return {
      version: PROTOCOL_VERSION,
      traces: traces.items,
      ...(messages.items.length > 0 && { messages: messages.items }),
    };
  }

  #take<T>(queue: T[], maxCount: number, budget: number): { items: T[]; bytes: number } {
    const items: T[] = [];
    let bytes = 0;
    while (queue.length > 0 && items.length < maxCount) {
      const size = Buffer.byteLength(JSON.stringify(queue[0])) + 1;
      if (size > MAX_BATCH_BYTES - ENVELOPE_BYTES) {
        queue.shift(); // can never be sent
        this.#dropped++;
        continue;
      }
      if (bytes + size > budget) break;
      items.push(queue.shift()!); // length checked above
      bytes += size;
    }
    return { items, bytes };
  }

  /** True to keep sending, false to stop until the next flush. */
  async #send(batch: IngestBatch): Promise<boolean> {
    const count = batch.traces.length + (batch.messages?.length ?? 0);
    if (count === 0) return true;
    let status: number | undefined;
    let failure: unknown;
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      status = response.status;
    } catch (error) {
      failure = error;
    }

    if (status !== undefined && status >= 200 && status < 300) {
      this.#failures = 0;
      this.#retryAt = 0;
      return true;
    }
    if (status === 401 || status === 403) {
      this.#state = 'rejected';
      clearInterval(this.#timer);
      this.#traces = [];
      this.#messages = [];
      this.#held.clear();
      this.#report(
        `the dashboard rejected the ingestion key (HTTP ${status}); exporting stopped. Check TEXTAGENT_KEY.`,
      );
      return false;
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      this.#report(`the dashboard refused a batch (HTTP ${status}); dropped ${count} trace(s)/message(s)`);
      return true; // resending the same batch can't succeed; the next one may
    }

    this.#traces.unshift(...batch.traces);
    this.#messages.unshift(...(batch.messages ?? []));
    this.#trim(this.#traces);
    this.#trim(this.#messages);
    this.#failures++;
    this.#retryAt = Date.now() + Math.min(1_000 * 2 ** (this.#failures - 1), MAX_BACKOFF_MS);
    if (this.#failures === 1) {
      const reason =
        status !== undefined ? `HTTP ${status}` : failure instanceof Error ? failure.message : String(failure);
      this.#report(`can't reach the dashboard (${reason}); will retry`);
    }
    return false;
  }

  #push<T>(queue: T[], item: T): void {
    queue.push(item);
    this.#trim(queue);
  }

  #trim(queue: unknown[]): void {
    while (queue.length > MAX_BUFFERED) {
      queue.shift();
      this.#dropped++;
    }
  }

  #report(message: string): void {
    try {
      this.#options.onError(new Error(message));
    } catch {
      // A broken error handler must not break exporting.
    }
  }
}

function heldKey(channel: string, id: string): string {
  return `${channel}\u0000${id}`;
}
