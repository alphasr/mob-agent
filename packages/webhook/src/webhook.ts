import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SIGNATURE_HEADER, SIGNATURE_TOLERANCE_SEC, checkSignature, readBody, serve, signBody } from '@textagent/core';
import type { MessageContext, MessageHandler, RunningServer } from '@textagent/core';
import { parseAction } from './protocol.ts';
import type { TurnPayload } from './protocol.ts';

export interface WebhookOptions {
  /** Where turns are POSTed. Must be https://, except http://localhost while developing. */
  url: string;
  /** Shared secret for signing both directions. At least 32 characters. */
  secret: string;
  /** Public URL of this agent's reply endpoint, sent to your server as `turn.replyUrl`. Default: the built-in server's URL. */
  replyUrl?: string;
  /** Built-in server for the reply endpoint. Omit when mounting `handleRequest` yourself. */
  port?: number;
  /** Default: 127.0.0.1 */
  host?: string;
  /** Default: /textagent */
  path?: string;
  /** History entries included with each turn. Default: 20. */
  historyLimit?: number;
  /** How long a turn waits for its final reply. The conversation's next turn waits too. Default: 5 minutes. */
  turnTimeoutMs?: number;
  /** How long your server has to acknowledge a turn. Default: 10 seconds. */
  deliveryTimeoutMs?: number;
}

interface OpenTurn {
  ctx: MessageContext;
  finish: () => void;
  stopTyping: () => void;
}

const MAX_BODY_BYTES = 1024 * 1024;
/** Telegram's typing indicator lasts ~5s, so refresh a little sooner. */
const TYPING_REFRESH_MS = 4000;
const DELIVERY_ATTEMPTS = 3;

export function webhook(options: WebhookOptions): Webhook {
  return new Webhook(options);
}

/**
 * Hands each turn to a server you run, in any language:
 *
 *   agent.on('message', hook.handler);
 *   await hook.listen();
 */
export class Webhook {
  readonly #options: WebhookOptions;
  readonly #turns = new Map<string, OpenTurn>();
  /** Signatures already accepted, so a captured request can't be replayed within its validity window. */
  readonly #seen = new Map<string, number>();
  #server: RunningServer | undefined;
  #closed = false;

  constructor(options: WebhookOptions) {
    assertSafeUrl(options.url);
    if (options.secret.length < 32) throw new Error('webhook(): secret must be at least 32 characters');
    this.#options = options;
  }

  /** The reply endpoint's URL once `listen()` has run. */
  get url(): string | undefined {
    return this.#server?.url;
  }

