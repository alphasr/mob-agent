import { readBody, serve } from '@textagent/core';
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  CheckResult,
  NewMessage,
  OutboundMessage,
  RunningServer,
  SentMessage,
  Thread,
} from '@textagent/core';
import { WhatsAppApi } from './api.ts';
import { messagesFromPayload } from './payload.ts';
import { isValidSignature, safeEqual } from './signature.ts';

export interface WhatsAppOptions {
  /** Permanent System User token (or a temporary token while testing). */
  accessToken: string;
  /** The business phone number's id from the Meta app dashboard (not the phone number itself). */
  phoneNumberId: string;
  /** App secret (App settings → Basic). Used to verify that webhooks really come from Meta. */
  appSecret: string;
  /** Any string you choose; enter the same one when configuring the webhook in Meta. */
  verifyToken: string;
  /** Start a built-in HTTP server on this port. Omit when mounting `handleRequest` in your own server. */
  port?: number;
  /** Default: 127.0.0.1 (reach it through a tunnel or reverse proxy). */
  host?: string;
  /** Path the built-in server answers on. Default: /webhook */
  path?: string;
  apiVersion?: string;
  apiBase?: string;
}

/** WhatsApp allows free-form messages only this long after the person's last message. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class WindowClosedError extends Error {
  constructor(to: string) {
    super(
      `${to} hasn't messaged in the last 24 hours, so WhatsApp only allows a pre-approved template. ` +
        'Pass `template` instead of text.',
    );
    this.name = 'WindowClosedError';
  }
}

/** Meta's payloads are a few KB; anything this large is not a real webhook. */
const MAX_BODY_BYTES = 1024 * 1024;

