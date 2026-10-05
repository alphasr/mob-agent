import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Agent } from '@textagent/core';
import type { Channel, ChannelContext, InboundMessage, TimedAgentEvent } from '@textagent/core';
import { MAX_MESSAGES_PER_BATCH, hasher, parseBatch, redactMessage, redactTrace } from '../src/index.ts';
import type { ExportedMessage, ExportedTrace, IngestBatch } from '../src/index.ts';

const hash = hasher('z'.repeat(32));
const NOW = new Date('2026-10-05T12:00:00Z');

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  ctx: ChannelContext | undefined;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send() {
    return { id: 'out-1', channel: this.name, threadId: '+15551234567' };
  }
}

let agent: Agent | undefined;
afterEach(async () => {
  await agent?.stop();
  agent = undefined;
});

/** A batch exactly as the exporter would build it from one real turn. */
async function exportedBatch(): Promise<IngestBatch> {
  const channel = new FakeChannel();
  agent = new Agent({ channels: [channel], debounceMs: 0 });
  const events: TimedAgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  agent.on('message', async (ctx) => {
    // Quotes and backslashes make core's 2 KB truncation marker grow when re-escaped.
    await ctx.trace.span('tool', { result: '"\\'.repeat(5_000) }, async (span) => {
      span.usage({ model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
    });
    await ctx.trace.span('failing', {}, () => Promise.reject(new Error('tool broke'))).catch(() => {});
    await ctx.reply('hi');
  });
  await agent.start();
  const message: InboundMessage = {
    id: 'in-1',
    channel: 'fake',
    thread: { id: '+15551234567', channel: 'fake', isGroup: false },
    sender: { id: '+15551234567' },
    text: 'hello',
    attachments: [],
    timestamp: new Date(),
    raw: {},
  };
  await channel.ctx!.receive(message);
  await agent.idle();

  const turn = events.find((e) => e.type === 'turn.completed');
  assert.ok(turn?.type === 'turn.completed');
  return {
    version: 1,
    traces: [redactTrace(turn.trace, hash, true)],
    messages: events.flatMap((e) => redactMessage(e, hash) ?? []),
  };
}

function trace(overrides: Partial<Record<keyof ExportedTrace, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'turn-1',
    conversation: hash('c'),
    channel: 'telegram',
    threadId: hash('t'),
    startedAt: '2026-10-05T11:59:00.000Z',
    durationMs: 12.5,
    messageIds: [hash('m')],
    sentCount: 1,
    spans: [],
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.01,
    ...overrides,
  };
}

function message(overrides: Partial<Record<keyof ExportedMessage, unknown>> = {}): Record<string, unknown> {
  return {
    direction: 'in',
    id: hash('m'),
    channel: 'telegram',
    threadId: hash('t'),
    senderId: hash('s'),
    text: 'hello',
    at: '2026-10-05T11:59:00.000Z',
    ...overrides,
  };
}

const parse = (body: unknown) => parseBatch(body, NOW);

describe('parseBatch', () => {
  it('accepts what the exporter sends, unchanged', async () => {
    const batch = await exportedBatch();
    const wire = JSON.parse(JSON.stringify(batch)) as unknown;
    const spans = batch.traces[0]!.spans;
    assert.equal(spans[0]!.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(spans[0]!.attributes)) > 2048, 'marker grew past 2 KB');
    assert.equal(spans[1]!.error, 'tool broke');
    assert.deepEqual(parseBatch(wire), wire);
  });

  it('rejects ids that are not hashes, so raw phone numbers and emails are never stored', () => {
    assert.equal(
      parse({ version: 1, traces: [trace({ conversation: '+15551234567' })] }),
      'traces[0].conversation must be a hashed id (43 base64url characters)',
    );
    assert.match(
      parse({ version: 1, traces: [trace({ messageIds: ['ada@example.com'] })] }) as string,
      /messageIds\[0\]/,
    );
    assert.match(
      parse({ version: 1, traces: [], messages: [message({ senderId: 'ada@example.com' })] }) as string,
      /senderId/,
    );
  });

  it('drops unknown fields at every level', () => {
    const result = parse({
      version: 1,
      extra: 1,
      traces: [trace({ spans: [{ id: 's1', name: 'x', startMs: 0, durationMs: 1, attributes: {}, phone: 'p' }] })],
      messages: [message({ senderName: 'Ada' } as never)],
    });
    assert.ok(typeof result === 'object');
    assert.ok(!('extra' in result));
    assert.ok(!('phone' in result.traces[0]!.spans[0]!));
    assert.ok(!('senderName' in result.messages![0]!));
  });

  it('enforces the protocol version and shapes', () => {
    assert.match(parse({ version: 2, traces: [] }) as string, /unsupported version 2/);
    assert.equal(parse([]), 'body must be an object');
    assert.equal(parse({ version: 1 }), 'traces must be an array');
    assert.match(
      parse({ version: 1, traces: [trace({ sentCount: -1 })] }) as string,
      /sentCount must be a whole number from 0 to 2147483647/,
    );
    const usage = { inputTokens: 2 ** 31, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.match(
      parse({ version: 1, traces: [trace({ usage })] }) as string,
      /usage\.inputTokens must be a whole number/,
    );
    assert.match(parse({ version: 1, traces: [trace({ costUsd: Infinity })] }) as string, /costUsd must be a number/);
    assert.match(
      parse({ version: 1, traces: [], messages: [message({ direction: 'sideways' })] }) as string,
      /direction/,
    );
    assert.match(parse({ version: 1, traces: [trace({ channel: 'tele gram' })] }) as string, /channel name/);
    assert.match(parse({ version: 1, traces: [trace({ startedAt: 'yesterday' })] }) as string, /ISO 8601/);
  });

  it('enforces size limits', () => {
    assert.match(
      parse({ version: 1, traces: Array.from({ length: 51 }, () => trace()) }) as string,
      /51 entries; the limit is 50/,
    );
    const span = { id: 's', name: 'x', startMs: 0, durationMs: 0, attributes: { big: 'x'.repeat(9_000) } };
    assert.match(parse({ version: 1, traces: [trace({ spans: [span] })] }) as string, /attributes is over 8192 bytes/);
    const messages = Array.from({ length: MAX_MESSAGES_PER_BATCH }, () => message());
    assert.equal(typeof parse({ version: 1, traces: [], messages }), 'object');
    assert.match(parse({ version: 1, traces: [], messages: [...messages, message()] }) as string, /limit is 1000/);
  });

  it('rejects timestamps more than 5 minutes ahead (a wrong clock) but accepts old ones (buffered in an outage)', () => {
    assert.match(
      parse({ version: 1, traces: [trace({ startedAt: '2026-10-05T12:06:00Z' })] }) as string,
      /in the future/,
    );
    const ok = parse({ version: 1, traces: [trace({ startedAt: '2026-10-05T12:04:00+00:00' })] });
    assert.ok(typeof ok === 'object');
    assert.equal(ok.traces[0]!.startedAt, '2026-10-05T12:04:00.000Z', 'normalized to UTC ISO');
    assert.equal(typeof parse({ version: 1, traces: [trace({ startedAt: '2025-01-01T00:00:00Z' })] }), 'object');
  });

  it('cuts long text without splitting a character and removes NULs Postgres cannot store', () => {
    const long = `${'a'.repeat(65_535)}😀tail`;
    const result = parse({
      version: 1,
      traces: [
        trace({
          error: 'bad\u0000news',
          spans: [{ id: 's', name: 'n', startMs: 0, durationMs: 0, attributes: { 'k\u0000': ['v\u0000'] } }],
        }),
      ],
      messages: [message({ text: long })],
    });
    assert.ok(typeof result === 'object');
    assert.equal(result.messages![0]!.text, 'a'.repeat(65_535), 'the emoji would be split, so it is dropped whole');
    assert.equal(result.traces[0]!.error, 'badnews');
    assert.deepEqual(result.traces[0]!.spans[0]!.attributes, { k: ['v'] });
  });
});
