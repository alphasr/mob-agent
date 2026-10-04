import { setTimeout as sleep } from 'node:timers/promises';
import type {
  Channel,
  CheckResult,
  NewMessage,
  ChannelCapabilities,
  ChannelContext,
  OutboundMessage,
  SentMessage,
  Thread,
} from '@textagent/core';
import { TelegramApi, TelegramApiError } from './api.ts';
import type { TgMessage, TgUpdate, TgUser } from './api.ts';
import { normalize, parseThreadId } from './normalize.ts';

export interface TelegramOptions {
  /** From @BotFather. */
  token: string;
  /** Default: https://api.telegram.org */
  apiBase?: string;
  /** Long-poll duration in seconds. Default: 25. */
  pollTimeoutSec?: number;
  /** Ignore messages sent to the bot while it was offline. Default: false (Telegram keeps them 24h). */
  dropPendingUpdates?: boolean;
}

const OFFSET_KEY = 'offset';
const MAX_BACKOFF_MS = 60_000;
/** Longest rate-limit wait we'll sit through on a send before giving up. */
const MAX_SEND_RETRY_S = 30;

export function telegram(options: TelegramOptions): TelegramChannel {
  return new TelegramChannel(options);
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  readonly capabilities: ChannelCapabilities = {
    maxTextLength: 4096,
    typingIndicator: true,
    groups: true,
  };

  readonly #api: TelegramApi;
  readonly #options: TelegramOptions;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #bot: TgUser | undefined;

  constructor(options: TelegramOptions) {
    this.#options = options;
    this.#api = new TelegramApi(options);
  }

  /** The bot's own account, available after start(). */
  get bot(): TgUser | undefined {
    return this.#bot;
  }

  async start(ctx: ChannelContext): Promise<void> {
    try {
      this.#bot = await this.#api.call<TgUser>('getMe');
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        throw new Error('Telegram rejected the bot token. Check it with @BotFather (/mybots → API Token).', {
          cause: error,
        });
      }
      throw error;
    }

    if (this.#options.dropPendingUpdates) {
      // offset -1 returns only the newest update; confirming it discards everything before.
      const [latest] = await this.#api.call<TgUpdate[]>('getUpdates', {
        offset: -1,
        timeout: 0,
      });
      if (latest) await ctx.state.set(OFFSET_KEY, String(latest.update_id + 1));
    }

    this.#abort = new AbortController();
    this.#loop = this.#pollLoop(ctx, this.#abort.signal);
  }

  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
    this.#abort = undefined;
    this.#loop = undefined;
  }

  async check(): Promise<CheckResult[]> {
    let bot: TgUser;
    try {
      bot = await this.#api.call<TgUser>('getMe');
    } catch (error) {
      const unauthorized = error instanceof TelegramApiError && error.status === 401;
      return [
        {
          name: 'Telegram bot token',
          ok: false,
          detail: (error as Error).message,
          fix: unauthorized ? 'Copy the token again from @BotFather (/mybots → API Token).' : 'Check your internet connection.',
        },
      ];
    }
    const results: CheckResult[] = [{ name: 'Telegram bot token', ok: true, detail: `@${bot.username ?? bot.first_name}` }];
    const hook = await this.#api.call<{ url?: string }>('getWebhookInfo');
    results.push(
      hook.url
        ? {
            name: 'Telegram polling',
            ok: false,
            detail: `A webhook is set (${hook.url}), so polling can't receive messages.`,
            fix: 'Remove it by calling the deleteWebhook method for this bot.',
          }
        : { name: 'Telegram polling', ok: true },
    );
    return results;
  }

  async send({ thread, text, replyTo }: OutboundMessage): Promise<SentMessage> {
    const { chatId, topicId } = parseThreadId(thread.id);
    const params: Record<string, unknown> = {
      chat_id: chatId,
      // Plain text on purpose: MarkdownV2 rejects the whole message over one unescaped "." or "!".
      text,
      ...(topicId !== undefined && { message_thread_id: topicId }),
    };
    // In a busy group, quote the message being answered so it's clear who the reply is for.
    const original = replyTo?.raw as TgMessage | undefined;
    if (thread.isGroup && original?.message_id) {
      params.reply_parameters = {
        message_id: original.message_id,
        allow_sending_without_reply: true,
      };
    }

    const sent = await this.#withRateLimitRetry(() => this.#api.call<TgMessage>('sendMessage', params));
    return {
      id: `${chatId}:${sent.message_id}`,
      channel: this.name,
      threadId: thread.id,
    };
  }

  /** Message a chat that has talked to the bot before; Telegram doesn't let bots message strangers. */
  async sendNew({ to, text, template }: NewMessage): Promise<{ sent: SentMessage; thread: Thread }> {
    if (template) throw new Error('Telegram has no message templates; send text');
    if (!text) throw new Error('Telegram needs text to send');
    const thread: Thread = { id: to, channel: this.name, isGroup: to.startsWith('-') };
    try {
      return { sent: await this.send({ thread, text }), thread };
    } catch (error) {
      if (error instanceof TelegramApiError && (error.status === 403 || /chat not found/i.test(error.message))) {
        throw new Error(
          `Telegram chat ${to} hasn't messaged this bot (or blocked it). Bots can only message people who started them.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async sendTyping(thread: Thread): Promise<void> {
    const { chatId, topicId } = parseThreadId(thread.id);
    // Shows "typing…" for ~5 seconds or until the next message.
    await this.#api.call('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(topicId !== undefined && { message_thread_id: topicId }),
    });
  }

  /**
   * Download URL for an attachment uri (`telegram-file:<id>`). Valid for about an hour.
   * The URL embeds the bot token: fetch it server-side, never show it to users.
   */
  async fileUrl(uri: string): Promise<string> {
    const fileId = uri.replace(/^telegram-file:/, '');
    const file = await this.#api.call<{ file_path?: string }>('getFile', {
      file_id: fileId,
    });
    if (!file.file_path) throw new Error('Telegram did not return a path for this file (it may be over 20 MB).');
    const base = (this.#options.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
    return `${base}/file/bot${this.#options.token}/${file.file_path}`;
  }

  async #pollLoop(ctx: ChannelContext, signal: AbortSignal): Promise<void> {
    let backoffMs = 1000;
    while (!signal.aborted) {
      try {
        const offset = await ctx.state.get(OFFSET_KEY);
        const updates = await this.#api.call<TgUpdate[]>(
          'getUpdates',
          {
            ...(offset !== undefined && { offset: Number(offset) }),
            timeout: this.#options.pollTimeoutSec ?? 25,
            allowed_updates: ['message'],
          },
          signal,
        );
        for (const update of updates) {
          const message = update.message && normalize(update.message);
          if (message) await ctx.receive(message);
          // Confirmed per update, after delivery: a crash re-delivers at most one, and dedupe drops it.
          await ctx.state.set(OFFSET_KEY, String(update.update_id + 1));
        }
        backoffMs = 1000;
      } catch (error) {
        if (signal.aborted) return;
        ctx.reportError(explain(error));
        const waitMs = error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        await sleep(waitMs, undefined, { signal }).catch(() => {});
      }
    }
  }

  async #withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 429 && error.retryAfter !== undefined) {
        if (error.retryAfter > MAX_SEND_RETRY_S) throw error;
        await sleep(error.retryAfter * 1000);
        return fn();
      }
      throw error;
    }
  }
}

/** Turn the two common setup mistakes into instructions. */
function explain(error: unknown): unknown {
  if (!(error instanceof TelegramApiError) || error.status !== 409) return error;
  const hint = /webhook/i.test(error.message)
    ? 'This bot has a webhook set, so it cannot poll. Remove it with the deleteWebhook method, or run in webhook mode.'
    : 'Another process is polling with this bot token. Stop the other instance; only one may run per token.';
  return new Error(hint, { cause: error });
}
