import { setTimeout as sleep } from 'node:timers/promises';
import type { ChannelState } from '@textagent/core';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, MailboxLockObject, MailboxObject } from 'imapflow';

/** Where mail comes from. IMAP today; a provider webhook (Postmark, Resend, ...) can implement this later. */
export interface MailSource {
  start(ctx: MailSourceContext): Promise<void>;
  stop(): Promise<void>;
}

export interface MailSourceContext {
  /** Hand over one raw RFC 5322 message. `key` is unique and stable for that message within the source. */
  deliver(source: Buffer, key: string): Promise<void>;
  state: ChannelState;
  reportError(error: unknown): void;
}

export interface ImapOptions {
  host: string;
  /** Default: 993 */
  port?: number;
  /** Default: true (implicit TLS). */
  secure?: boolean;
  user: string;
  pass: string;
  /** Default: INBOX */
  mailbox?: string;
  /** Fallback check interval; new mail normally arrives instantly via IDLE. Default: 30000. */
  pollIntervalMs?: number;
}

/** The part of ImapFlow this source uses, so tests can substitute a fake server. */
export interface ImapClient {
  usable: boolean;
  mailbox: MailboxObject | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<MailboxLockObject>;
  fetch(range: string, query: { uid: true; source: true }, options: { uid: true }): AsyncIterable<FetchMessageObject>;
  on(event: 'exists' | 'close' | 'error', listener: (arg?: unknown) => void): unknown;
}

const UIDVALIDITY_KEY = 'uidvalidity';
const UID_KEY = 'uid';
const MAX_BACKOFF_MS = 60_000;

export class ImapSource implements MailSource {
  readonly #options: ImapOptions;
  readonly #createClient: (options: ImapOptions) => ImapClient;
  #ctx: MailSourceContext | undefined;
  #client: ImapClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  /** Syncs never overlap, so the cursor only moves forward. */
  #syncing: Promise<void> = Promise.resolve();
  #reconnect: AbortController | undefined;

  constructor(options: ImapOptions, createClient: (options: ImapOptions) => ImapClient = defaultClient) {
    this.#options = options;
    this.#createClient = createClient;
  }

  async start(ctx: MailSourceContext): Promise<void> {
    this.#ctx = ctx;
    this.#stopped = false;
    // The first connection's errors propagate, so bad credentials fail start() instead of retrying forever.
    await this.#connect();
    await this.sync();
    this.#schedulePoll();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#reconnect?.abort();
    await this.#syncing;
    const client = this.#client;
    this.#client = undefined;
    await client?.logout().catch(() => {});
  }

  /** Log in and open the mailbox on a separate connection, then log out. Changes nothing. */
  async check(): Promise<void> {
    const client = this.#createClient(this.#options);
    client.on('error', () => {});
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.#options.mailbox ?? 'INBOX');
      lock.release();
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /** Fetch and deliver everything that arrived since the last sync. */
  sync(): Promise<void> {
    const next = this.#syncing.then(() => this.#syncOnce());
    this.#syncing = next.catch((error: unknown) => this.#ctx?.reportError(error));
    return next;
  }

  async #connect(): Promise<void> {
    // An ImapFlow instance can't reconnect; each connection needs a fresh client.
    const client = this.#createClient(this.#options);
    client.on('error', (error) => this.#ctx?.reportError(error));
    client.on('exists', () => void this.sync().catch(() => {}));
    client.on('close', () => {
      if (this.#client === client && !this.#stopped) void this.#reconnectWithBackoff();
    });
    await client.connect();
    this.#client = client;
  }

  async #reconnectWithBackoff(): Promise<void> {
    this.#reconnect = new AbortController();
    const { signal } = this.#reconnect;
    let backoffMs = 1000;
    while (!this.#stopped) {
      try {
        await sleep(backoffMs, undefined, { signal });
        await this.#connect();
        await this.sync();
        return;
      } catch (error) {
        if (signal.aborted) return;
        this.#ctx?.reportError(error);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async #syncOnce(): Promise<void> {
    const client = this.#client;
    const ctx = this.#ctx;
    if (!client?.usable || !ctx || this.#stopped) return;

    const fetched: Array<{ uid: number; source: Buffer }> = [];
    let uidValidity: string;
    const lock = await client.getMailboxLock(this.#options.mailbox ?? 'INBOX');
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return;
      uidValidity = String(mailbox.uidValidity);
      const lastUid = mailbox.uidNext - 1;

      // First run, or the server renumbered the mailbox: start after what's there, never answer old mail.
      if ((await ctx.state.get(UIDVALIDITY_KEY)) !== uidValidity) {
        await ctx.state.set(UIDVALIDITY_KEY, uidValidity);
        await ctx.state.set(UID_KEY, String(lastUid));
        return;
      }
      const cursor = Number((await ctx.state.get(UID_KEY)) ?? lastUid);
      if (lastUid <= cursor) return;

      // "n:*" always includes the newest message even when its uid is below n, hence the filter.
      for await (const message of client.fetch(`${cursor + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (message.uid > cursor && message.source) fetched.push({ uid: message.uid, source: message.source });
      }
    } finally {
      lock.release();
    }

    fetched.sort((a, b) => a.uid - b.uid);
    for (const { uid, source } of fetched) {
      await ctx.deliver(source, `${uidValidity}:${uid}`);
      // Saved after delivery: a crash re-delivers at most this one, and the agent's dedupe drops it.
      await ctx.state.set(UID_KEY, String(uid));
    }
  }

  #schedulePoll(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.sync()
        .catch(() => {})
        .finally(() => this.#schedulePoll());
    }, this.#options.pollIntervalMs ?? 30_000);
  }
}

function defaultClient(options: ImapOptions): ImapClient {
  return new ImapFlow({
    host: options.host,
    port: options.port ?? 993,
    secure: options.secure ?? true,
    auth: { user: options.user, pass: options.pass },
    logger: false,
  }) as unknown as ImapClient; // ImapFlow's fetch() is an overloaded generator; the narrower interface is what we call.
}
