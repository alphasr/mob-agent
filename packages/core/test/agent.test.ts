import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { Agent, MemoryStore } from '../src/index.ts';
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  SentMessage,
  TimedAgentEvent,
} from '../src/index.ts';

class FakeChannel implements Channel {
  readonly sent: OutboundMessage[] = [];
  ctx: ChannelContext | undefined;
  stopped = false;
  #nextId = 0;

  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  readonly failStart: boolean;

  constructor(
    name = 'fake',
    capabilities: ChannelCapabilities = { typingIndicator: false, groups: true, canInitiate: true },
    failStart = false,
  ) {
    this.name = name;
    this.capabilities = capabilities;
    this.failStart = failStart;
  }

  async start(ctx: ChannelContext) {
    if (this.failStart) throw new Error(`${this.name} failed to start`);
    this.ctx = ctx;
  }
  async stop() {
    this.stopped = true;
  }
  async send(message: OutboundMessage): Promise<SentMessage> {
    this.sent.push(message);
    return { id: `out-${this.#nextId++}`, channel: this.name, threadId: message.thread.id };
  }
  /** Simulate an incoming message. */
  deliver(text: string, opts: { from?: string; thread?: string; group?: boolean; id?: string } = {}) {
    const msg: InboundMessage = {
      id: opts.id ?? `in-${this.#nextId++}`,
      channel: this.name,
      thread: { id: opts.thread ?? 't1', channel: this.name, isGroup: opts.group ?? false },
      sender: { id: opts.from ?? '+15550001' },
      text,
      attachments: [],
      timestamp: new Date(),
      raw: null,
    };
    return this.ctx!.receive(msg);
  }
}

function setup(opts: { debounceMs?: number; allow?: (m: InboundMessage) => boolean; groups?: boolean } = {}) {
  const channel = new FakeChannel();
  const agent = new Agent({ channels: [channel], debounceMs: 0, ...opts });
  const events: TimedAgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  return { channel, agent, events };
}

