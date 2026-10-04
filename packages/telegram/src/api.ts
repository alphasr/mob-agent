/** The slice of the Telegram Bot API this channel uses. https://core.telegram.org/bots/api */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  is_forum?: boolean;
}

interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TgFile[];
  document?: TgFile;
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  sticker?: TgFile & { emoji?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  /** Seconds to wait before retrying, when Telegram rate-limited us. */
  readonly retryAfter: number | undefined;
  constructor(method: string, status: number, description: string, retryAfter?: number) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface TelegramApiOptions {
  token: string;
  /** Default: https://api.telegram.org (override for a local Bot API server or tests). */
  apiBase?: string;
}

export class TelegramApi {
  readonly #token: string;
  readonly #base: string;

  constructor({ token, apiBase = 'https://api.telegram.org' }: TelegramApiOptions) {
    if (!/^\d+:[\w-]+$/.test(token)) {
      throw new Error('That does not look like a Telegram bot token (expected "123456:ABC-..." from @BotFather).');
    }
    this.#token = token;
    this.#base = apiBase.replace(/\/$/, '');
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        ...(signal && { signal }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // fetch errors can echo the URL, and the URL contains the token.
      throw new Error(this.#redact(`Telegram ${method} request failed: ${String((error as Error).message)}`));
    }

    const body = (await response.json().catch(() => undefined)) as
      | { ok: true; result: T }
      | { ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number } }
      | undefined;

    if (body?.ok) return body.result;
    throw new TelegramApiError(
      method,
      body?.error_code ?? response.status,
      this.#redact(body?.description ?? response.statusText),
      body?.parameters?.retry_after,
    );
  }

  #redact(text: string): string {
    return text.replaceAll(this.#token, '<token>');
  }
}