export function whatsapp(options: WhatsAppOptions): WhatsAppChannel {
  return new WhatsAppChannel(options);
}

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  readonly capabilities: ChannelCapabilities = {
    maxTextLength: 4096,
    typingIndicator: true,
    groups: false,
  };

  readonly #options: WhatsAppOptions;
  readonly #api: WhatsAppApi;
  #ctx: ChannelContext | undefined;
  #server: RunningServer | undefined;
  /** Delivery runs after the 200 is sent; this chain keeps payloads in arrival order. */
  #inbox: Promise<void> = Promise.resolve();
  /** Typing indicators attach to a received message, so remember the latest per thread. */
  readonly #lastInbound = new Map<string, string>();

  constructor(options: WhatsAppOptions) {
    for (const key of ['accessToken', 'phoneNumberId', 'appSecret', 'verifyToken'] as const) {
      if (!options[key]) throw new Error(`whatsapp(): ${key} is required`);
    }
    this.#options = options;
    this.#api = new WhatsAppApi(options);
  }

  /** Address of the built-in server, once started with `port`. */
  get url(): string | undefined {
    return this.#server?.url;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.#ctx = ctx;
    if (this.#options.port === undefined) return;
    this.#server = await serve((request) => this.handleRequest(request), {
      port: this.#options.port,
      path: this.#options.path ?? '/webhook',
      ...(this.#options.host && { host: this.#options.host }),
      onError: (error) => this.#ctx?.reportError(error),
    });
  }

  async stop(): Promise<void> {
    await this.#server?.close();
    this.#server = undefined;
    await this.#inbox;
    this.#ctx = undefined;
  }

  /**
   * The webhook endpoint as a standard Request → Response function. Mount it in any
   * server (Next.js route handler, Hono, Express via an adapter, ...) at the URL you give Meta.
   */
  async handleRequest(request: Request): Promise<Response> {
    const ctx = this.#ctx;
    // 503 makes Meta retry later instead of dropping messages that arrive during startup.
    if (!ctx) return new Response('Not started', { status: 503 });

    if (request.method === 'GET') return this.#verifySubscription(new URL(request.url));
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const body = await readBody(request, MAX_BODY_BYTES);
    if (!body) return new Response('Payload too large', { status: 413 });
    if (!isValidSignature(body, request.headers.get('x-hub-signature-256'), this.#options.appSecret)) {
      ctx.reportError(new Error('Rejected a WhatsApp webhook with a missing or invalid signature'));
      return new Response('Invalid signature', { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const messages = messagesFromPayload(payload, this.#options.phoneNumberId);
    for (const m of messages) this.#lastInbound.set(m.thread.id, m.id);
    // Acknowledge first: Meta retries anything slow, and the agent's dedupe absorbs those retries anyway.
    this.#inbox = this.#inbox.then(async () => {
      for (const message of messages) {
        // Durable, so the 24-hour window is still known after a restart.
        await ctx.state.set(`window:${message.thread.id}`, String(message.timestamp.getTime())).catch(() => {});
        await ctx.receive(message).catch((error: unknown) => ctx.reportError(error));
      }
    });
    return new Response('OK', { status: 200 });
  }

  /**
   * Resolves once every webhook received so far has been handed to the agent.
   * On serverless hosts that freeze after the response, pass it to `waitUntil()`.
   */
  async drain(): Promise<void> {
    await this.#inbox;
  }

  async check(): Promise<CheckResult[]> {
    try {
      const number = await this.#api.getPhoneNumber();
      const detail = [number.display_phone_number, number.verified_name].filter(Boolean).join(' · ');
      return [{ name: 'WhatsApp access token and phone number id', ok: true, ...(detail && { detail }) }];
    } catch (error) {
      return [
        {
          name: 'WhatsApp access token and phone number id',
          ok: false,
          detail: (error as Error).message,
          fix: 'Copy both again from the Meta app dashboard (WhatsApp → API Setup).',
        },
      ];
    }
  }

  async send({ thread, text, replyTo }: OutboundMessage): Promise<SentMessage> {
    // A reply is inside the window by definition; a proactive message may not be.
    if (!replyTo && (await this.#windowOpen(thread.id)) === false) throw new WindowClosedError(thread.id);
    const id = await this.#api.sendText(thread.id, text);
    return { id, channel: this.name, threadId: thread.id };
  }

  /** Text inside the 24-hour window, or a pre-approved template at any time. */
  async sendNew({ to, text, template }: NewMessage): Promise<{ sent: SentMessage; thread: Thread }> {
    const waId = to.replace(/^\+/, '');
    const thread: Thread = { id: waId, channel: this.name, isGroup: false };
    let id: string;
    if (template) {
      id = await this.#api.sendTemplate(waId, template);
    } else {
      if (!text) throw new Error('WhatsApp needs text or a template');
      if ((await this.#windowOpen(waId)) !== true) throw new WindowClosedError(waId);
      id = await this.#api.sendText(waId, text);
    }
    return { sent: { id, channel: this.name, threadId: waId }, thread };
  }

  /** true/false when we've seen this person; undefined when we can't tell (never seen, or not started). */
  async #windowOpen(waId: string): Promise<boolean | undefined> {
    const last = await this.#ctx?.state.get(`window:${waId}`);
    if (last === undefined) return undefined;
    return Date.now() - Number(last) < SERVICE_WINDOW_MS;
  }

  async sendTyping(thread: Thread): Promise<void> {
    const messageId = this.#lastInbound.get(thread.id);
    if (messageId) await this.#api.sendTyping(messageId);
  }

  /** Fetch an attachment (`whatsapp-media:<id>`). Media ids expire about 30 days after the message. */
  async downloadMedia(uri: string): Promise<{ data: Uint8Array; mimeType: string | undefined }> {
    return this.#api.downloadMedia(uri.replace(/^whatsapp-media:/, ''));
  }

  #verifySubscription(url: URL): Response {
    const p = url.searchParams;
    if (p.get('hub.mode') === 'subscribe' && safeEqual(p.get('hub.verify_token') ?? '', this.#options.verifyToken)) {
      return new Response(p.get('hub.challenge') ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403 });
  }
}