describe('Agent', () => {
  it('replies in the same thread', async () => {
    const { channel, agent } = setup();
    agent.on('message', (ctx) => ctx.reply(`echo: ${ctx.text}`));
    await agent.start();
    await channel.deliver('hi', { thread: 'abc' });
    await agent.stop();

    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0]!.text, 'echo: hi');
    assert.equal(channel.sent[0]!.thread.id, 'abc');
    assert.equal(channel.sent[0]!.replyTo?.text, 'hi');
  });

  it('batches rapid-fire messages from one sender into a single turn', async () => {
    const { channel, agent } = setup({ debounceMs: 30 });
    const turns: string[][] = [];
    agent.on('message', (ctx) => void turns.push(ctx.messages.map((m) => m.text)));
    await agent.start();

    await channel.deliver('hey');
    await sleep(10);
    await channel.deliver('quick q');
    await channel.deliver('hey', { from: '+15550002' }); // different sender, separate turn
    await sleep(60);

    assert.deepEqual(turns.sort(), [['hey'], ['hey', 'quick q']]);
    await agent.stop();
  });

  it('flushes debounced messages on stop instead of dropping them', async () => {
    const { channel, agent } = setup({ debounceMs: 10_000 });
    const seen: string[] = [];
    agent.on('message', (ctx) => void seen.push(ctx.text));
    await agent.start();
    await channel.deliver('last words');
    await agent.stop();

    assert.deepEqual(seen, ['last words']);
    assert.equal(channel.stopped, true);
  });

  it('runs turns in one conversation sequentially, other conversations in parallel', async () => {
    const { channel, agent } = setup();
    const log: string[] = [];
    agent.on('message', async (ctx) => {
      log.push(`start ${ctx.text}`);
      await sleep(ctx.text === 'slow' ? 40 : 5);
      log.push(`end ${ctx.text}`);
    });
    await agent.start();
    await channel.deliver('slow');
    await channel.deliver('next'); // same conversation: must wait for "slow"
    await channel.deliver('other', { thread: 't2' }); // different conversation: runs now
    await agent.stop();

    assert.ok(log.indexOf('end slow') < log.indexOf('start next'), log.join(', '));
    assert.ok(log.indexOf('end other') < log.indexOf('end slow'), log.join(', '));
  });

  it('ignores groups by default and when allow() rejects', async () => {
    const { channel, agent, events } = setup({ allow: (m) => m.sender.id === '+15550001' });
    let calls = 0;
    agent.on('message', () => void calls++);
    await agent.start();
    await channel.deliver('in a group', { group: true });
    await channel.deliver('stranger', { from: '+19999999' });
    await channel.deliver('friend');
    await agent.stop();

    assert.equal(calls, 1);
    const reasons = events.flatMap((e) => (e.type === 'message.filtered' ? [e.reason] : []));
    assert.deepEqual(reasons, ['group', 'not-allowed']);
  });

  it('answers groups when enabled', async () => {
    const { channel, agent } = setup({ groups: true });
    let calls = 0;
    agent.on('message', () => void calls++);
    await agent.start();
    await channel.deliver('hi all', { group: true });
    await agent.stop();
    assert.equal(calls, 1);
  });

  it('splits replies longer than the channel limit', async () => {
    const channel = new FakeChannel('short', { maxTextLength: 20, typingIndicator: false, groups: false, canInitiate: true });
    const agent = new Agent({ channels: [channel], debounceMs: 0 });
    agent.on('message', (ctx) => ctx.reply('First sentence here. Second sentence here.'));
    await agent.start();
    await channel.deliver('go');
    await agent.stop();

    assert.deepEqual(channel.sent.map((m) => m.text), ['First sentence here.', 'Second sentence', 'here.']);
    assert.ok(channel.sent.every((m) => m.text.length <= 20));
  });

  it('keeps running after a handler throws, and reports it', async () => {
    const { channel, agent, events } = setup();
    agent.on('message', (ctx) => {
      if (ctx.text === 'boom') throw new Error('boom');
      return ctx.reply('ok').then(() => {});
    });
    await agent.start();
    await channel.deliver('boom');
    await channel.deliver('fine');
    await agent.stop();

    assert.equal(events.filter((e) => e.type === 'handler.error').length, 1);
    assert.equal(channel.sent[0]?.text, 'ok');
  });

  it('stops already-started channels if a later one fails to start', async () => {
    const good = new FakeChannel('good');
    const bad = new FakeChannel('bad', undefined, true);
    const agent = new Agent({ channels: [good, bad] });
    agent.on('message', () => {});
    await assert.rejects(agent.start(), /bad failed to start/);
    assert.equal(good.stopped, true);
  });

  it('rejects bad configuration', async () => {
    assert.throws(() => new Agent({ channels: [] }), /at least one channel/);
    assert.throws(() => new Agent({ channels: [new FakeChannel('x'), new FakeChannel('x')] }), /Duplicate/);
    const agent = new Agent({ channels: [new FakeChannel()] });
    await assert.rejects(agent.start(), /Register a handler/);
  });

  it('survives a listener that throws', async () => {
    const { channel, agent } = setup();
    agent.on('event', () => {
      throw new Error('bad logger');
    });
    agent.on('message', (ctx) => ctx.reply('still here').then(() => {}));
    await agent.start();
    await channel.deliver('hi');
    await agent.stop();
    assert.equal(channel.sent[0]?.text, 'still here');
  });

  it('drops a redelivered message instead of answering twice', async () => {
    const { channel, agent, events } = setup();
    let calls = 0;
    agent.on('message', () => void calls++);
    await agent.start();
    await channel.deliver('pay my bill', { id: 'wamid.42' });
    await channel.deliver('pay my bill', { id: 'wamid.42' }); // webhook retry
    await agent.stop();

    assert.equal(calls, 1);
    assert.equal(events.filter((e) => e.type === 'message.duplicate').length, 1);
  });

  it('gives the handler conversation history, with replies stored whole', async () => {
    const channel = new FakeChannel('short', { maxTextLength: 20, typingIndicator: false, groups: false, canInitiate: true });
    const agent = new Agent({ channels: [channel], debounceMs: 0 });
    const seen: string[][] = [];
    agent.on('message', async (ctx) => {
      seen.push((await ctx.history()).map((e) => `${e.role}: ${e.text}`));
      await ctx.reply(`You said ${ctx.text}. That is a long reply.`);
    });
    await agent.start();
    await channel.deliver('one');
    await channel.deliver('two');
    await agent.stop();

    assert.ok(channel.sent.length > 2, 'replies were split for the channel');
    assert.deepEqual(seen, [
      ['user: one'],
      ['user: one', 'agent: You said one. That is a long reply.', 'user: two'],
    ]);
  });

  it('does not record filtered messages in history', async () => {
    const store = new MemoryStore();
    const channel = new FakeChannel();
    const agent = new Agent({ channels: [channel], debounceMs: 0, store, allow: (m) => m.sender.id === '+15550001' });
    agent.on('message', () => {});
    await agent.start();
    await channel.deliver('private', { from: '+19999999', thread: 'x' });
    await agent.stop();
    assert.deepEqual(await store.getHistory('fake', 'x', 10), []);
  });

  it('gives each channel its own namespaced state', async () => {
    const store = new MemoryStore();
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    const agent = new Agent({ channels: [a, b], store });
    agent.on('message', () => {});
    await agent.start();
    await a.ctx!.state.set('cursor', '10');
    await b.ctx!.state.set('cursor', '20');
    assert.equal(await a.ctx!.state.get('cursor'), '10');
    assert.equal(await store.getState('b', 'cursor'), '20');
    await agent.stop();
  });

  it('keeps answering when the store is down, and reports it', async () => {
    const broken = new MemoryStore();
    broken.markSeen = async () => {
      throw new Error('disk full');
    };
    broken.appendHistory = async () => {
      throw new Error('disk full');
    };
    const channel = new FakeChannel();
    const agent = new Agent({ channels: [channel], debounceMs: 0, store: broken });
    const events: TimedAgentEvent[] = [];
    agent.on('event', (e) => events.push(e));
    agent.on('message', (ctx) => ctx.reply('ok').then(() => {}));
    await agent.start();
    await channel.deliver('hi');
    await agent.stop();

    assert.equal(channel.sent[0]?.text, 'ok');
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'store.error' ? [e.operation] : [])),
      ['markSeen', 'appendHistory', 'appendHistory'],
    );
  });

  it('idle() waits for queued turns to finish', async () => {
    const { channel, agent } = setup();
    let done = 0;
    agent.on('message', async () => {
      await sleep(20);
      done++;
    });
    await agent.start();
    await channel.deliver('a');
    await channel.deliver('b', { thread: 't2' });
    assert.equal(done, 0, 'receive() returns before the handler runs');
    await agent.idle();
    assert.equal(done, 2);
    await agent.stop();
  });
});