  /** Pass to `agent.on('message', ...)`. Resolves when the turn is finished, keeping conversations in order. */
  readonly handler: MessageHandler = async (ctx) => {
    if (this.#closed) throw new Error('Webhook is closed');
    const id = randomUUID();
    const timeoutMs = this.#options.turnTimeoutMs ?? 5 * 60_000;
    const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);

    const turn: OpenTurn = { ctx, finish, stopTyping: this.#keepTyping(ctx) };
    this.#turns.set(id, turn);
    try {
      const payload = await this.#payload(id, ctx, new Date(Date.now() + timeoutMs));
      await ctx.trace.span('webhook.deliver', { turn: id }, () => this.#deliver(payload));
      await ctx.trace.span('webhook.wait', { turn: id }, () => finished);
      if (timedOut) {
        throw new Error(`Turn ${id} timed out after ${timeoutMs}ms without a final reply or close`);
      }
    } finally {
      clearTimeout(timer);
      turn.stopTyping();
      this.#turns.delete(id);
    }
  };

  /** The reply endpoint as a standard Request → Response function. */
  handleRequest = async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json(405, { ok: false, error: 'Use POST' });
    const body = await readBody(request, MAX_BODY_BYTES);
    if (!body) return json(413, { ok: false, error: 'Body too large' });

    const signature = request.headers.get(SIGNATURE_HEADER);
    const check = checkSignature(this.#options.secret, body, signature);
    if (check !== 'valid') return json(401, { ok: false, error: `Signature ${check}` });
    if (!this.#firstUse(signature!)) return json(409, { ok: false, error: 'Duplicate request (replayed signature)' });

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      return json(400, { ok: false, error: 'Body must be JSON' });
    }
    const action = parseAction(parsed);
    if (typeof action === 'string') return json(400, { ok: false, error: action });

    const turn = this.#turns.get(action.turn);
    if (!turn) return json(404, { ok: false, error: 'Unknown turn, or it already ended' });

    try {
      switch (action.action) {
        case 'reply': {
          turn.stopTyping();
          const sent = await turn.ctx.reply(action.text);
          if (action.final !== false) turn.finish();
          return json(200, { ok: true, messageIds: sent.map((m) => m.id) });
        }
        case 'typing':
          await turn.ctx.typing();
          return json(200, { ok: true });
        case 'close':
          turn.finish();
          return json(200, { ok: true });
      }
    } catch (error) {
      // The channel refused (blocked bot, 24h window, ...). Tell the caller so it can react.
      return json(502, { ok: false, error: (error as Error).message });
    }
  };

  /** Start the built-in server for the reply endpoint (needs `port`). Returns its URL. */
  async listen(): Promise<string> {
    if (this.#options.port === undefined)
      throw new Error('webhook(): pass `port` to use listen(), or mount handleRequest');
    this.#server = await serve(this.handleRequest, {
      port: this.#options.port,
      path: this.#options.path ?? '/textagent',
      ...(this.#options.host && { host: this.#options.host }),
    });
    return this.#server.url;
  }

  /** Stop the server and end every open turn. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const turn of this.#turns.values()) turn.finish();
    await this.#server?.close();
    this.#server = undefined;
  }

  async #payload(id: string, ctx: MessageContext, expiresAt: Date): Promise<TurnPayload> {
    const current = new Set(ctx.messages.map((m) => m.id));
    const history = await ctx.history((this.#options.historyLimit ?? 20) + ctx.messages.length);
    const replyUrl = this.#options.replyUrl ?? this.#server?.url;
    return {
      type: 'turn',
      turn: { id, expiresAt: expiresAt.toISOString(), ...(replyUrl && { replyUrl }) },
      channel: ctx.channel.name,
      thread: ctx.thread,
      sender: ctx.sender,
      messages: ctx.messages.map((m) => ({
        id: m.id,
        text: m.text,
        attachments: m.attachments,
        timestamp: m.timestamp.toISOString(),
      })),
      history: history
        .filter((h) => !current.has(h.messageId))
        .slice(-(this.#options.historyLimit ?? 20))
        .map((h) => ({
          role: h.role,
          text: h.text,
          ...(h.senderId && { senderId: h.senderId }),
          timestamp: h.timestamp.toISOString(),
        })),
    };
  }

  /** POST the turn; retry network errors, timeouts, 408, 429 and 5xx with backoff. */
  async #deliver(payload: TurnPayload): Promise<void> {
    const body = JSON.stringify(payload);
    let lastError: Error = new Error('not attempted');
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        const response = await fetch(this.#options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'textagent-webhook',
            'idempotency-key': payload.turn.id,
            // Re-signed per attempt so retries carry a fresh timestamp.
            [SIGNATURE_HEADER]: signBody(this.#options.secret, body),
          },
          body,
          signal: AbortSignal.timeout(this.#options.deliveryTimeoutMs ?? 10_000),
        });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`Webhook ${this.#options.url} answered ${response.status}`);
        if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
      } catch (error) {
        lastError = new Error(`Webhook ${this.#options.url} unreachable: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    throw lastError;
  }

  #keepTyping(ctx: MessageContext): () => void {
    if (!ctx.channel.capabilities.typingIndicator) return () => {};
    const tick = () => void ctx.typing().catch(() => {});
    tick();
    const interval = setInterval(tick, TYPING_REFRESH_MS);
    return () => clearInterval(interval);
  }

  #firstUse(signature: string): boolean {
    const now = Date.now();
    for (const [sig, at] of this.#seen) if (now - at > SIGNATURE_TOLERANCE_SEC * 1000) this.#seen.delete(sig);
    if (this.#seen.has(signature)) return false;
    this.#seen.set(signature, now);
    return true;
  }
}

/** Message text and phone numbers travel in these requests; only allow plaintext to this machine. */
function assertSafeUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`webhook(): "${raw}" is not a valid URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('webhook(): url must be https:// (http:// is only allowed for localhost)');
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
