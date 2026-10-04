import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Agent, MemoryStore } from '@textagent/core';
import type { InboundMessage, TimedAgentEvent } from '@textagent/core';
import { TelegramApi, normalize, telegram } from '../src/index.ts';
import type { TgMessage } from '../src/index.ts';
import { FakeTelegram, TOKEN } from './fake-telegram.ts';

const base = (m: Partial<TgMessage>): TgMessage => ({
  message_id: 7,
  date: 1_790_000_000,
  chat: { id: 42, type: 'private' },
  from: { id: 42, is_bot: false, first_name: 'Ada' },
  ...m,
});

describe('normalize', () => {
  it('scopes ids per chat and maps the sender', () => {
    const m = normalize(
      base({
        text: ' hi ',
        from: { id: 42, is_bot: false, first_name: 'Ada', last_name: 'L' },
      }),
    )!;
    assert.equal(m.id, '42:7');
    assert.equal(m.text, 'hi');
    assert.deepEqual(m.sender, { id: '42', name: 'Ada L' });
    assert.deepEqual(m.thread, {
      id: '42',
      channel: 'telegram',
      isGroup: false,
    });
    assert.equal(m.timestamp.getTime(), 1_790_000_000_000);
    assert.notEqual(normalize(base({ text: 'x', chat: { id: 43, type: 'private' } }))!.id, m.id);
  });

  it('keeps forum topics in the thread id', () => {
    const m = normalize(
      base({
        text: 'q',
        chat: { id: -100, type: 'supergroup', is_forum: true },
        is_topic_message: true,
        message_thread_id: 5,
      }),
    )!;
    assert.equal(m.thread.id, '-100:5');
    assert.equal(m.thread.isGroup, true);
  });

  it('uses captions and largest photo; drops bots, service messages and anonymous posts', () => {
    const photo = normalize(
      base({
        caption: 'look',
        photo: [
          { file_id: 'small', file_unique_id: 's' },
          { file_id: 'big', file_unique_id: 'b' },
        ],
      }),
    )!;
    assert.equal(photo.text, 'look');
    assert.deepEqual(photo.attachments, [{ kind: 'image', uri: 'telegram-file:big', mimeType: 'image/jpeg' }]);

    assert.equal(
      normalize(
        base({
          text: 'beep',
          from: { id: 1, is_bot: true, first_name: 'Other' },
        }),
      ),
      undefined,
    );
    assert.equal(normalize(base({})), undefined, 'no text, no media: a join/pin/title change');
    const { from: _from, ...anonymous } = base({ text: 'post' });
    assert.equal(normalize(anonymous as TgMessage), undefined);
  });
});

describe('TelegramApi', () => {
  it('rejects malformed tokens up front', () => {
    assert.throws(() => new TelegramApi({ token: 'not-a-token' }), /bot token/);
  });

  it('never puts the token in error messages', async () => {
    const api = new TelegramApi({
      token: TOKEN,
      apiBase: 'http://127.0.0.1:1',
    });
    await assert.rejects(api.call('getMe'), (e: Error) => {
      assert.ok(!e.message.includes(TOKEN), e.message);
      return true;
    });
  });
});

