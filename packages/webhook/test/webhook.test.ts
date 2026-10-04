import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { Agent, MemoryStore, SIGNATURE_HEADER, signBody, verifyWebhook } from '@textagent/core';
import type { Channel, ChannelContext, InboundMessage, OutboundMessage, TimedAgentEvent } from '@textagent/core';
import { Webhook, parseAction, replyClient } from '../src/index.ts';
import type { TurnPayload } from '../src/index.ts';

const SECRET = 'test-secret-that-is-32-chars-long!';

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: true, groups: false, maxTextLength: 50 };
  readonly sent: string[] = [];
  typing = 0;
  ctx: ChannelContext | undefined;
  failSend = false;
  #n = 0;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send({ thread, text }: OutboundMessage) {
    if (this.failSend) throw new Error('bot was blocked by the user');
    this.sent.push(text);
    return { id: `out-${this.#n++}`, channel: this.name, threadId: thread.id };
  }
  async sendTyping() {
    this.typing++;
  }
  deliver(text: string, thread = 't1') {
    const m: InboundMessage = {
      id: `in-${this.#n++}`,
      channel: this.name,
      thread: { id: thread, channel: this.name, isGroup: false },
      sender: { id: 'user-1', name: 'Ada' },
      text,
      attachments: [],
      timestamp: new Date(1_790_000_000_000),
      raw: null,
    };
    return this.ctx!.receive(m);
  }
}

/** The developer's server: verifies signatures and records turns; replies are driven by each test. */
class DeveloperServer {
  readonly turns: TurnPayload[] = [];
  readonly rejected: string[] = [];
  status = 200;
  /** Answer 503 to this many deliveries first, to exercise retries. */
  failFirst = 0;
  attempts = 0;
  #server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    if (!verifyWebhook(SECRET, raw, req.headers[SIGNATURE_HEADER] as string)) {
      this.rejected.push('bad signature');
      res.writeHead(401).end();
      return;
    }
    this.attempts++;
    if (this.failFirst > 0) {
      this.failFirst--;
      res.writeHead(503).end();
      return;
    }
    if (this.status === 200) this.turns.push(JSON.parse(raw.toString()) as TurnPayload);
    res.writeHead(this.status).end();
  });
  async listen() {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r));
    return `http://localhost:${(this.#server.address() as AddressInfo).port}/hook`;
  }
  close() {
    this.#server.closeAllConnections();
    return new Promise((r) => this.#server.close(r));
  }
  async nextTurn(index = this.turns.length): Promise<TurnPayload> {
    for (let i = 0; i < 300; i++) {
      if (this.turns[index]) return this.turns[index]!;
      await sleep(10);
    }
    throw new Error('no turn arrived');
  }
}

