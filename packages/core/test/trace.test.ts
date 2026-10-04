import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { Agent, MemoryStore, SqliteStore, eventToJson, splitText } from '../src/index.ts';
import type {
  AgentOptions,
  Channel,
  ChannelContext,
  InboundMessage,
  MessageHandler,
  TimedAgentEvent,
  TurnTrace,
} from '../src/index.ts';
import { TurnTracer } from '../src/trace.ts';

class EchoChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false, maxTextLength: 10 };
  ctx: ChannelContext | undefined;
  #n = 0;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send(m: { thread: { id: string } }) {
    return { id: `o${this.#n++}`, channel: this.name, threadId: m.thread.id };
  }
  deliver(text: string, thread = 't1') {
    const m: InboundMessage = {
      id: `i${this.#n++}`,
      channel: this.name,
      thread: { id: thread, channel: this.name, isGroup: false },
      sender: { id: 'ada' },
      text,
      attachments: [],
      timestamp: new Date(),
      raw: { secret: 'channel payload' },
    };
    return this.ctx!.receive(m);
  }
}

describe('turn traces', () => {
  let agent: Agent | undefined;
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function run(handler: MessageHandler, options: Partial<AgentOptions> = {}, text = 'hello') {
    const channel = new EchoChannel();
    const store = (options.store as MemoryStore | undefined) ?? new MemoryStore();
    agent = new Agent({ channels: [channel], debounceMs: 0, store, ...options });
    const events: TimedAgentEvent[] = [];
    agent.on('event', (e) => events.push(e));
    agent.on('message', handler);
    await agent.start();
    await channel.deliver(text);
    await agent.idle();
    const traces = events.flatMap((e) => (e.type === 'turn.completed' ? [e.trace] : []));
    return { traces, events, store, trace: traces[0]! };
  }

  it('records spans with timing, nesting, usage and cost, and counts sent messages', async () => {
    const { trace } = await run(async (ctx) => {
      await ctx.trace.span('llm', { model: 'claude-opus-5-5' }, async (span) => {
        await sleep(20);
        span.usage({ model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 });
        await ctx.trace.span('tool:lookup_order', { orderId: 'A1' }, () => sleep(5));
      });
      await ctx.reply('a reply long enough to split');
    });

    assert.equal(trace.conversation.startsWith('fake'), true);
    assert.equal(trace.threadId, 't1');
    assert.equal(trace.sentCount, splitText('a reply long enough to split', 10).length, 'split parts count separately');
    const [llm, tool] = trace.spans;
    assert.equal(llm?.name, 'llm');
    assert.ok(llm!.durationMs >= 20);
    assert.equal(tool?.parent, llm?.id, 'nested automatically');
    assert.deepEqual(tool?.attributes, { orderId: 'A1' });
    assert.deepEqual(trace.usage, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 });
    // 1000 × $4 + 500 × $20 + 2000 × $0.20, per million tokens
    assert.equal(trace.costUsd.toFixed(6), '0.014400');
  });

  it('records errors, closes unfinished spans, and still emits when the handler throws', async () => {
    const { trace } = await run(async (ctx) => {
      ctx.trace.start('left-open');
      await ctx.trace.span('tool:charge', {}, () => {
        throw new Error('card declined');
      });
    });
    assert.equal(trace.error, 'card declined');
    assert.deepEqual(
      trace.spans.map((s) => [s.name, s.error, s.unfinished]),
      [
        ['left-open', undefined, true],
        ['tool:charge', 'card declined', undefined],
      ],
    );
  });

  it('caps spans and attribute size, and reports unpriced models', async () => {
    const { trace } = await run(async (ctx) => {
      for (let i = 0; i < 60; i++) await ctx.trace.span(`step ${i}`, {}, () => {});
      ctx.trace.usage({ model: 'some-other-model', inputTokens: 10, outputTokens: 10 });
    });
    assert.equal(trace.spans.length, 50);
    assert.equal(trace.droppedSpans, 10);
    assert.deepEqual(trace.unpricedModels, ['some-other-model']);
    assert.equal(trace.costUsd, 0);

    const tracer = new TurnTracer();
    tracer.start('big', { result: '😀'.repeat(5000) });
    const [span] = tracer.finish(
      { conversation: 'c', channel: 'x', threadId: 't', messageIds: [], sentCount: 0 },
      {},
    ).spans;
    assert.equal(span?.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(span?.attributes)) <= 2048);
  });

  it('applies custom prices', async () => {
    const { trace } = await run(
      async (ctx) => ctx.trace.usage({ model: 'my-model', inputTokens: 1_000_000, outputTokens: 0 }),
      { prices: { 'my-model': { input: 3, output: 15 } } },
    );
    assert.equal(trace.costUsd, 3);
  });

  it('keeps traces in the store, newest first, and prunes by age and count', async () => {
    const store = new SqliteStore(':memory:');
    const { trace } = await run(async (ctx) => void (await ctx.trace.span('x', {}, () => {})), { store });
    const [saved] = await store.listTraces();
    assert.equal(saved?.id, trace.id);
    assert.ok(saved?.startedAt instanceof Date);

    const make = (id: string, minutesAgo: number): TurnTrace => ({
      ...trace,
      id,
      startedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await store.addTrace(make('old', 60 * 24 * 10));
    await store.addTrace(make('a', 3));
    await store.addTrace(make('b', 2));
    assert.equal(
      await store.pruneTraces(new Date(Date.now() - 7 * 86_400_000), 2),
      2,
      'one too old, one over the count',
    );
    assert.deepEqual(
      (await store.listTraces()).map((t) => t.id),
      [trace.id, 'b'],
    );
  });

  it('can turn trace storage off', async () => {
    const { store } = await run(async () => {}, { traceRetention: false });
    assert.deepEqual(await store.listTraces(), []);
  });
});

describe('JSON logs', () => {
  it('writes parseable lines without stacks or channel payloads, and can blank text', () => {
    const at = new Date('2026-10-05T12:00:00Z');
    const message: InboundMessage = {
      id: 'i1',
      channel: 'fake',
      thread: { id: 't', channel: 'fake', isGroup: false },
      sender: { id: 'ada' },
      text: 'my card number is 4111',
      attachments: [],
      timestamp: at,
      raw: { secret: 'payload' },
    };
    const received = JSON.parse(eventToJson({ type: 'message.received', message, at }));
    assert.equal(received.type, 'message.received');
    assert.equal(received.at, '2026-10-05T12:00:00.000Z');
    assert.equal(received.message.raw, undefined);
    assert.equal(received.message.text, 'my card number is 4111');

    const private_ = JSON.parse(eventToJson({ type: 'message.received', message, at }, false));
    assert.equal(private_.message.text, '');

    const failed = JSON.parse(eventToJson({ type: 'channel.error', channel: 'x', error: new TypeError('boom'), at }));
    assert.deepEqual(failed.error, { name: 'TypeError', message: 'boom' });
  });
});