describe('TelegramChannel with Agent', () => {
  let server: FakeTelegram;
  let apiBase: string;
  let agent: Agent | undefined;

  beforeEach(async () => {
    server = new FakeTelegram();
    apiBase = await server.listen();
  });
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await server.close();
  });

  async function start(
    opts: {
      store?: MemoryStore;
      dropPendingUpdates?: boolean;
      token?: string;
      handler?: (text: string) => string;
    } = {},
  ) {
    const channel = telegram({
      token: opts.token ?? TOKEN,
      apiBase,
      pollTimeoutSec: 1,
      ...(opts.dropPendingUpdates && { dropPendingUpdates: true }),
    });
    const a = new Agent({
      channels: [channel],
      debounceMs: 0,
      store: opts.store ?? new MemoryStore(),
      groups: true,
    });
    const events: TimedAgentEvent[] = [];
    const handled: InboundMessage[] = [];
    a.on('event', (e) => events.push(e));
    a.on('message', async (ctx) => {
      handled.push(ctx.message);
      await ctx.typing();
      await ctx.reply(opts.handler ? opts.handler(ctx.text) : `echo: ${ctx.text}`);
    });
    await a.start();
    agent = a;
    return { channel, events, handled };
  }

  /** Wait until `check` passes or time runs out. */
  async function eventually(check: () => void, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      try {
        return check();
      } catch (e) {
        if (Date.now() > end) throw e;
        await sleep(10);
      }
    }
  }

  it('long-polls, replies, and shows typing', async () => {
    const { channel } = await start();
    assert.equal(channel.bot?.username, 'test_bot');
    server.push({ text: 'hello' });

    await eventually(() => assert.deepEqual(server.sent(), [{ chat_id: '42', text: 'echo: hello' }]));
    assert.deepEqual(server.sent('sendChatAction'), [{ chat_id: '42', action: 'typing' }]);
  });

  it('quotes the original in groups and replies into forum topics', async () => {
    await start();
    const u = server.push({
      text: 'q',
      chat: { id: -100, type: 'supergroup', is_forum: true },
      is_topic_message: true,
      message_thread_id: 5,
    });
    await eventually(() =>
      assert.deepEqual(server.sent(), [
        {
          chat_id: '-100',
          text: 'echo: q',
          message_thread_id: 5,
          reply_parameters: {
            message_id: u.message!.message_id,
            allow_sending_without_reply: true,
          },
        },
      ]),
    );
  });

  it('splits replies over 4096 characters', async () => {
    await start({ handler: () => 'word '.repeat(2000) });
    server.push({ text: 'long please' });
    await eventually(() => assert.equal(server.sent().length, 3));
    assert.ok(server.sent().every((p) => String(p.text).length <= 4096));
  });

  it('saves its offset and does not re-answer after a restart', async () => {
    const store = new MemoryStore();
    const first = await start({ store });
    server.push({ text: 'one' });
    await eventually(() => assert.equal(first.handled.length, 1));
    await agent!.stop();
    agent = undefined;
    assert.equal(await store.getState('telegram', 'offset'), '101');

    server.push({ text: 'two' });
    const second = await start({ store });
    await eventually(() =>
      assert.deepEqual(
        second.handled.map((m) => m.text),
        ['two'],
      ),
    );
    await sleep(50);
    assert.equal(server.sent().length, 2, 'one reply each, nothing repeated');
  });

  it('can skip messages that arrived while offline', async () => {
    server.push({ text: 'stale 1' });
    server.push({ text: 'stale 2' });
    const { handled } = await start({ dropPendingUpdates: true });
    server.push({ text: 'fresh' });
    await eventually(() =>
      assert.deepEqual(
        handled.map((m) => m.text),
        ['fresh'],
      ),
    );
  });

  it('fails start() with a clear message for a revoked token', async () => {
    await assert.rejects(start({ token: '123456:WRONG' }), /rejected the bot token/);
  });

  it('explains a polling conflict, then recovers', async () => {
    server.failures.set('getUpdates', [
      {
        status: 409,
        body: {
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates request',
        },
      },
    ]);
    const { events, handled } = await start();
    server.push({ text: 'after conflict' });
    await eventually(() => assert.equal(handled.length, 1), 5000);
    const err = events.find((e) => e.type === 'channel.error');
    assert.match(String(err && 'error' in err && (err.error as Error).message), /Another process is polling/);
  });

  it('waits out a rate limit on send and retries once', async () => {
    server.failures.set('sendMessage', [
      {
        status: 429,
        body: {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 1 },
        },
      },
    ]);
    await start();
    server.push({ text: 'busy' });
    await eventually(() => assert.equal(server.sent().length, 2), 4000);
  });

  it('stops promptly even mid long-poll', async () => {
    await start();
    await sleep(50);
    const t = Date.now();
    await agent!.stop();
    agent = undefined;
    assert.ok(Date.now() - t < 500, `stop took ${Date.now() - t}ms`);
  });

  it('builds file download URLs', async () => {
    const { channel } = await start();
    assert.equal(await channel.fileUrl('telegram-file:abc'), `${apiBase}/file/bot${TOKEN}/photos/file_1.jpg`);
  });

  it('check() confirms the token without sending anything', async () => {
    const ok = await telegram({ token: TOKEN, apiBase }).check();
    assert.deepEqual(ok, [
      { name: 'Telegram bot token', ok: true, detail: '@test_bot' },
      { name: 'Telegram polling', ok: true },
    ]);
    const bad = await telegram({ token: '123456:WRONG', apiBase }).check();
    assert.equal(bad[0]?.ok, false);
    assert.match(bad[0]?.fix ?? '', /BotFather/);
    assert.equal(server.sent().length, 0);
  });

  it('sendNew messages a known chat, and explains chats that never started the bot', async () => {
    const channel = telegram({ token: TOKEN, apiBase });
    const { thread } = await channel.sendNew({ to: '42', text: 'Your order shipped' });
    assert.deepEqual(thread, { id: '42', channel: 'telegram', isGroup: false });
    assert.deepEqual(server.sent().at(-1), { chat_id: '42', text: 'Your order shipped' });

    server.failures.set('sendMessage', [
      { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } },
    ]);
    await assert.rejects(channel.sendNew({ to: '77', text: 'hi' }), /hasn't messaged this bot/);
    await assert.rejects(channel.sendNew({ to: '42', template: { name: 'x', language: 'en' } }), /no message templates/);
  });
});