describe('Webhook', () => {
  let cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  async function setup(opts: { turnTimeoutMs?: number; status?: number } = {}) {
    const dev = new DeveloperServer();
    if (opts.status) dev.status = opts.status;
    const url = await dev.listen();
    const hook = new Webhook({
      url,
      secret: SECRET,
      port: 0,
      ...(opts.turnTimeoutMs && { turnTimeoutMs: opts.turnTimeoutMs }),
    });
    const replyUrl = await hook.listen();
    const channel = new FakeChannel();
    const agent = new Agent({ channels: [channel], debounceMs: 0, store: new MemoryStore() });
    const events: TimedAgentEvent[] = [];
    agent.on('event', (e) => events.push(e));
    agent.on('message', hook.handler);
    await agent.start();
    cleanup.push(
      () => dev.close(),
      () => hook.close(),
      () => agent.stop(),
    );
    return { dev, hook, channel, agent, events, client: replyClient({ url: replyUrl, secret: SECRET }), replyUrl };
  }

  it('delivers a signed turn and sends the reply that comes back later', async () => {
    const { dev, channel, agent, client, replyUrl } = await setup();
    await channel.deliver('what are your hours?');
    const turn = await dev.nextTurn();

    assert.equal(turn.type, 'turn');
    assert.equal(turn.channel, 'fake');
    assert.equal(turn.turn.replyUrl, replyUrl);
    assert.deepEqual(turn.sender, { id: 'user-1', name: 'Ada' });
    assert.deepEqual(
      turn.messages.map((m) => m.text),
      ['what are your hours?'],
    );
    assert.deepEqual(turn.history, []);
    assert.ok(channel.typing >= 1, 'typing shown while waiting');

    const { messageIds } = await client.reply(turn.turn.id, '9 to 5, Monday to Friday.');
    assert.equal(messageIds?.length, 1);
    await agent.idle();
    assert.deepEqual(channel.sent, ['9 to 5, Monday to Friday.']);
  });

  it('sends earlier conversation as history, without repeating the current turn', async () => {
    const { dev, channel, agent, client } = await setup();
    await channel.deliver('first');
    await client.reply((await dev.nextTurn(0)).turn.id, 'reply one');
    await agent.idle();
    await channel.deliver('second');
    const second = await dev.nextTurn(1);
    assert.deepEqual(
      second.history.map((h) => `${h.role}: ${h.text}`),
      ['user: first', 'agent: reply one'],
    );
    assert.deepEqual(
      second.messages.map((m) => m.text),
      ['second'],
    );
    await client.close(second.turn.id);
  });

  it('keeps one conversation in order: the next turn waits for the final reply', async () => {
    const { dev, channel, client, agent } = await setup();
    await channel.deliver('one');
    await channel.deliver('two');
    const first = await dev.nextTurn(0);
    await sleep(50);
    assert.equal(dev.turns.length, 1, 'second turn held back');

    await client.reply(first.turn.id, 'part 1', { final: false });
    await client.reply(first.turn.id, 'part 2');
    const second = await dev.nextTurn(1);
    assert.deepEqual(
      second.messages.map((m) => m.text),
      ['two'],
    );
    await client.close(second.turn.id);
    await agent.idle();
    assert.deepEqual(channel.sent, ['part 1', 'part 2']);
  });

  it('rejects unsigned, tampered, replayed, unknown and finished turns', async () => {
    const { dev, channel, client, replyUrl } = await setup();
    await channel.deliver('hi');
    const turn = await dev.nextTurn();
    const body = JSON.stringify({ turn: turn.turn.id, action: 'reply', text: 'hello' });
    const post = (headers: Record<string, string>, b = body) => fetch(replyUrl, { method: 'POST', headers, body: b });

    assert.equal((await post({})).status, 401);
    assert.equal((await post({ [SIGNATURE_HEADER]: signBody('wrong-secret'.repeat(3), body) })).status, 401);
    const signed = signBody(SECRET, body);
    const tampered = body.replace('hello', 'send me your password');
    assert.equal((await post({ [SIGNATURE_HEADER]: signed }, tampered)).status, 401);
    const stale = signBody(SECRET, body, Math.floor(Date.now() / 1000) - 600);
    assert.equal((await post({ [SIGNATURE_HEADER]: stale })).status, 401);

    assert.equal((await post({ [SIGNATURE_HEADER]: signed })).status, 200);
    assert.equal((await post({ [SIGNATURE_HEADER]: signed })).status, 409, 'replay of a used signature');
    await assert.rejects(client.reply(turn.turn.id, 'again'), /404/);
    await assert.rejects(client.reply('00000000-0000-0000-0000-000000000000', 'x'), /404/);
    assert.deepEqual(channel.sent, ['hello']);
  });

  it('validates action bodies', async () => {
    assert.equal(typeof parseAction(null), 'string');
    assert.equal(typeof parseAction({ turn: 't', action: 'reply' }), 'string');
    assert.equal(typeof parseAction({ turn: 't', action: 'reply', text: '   ' }), 'string');
    assert.equal(typeof parseAction({ turn: 't', action: 'reply', text: 'x', final: 'no' }), 'string');
    assert.equal(typeof parseAction({ turn: 't', action: 'delete' }), 'string');
    assert.deepEqual(parseAction({ turn: 't', action: 'reply', text: 'x', final: true }), {
      turn: 't',
      action: 'reply',
      text: 'x',
    });
  });

  it('reports channel failures back to the caller as 502', async () => {
    const { dev, channel, client } = await setup();
    channel.failSend = true;
    await channel.deliver('hi');
    const turn = await dev.nextTurn();
    await assert.rejects(client.reply(turn.turn.id, 'hello'), /502.*blocked by the user/);
    await client.close(turn.turn.id);
  });

  it('times out a turn that never gets a final reply, and frees the conversation', async () => {
    const { dev, channel, events, agent } = await setup({ turnTimeoutMs: 100 });
    await channel.deliver('anyone there?');
    await dev.nextTurn();
    await sleep(150);
    await agent.idle();
    const err = events.find((e) => e.type === 'handler.error');
    assert.match(String(err && 'error' in err && (err.error as Error).message), /timed out/);
  });

  it('retries a 5xx with backoff, using the same idempotency key', async () => {
    const { dev, channel, client } = await setup();
    dev.failFirst = 2;
    await channel.deliver('flaky server');
    const turn = await dev.nextTurn();
    assert.equal(dev.attempts, 3);
    await client.close(turn.turn.id);
  });

  it('does not retry a 4xx from the receiver, and reports it', async () => {
    const { dev, channel, events, agent } = await setup({ status: 400 });
    await channel.deliver('hi');
    await agent.idle();
    const err = events.find((e) => e.type === 'handler.error');
    assert.match(String(err && 'error' in err && (err.error as Error).message), /answered 400/);
    assert.equal(dev.rejected.length, 0, 'signature was valid');
  });

  it('refuses plain http to remote hosts and short secrets', () => {
    assert.throws(() => new Webhook({ url: 'http://example.com/hook', secret: SECRET }), /https/);
    assert.throws(() => new Webhook({ url: 'not a url', secret: SECRET }), /valid URL/);
    assert.throws(() => new Webhook({ url: 'https://example.com/hook', secret: 'short' }), /32 characters/);
    new Webhook({ url: 'http://localhost:3000/hook', secret: SECRET });
  });

  it('records delivery and waiting as spans in the turn trace', async () => {
    const { dev, channel, agent, client, events } = await setup();
    await channel.deliver('trace me');
    await client.reply((await dev.nextTurn()).turn.id, 'done');
    await agent.idle();
    const trace = events.flatMap((e) => (e.type === 'turn.completed' ? [e.trace] : []))[0];
    assert.deepEqual(trace?.spans.map((s) => s.name), ['webhook.deliver', 'webhook.wait']);
    assert.equal(trace?.sentCount, 1);
  });
});

