import type { ChannelState, InboundMessage } from '@textagent/core';
import type { ChatDbReader } from './reader.ts';

export interface ChatDbPollerOptions {
  reader: ChatDbReader;
  /** Where the cursor survives restarts; the agent passes this to every channel. */
  state: ChannelState;
  onMessage: (message: InboundMessage) => Promise<void>;
  onError: (error: unknown) => void;
  /** Default: 1000. */
  intervalMs?: number;
  /** Rows per read. Default: 200. */
  batchSize?: number;
}

const CURSOR_KEY = 'cursor';

/** Polls chat.db and delivers new messages in order, saving its place as it goes. */
export class ChatDbPoller {
  readonly #opts: Required<ChatDbPollerOptions>;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  /** Tail of the poll chain: polls never overlap, so the cursor only moves forward. */
  #polling: Promise<void> = Promise.resolve();
  #stopped = true;

  constructor(options: ChatDbPollerOptions) {
    this.#opts = { intervalMs: 1000, batchSize: 200, ...options };
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    // A fresh install starts after everything already in Messages instead of answering years of history.
    if ((await this.#opts.state.get(CURSOR_KEY)) === undefined) {
      await this.#opts.state.set(CURSOR_KEY, String(this.#opts.reader.latestRowId()));
    }
    this.#stopped = false;
    this.#schedule(0);
  }

  /** Stop polling and wait for an in-flight poll to finish. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  /** Read and deliver everything new right now, after any poll already in progress. */
  poll(): Promise<void> {
    const next = this.#polling.then(() => this.#pollOnce());
    this.#polling = next.catch(() => {});
    return next;
  }

  async #pollOnce(): Promise<void> {
    const { reader, state, onMessage, batchSize } = this.#opts;
    let cursor = Number((await state.get(CURSOR_KEY)) ?? 0);

    for (;;) {
      const batch = reader.read(cursor, batchSize);
      for (const message of batch.messages) await onMessage(message);
      if (batch.cursor === cursor) break; // nothing new, or stalled waiting on a chat link
      cursor = batch.cursor;
      // Saved after delivery: a crash mid-batch re-reads it, and the agent's dedupe drops repeats.
      await state.set(CURSOR_KEY, String(cursor));
      if (batch.messages.length + batch.skipped.length < batchSize) break; // caught up
    }
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#running = this.poll()
        .catch((error: unknown) => this.#opts.onError(error))
        .finally(() => {
          this.#running = undefined;
          if (!this.#stopped) this.#schedule(this.#opts.intervalMs);
        });
    }, delayMs);
  }
}
