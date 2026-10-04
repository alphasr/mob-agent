import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Agent, MemoryStore, ProactiveLimitError } from '../src/index.ts';
import type {
  Channel,
  ChannelContext,
  InboundMessage,
  NewMessage,
  OutboundMessage,
  SentMessage,
  Thread,
  TimedAgentEvent,
} from '../src/index.ts';

class ProactiveChannel implements Channel {
  readonly name: string;
  readonly capabilities = { typingIndicator: false, groups: false, maxTextLength: 20 };
  readonly sent: OutboundMessage[] = [];
  readonly started: NewMessage[] = [];
  ctx: ChannelContext | undefined;
  #n = 0;
  constructor(name = 'fake') {
    this.name = name;
  }
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send(message: OutboundMessage): Promise<SentMessage> {
    this.sent.push(message);
    return { id: `out-${this.#n++}`, channel: this.name, threadId: message.thread.id };
  }
  async sendNew(message: NewMessage) {
    this.started.push(message);
    const thread: Thread = { id: `t-${message.to}`, channel: this.name, isGroup: false };
    return { sent: { id: `new-${this.#n++}`, channel: this.name, threadId: thread.id }, thread };
  }
  deliver(text: string, from: string, thread: string) {
    const m: InboundMessage = {
      id: `in-${this.#n++}`,
      channel: this.name,
      thread: { id: thread, channel: this.name, isGroup: false },
      sender: { id: from },
      text,
      attachments: [],
      timestamp: new Date(),
      raw: null,
    };
    return this.ctx!.receive(m);
  }
}

describe('agent.send', () => {
  let agent: Agent | undefined;
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function setup(options: { proactivePerMinute?: number; channel?: Channel } = {}) {
    const channel = (options.channel as ProactiveChannel | undefined) ?? new ProactiveChannel();
    const store = new MemoryStore();
    const a = new Agent({ channels: [channel], store, debounceMs: 0, ...options });
    const events: TimedAgentEvent[] = [];
    a.on('event', (e) => events.push(e));
    a.on('message', () => {});
    await a.start();
    agent = a;
    return { agent: a, channel, store, events };
  }

  it('starts a conversation, splits long text, and records it whole in history', async () => {
    const { agent, channel, store, events } = await setup();
    const sent = await agent.send({ channel: 'fake', to: '+1555', text: 'Your table is ready. Please come in.' });

    assert.equal(sent.length, 2);
    assert.deepEqual(channel.started, [{ to: '+1555', text: 'Your table is ready.' }]);
    assert.deepEqual(
      channel.sent.map((m) => [m.thread.id, m.text, m.to]),
      [['t-+1555', 'Please come in.', '+1555']],
    );
    const history = await store.getHistory('fake', 't-+1555', 10);
    assert.deepEqual(
      history.map((h) => [h.role, h.text]),
      [['agent', 'Your table is ready. Please come in.']],
    );
    const sentEvents = events.flatMap((e) => (e.type === 'message.sent' ? [[e.part, e.parts, e.proactive]] : []));
    assert.deepEqual(sentEvents, [
      [1, 2, true],
      [2, 2, true],
    ]);
  });

  it('continues a thread, addressed to whoever wrote last', async () => {
    const { agent, channel, store } = await setup();
    await channel.deliver('remind me at 3', 'ada', 'thread-1');
    await agent.idle();
    await agent.send({ thread: { id: 'thread-1', channel: 'fake', isGroup: false }, text: 'Reminder: 3pm' });

    assert.equal(channel.sent.at(-1)?.to, 'ada');
    assert.equal(channel.sent.at(-1)?.replyTo, undefined, 'proactive, not a reply');
    const history = await store.getHistory('fake', 'thread-1', 10);
    assert.deepEqual(
      history.map((h) => h.role),
      ['user', 'agent'],
    );
  });

  it('records template sends in history as a readable placeholder', async () => {
    const { agent, channel, store } = await setup();
    await agent.send({
      channel: 'fake',
      to: '447700',
      template: { name: 'reminder', language: 'en_US', params: ['Tue 3pm'] },
    });
    assert.deepEqual(channel.started[0]?.template, { name: 'reminder', language: 'en_US', params: ['Tue 3pm'] });
    assert.equal((await store.getHistory('fake', 't-447700', 1))[0]?.text, '[template reminder: Tue 3pm]');
  });

  it('rate-limits proactive messages per channel', async () => {
    const { agent } = await setup({ proactivePerMinute: 3 });
    await agent.send({ channel: 'fake', to: 'a', text: 'one' });
    await agent.send({ channel: 'fake', to: 'b', text: 'two' });
    await assert.rejects(
      agent.send({ channel: 'fake', to: 'c', text: 'this one is long and splits in two' }),
      ProactiveLimitError,
    );
    await agent.send({ channel: 'fake', to: 'd', text: 'three' });
    await assert.rejects(agent.send({ channel: 'fake', to: 'e', text: 'four' }), /3 proactive messages per minute/);
  });

  it('explains unusable requests', async () => {
    const { agent } = await setup();
    await assert.rejects(agent.send({ channel: 'nope', to: 'x', text: 'hi' }), /No channel named "nope"/);
    await assert.rejects(agent.send({ channel: 'fake', to: 'x', text: '   ' }), /pass text or a template/);

    const plain: Channel = {
      name: 'plain',
      capabilities: { typingIndicator: false, groups: false },
      start: async () => {},
      stop: async () => {},
      send: async (m) => ({ id: 'x', channel: 'plain', threadId: m.thread.id }),
    };
    const other = new Agent({ channels: [plain], store: new MemoryStore() });
    other.on('message', () => {});
    await assert.rejects(other.send({ channel: 'plain', to: 'x', text: 'hi' }), /Start the agent/);
    await other.start();
    await assert.rejects(other.send({ channel: 'plain', to: 'x', text: 'hi' }), /can't start conversations/);
    await other.stop();
  });
});
