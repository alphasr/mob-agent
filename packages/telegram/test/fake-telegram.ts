import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TgMessage, TgUpdate } from '../src/index.ts';

export const TOKEN = '123456:TEST-token_abc';

type Reply = { status: number; body: unknown };

/** A minimal Bot API server: long-polled getUpdates, sendMessage, and scripted failures. */
export class FakeTelegram {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly updates: TgUpdate[] = [];
  /** Queue of forced responses per method, consumed in order. */
  readonly failures = new Map<string, Reply[]>();
  #nextUpdateId = 100;
  #nextMessageId = 1000;
  #waiters: Array<() => void> = [];
  #server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const params = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const send = ({ status, body }: Reply) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (!match || match[1] !== TOKEN) {
      return send({
        status: 401,
        body: { ok: false, error_code: 401, description: 'Unauthorized' },
      });
    }
    const method = match[2]!;
    this.calls.push({ method, params });
    const forced = this.failures.get(method)?.shift();
    if (forced) return send(forced);
    send({
      status: 200,
      body: { ok: true, result: await this.#handle(method, params) },
    });
  });

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const w of this.#waiters) w();
    this.#server.closeAllConnections();
    await new Promise((r) => this.#server.close(r));
  }

  /** Simulate a user sending the bot a message. */
  push(message: Partial<TgMessage> & { text?: string }): TgUpdate {
    const update: TgUpdate = {
      update_id: this.#nextUpdateId++,
      message: {
        message_id: this.#nextMessageId++,
        date: 1_790_000_000,
        chat: { id: 42, type: 'private' },
        from: { id: 42, is_bot: false, first_name: 'Ada', last_name: 'L' },
        ...message,
      },
    };
    this.updates.push(update);
    for (const w of this.#waiters.splice(0)) w();
    return update;
  }

  sent(method = 'sendMessage') {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  async #handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return {
          id: 999,
          is_bot: true,
          first_name: 'TestBot',
          username: 'test_bot',
        };
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0);
        if (offset < 0) return this.updates.slice(offset);
        const pending = () => this.updates.filter((u) => u.update_id >= offset);
        if (pending().length === 0 && Number(params.timeout) > 0) {
          await new Promise<void>((resolve) => {
            this.#waiters.push(resolve);
            setTimeout(resolve, Number(params.timeout) * 1000).unref();
          });
        }
        return pending();
      }
      case 'sendMessage':
        return {
          message_id: this.#nextMessageId++,
          date: 0,
          chat: { id: Number(params.chat_id), type: 'private' },
        };
      case 'getFile':
        return { file_id: params.file_id, file_path: 'photos/file_1.jpg' };
      default:
        return true;
    }
  }
}
