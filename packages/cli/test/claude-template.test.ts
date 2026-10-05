import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@textagent/core';
import type { Channel, ChannelContext, HistoryEntry, MessageContext, TimedAgentEvent } from '@textagent/core';
import { MODEL, reply } from '../templates/claude.ts';
import type { ClaudeClient, Tool } from '../templates/claude.ts';

type Request = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Block = Anthropic.Beta.BetaContentBlock;

/** A fake client answering with `responses` in turn and keeping a copy of every request. */
function fakeClient(responses: Array<Partial<Anthropic.Beta.BetaMessage>>) {
  const requests: Request[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        create: (async (body: Request) => {
          requests.push(structuredClone(body));
          const next = responses.shift();
          if (!next) throw new Error('no more responses');
          return {
            model: MODEL,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 0,
            },
            ...next,
          };
        }) as unknown as ClaudeClient['beta']['messages']['create'], // the fake implements only what reply() calls
      },
    },
  };
  return { client, requests };
}

const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown): Block =>
  ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }) as unknown as Block;

interface SpanLog {
  name: string;
  attributes: Record<string, unknown>;
  usage: unknown[];
}

/** Just enough of MessageContext for reply(): history and a recording tracer. */
function fakeContext(history: Array<Pick<HistoryEntry, 'role' | 'text'>>) {
  const spans: SpanLog[] = [];
  const ctx = {
    history: async () => history,
    trace: {
      span: async (name: string, attributes: Record<string, unknown>, fn: (span: unknown) => unknown) => {
        const log: SpanLog = { name, attributes: { ...attributes }, usage: [] };
        spans.push(log);
        return fn({
          setAttributes: (more: Record<string, unknown>) => Object.assign(log.attributes, more),
          usage: (u: unknown) => log.usage.push(u),
        });
      },
    },
  } as unknown as MessageContext; // reply() only uses history and trace.span
  return { ctx, spans };
}

const echoTool = (name: string, run: Tool['run']): Tool => ({
  name,
  description: `the ${name} tool`,
  input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
  run,
});

describe('reply', () => {
  it('sends the conversation with cached instructions, low effort and the refusal fallback', async () => {
    const { client, requests } = fakeClient([{ content: [text('Hi Ada!')] }]);
    const { ctx, spans } = fakeContext([{ role: 'user', text: 'hello' }]);
    assert.equal(await reply(client, ctx, { system: 'Be kind.' }), 'Hi Ada!');

    const [request] = requests;
    assert.equal(request!.model, 'claude-opus-5-5');
    assert.deepEqual(request!.system, [{ type: 'text', text: 'Be kind.', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(request!.output_config, { effort: 'low' });
    assert.deepEqual(request!.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(request!.fallbacks, 'default');
    assert.equal('tools' in request!, false, 'no tools key without tools');
    assert.deepEqual(request!.messages, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(spans[0]!.usage, [
      { model: MODEL, inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 },
    ]);
  });

  it('runs tools Claude asks for and returns every result in one message, history appended unchanged', async () => {
    const assistantTurn = [
      text('Let me check.'),
      toolUse('t1', 'lookup', { q: 'a' }),
      toolUse('t2', 'lookup', { q: 'b' }),
    ];
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: assistantTurn },
      { content: [text('Both found.')] },
    ]);
    const seen: unknown[] = [];
    const tool = echoTool('lookup', (input) => {
      seen.push(input);
      return `result for ${String(input.q)}`;
    });
    const { ctx, spans } = fakeContext([{ role: 'user', text: 'find a and b' }]);

    assert.equal(await reply(client, ctx, { system: 's', tools: [tool] }), 'Both found.');
    assert.deepEqual(seen, [{ q: 'a' }, { q: 'b' }]);
    assert.deepEqual(requests[0]!.tools, [
      { name: 'lookup', description: 'the lookup tool', input_schema: tool.input_schema, strict: true },
    ]);
    const second = requests[1]!.messages;
    assert.equal(second.length, 3);
    assert.deepEqual(second[1], { role: 'assistant', content: assistantTurn });
    assert.deepEqual(second[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'result for a' },
        { type: 'tool_result', tool_use_id: 't2', content: 'result for b' },
      ],
    });
    assert.deepEqual(
      spans.map((s) => s.name),
      ['claude', 'tool:lookup', 'tool:lookup', 'claude'],
    );
    assert.ok(!JSON.stringify(spans).includes('result for'), 'tool inputs and results stay out of traces');
  });

  it('reports a failing or unknown tool to Claude as an error instead of crashing the turn', async () => {
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [toolUse('t1', 'broken', { q: 'x' }), toolUse('t2', 'missing', { q: 'y' })] },
      { content: [text('Sorry, that failed.')] },
    ]);
    const broken = echoTool('broken', () => {
      throw new Error('calendar is down');
    });
    const { ctx, spans } = fakeContext([{ role: 'user', text: 'book it' }]);

    assert.equal(await reply(client, ctx, { system: 's', tools: [broken] }), 'Sorry, that failed.');
    assert.deepEqual(requests[1]!.messages[2]!.content, [
      { type: 'tool_result', tool_use_id: 't1', content: 'calendar is down', is_error: true },
      { type: 'tool_result', tool_use_id: 't2', content: 'There is no tool named missing', is_error: true },
    ]);
    assert.deepEqual(
      spans.filter((s) => s.name.startsWith('tool:')).map((s) => s.attributes),
      [{ failed: true }, { failed: true }],
    );
  });

  it('apologises on a refusal and gives up after maxSteps', async () => {
    const refused = fakeClient([{ stop_reason: 'refusal', content: [] }]);
    const { ctx } = fakeContext([{ role: 'user', text: 'x' }]);
    assert.equal(await reply(refused.client, ctx, { system: 's' }), "Sorry, I can't help with that.");

    const looping = fakeClient(
      Array.from({ length: 3 }, (_, i) => ({
        stop_reason: 'tool_use' as const,
        content: [toolUse(`t${i}`, 'again', { q: '' })],
      })),
    );
    const again = echoTool('again', () => 'once more');
    const answer = await reply(looping.client, fakeContext([{ role: 'user', text: 'x' }]).ctx, {
      system: 's',
      tools: [again],
      maxSteps: 3,
    });
    assert.match(answer!, /too long/);
    assert.equal(looping.requests.length, 3);
  });

  it('starts the conversation at the first user message, and returns nothing for an empty answer', async () => {
    const { client, requests } = fakeClient([{ content: [] }]);
    const { ctx } = fakeContext([
      { role: 'agent', text: 'Reminder: your booking is tomorrow' },
      { role: 'user', text: '' },
    ]);
    assert.equal(await reply(client, ctx, { system: 's' }), undefined);
    assert.deepEqual(requests[0]!.messages, [{ role: 'user', content: '(sent an attachment)' }]);
  });
});

describe('reply inside a real agent turn', () => {
  let agent: Agent | undefined;
  afterEach(async () => agent?.stop());

  it('puts the model call and its token cost into the turn trace', async () => {
    const channel = new FakeChannel();
    agent = new Agent({ channels: [channel], debounceMs: 0 });
    const { client } = fakeClient([{ content: [text('Hello!')] }]);
    const events: TimedAgentEvent[] = [];
    agent.on('event', (e) => events.push(e));
    agent.on('message', async (ctx) => {
      const answer = await reply(client, ctx, { system: 's' });
      if (answer) await ctx.reply(answer);
    });
    await agent.start();
    await channel.ctx!.receive({
      id: 'm1',
      channel: 'fake',
      thread: { id: 't', channel: 'fake', isGroup: false },
      sender: { id: 'ada' },
      text: 'hi',
      attachments: [],
      timestamp: new Date(),
      raw: {},
    });
    await agent.idle();

    const turn = events.find((e) => e.type === 'turn.completed');
    assert.ok(turn?.type === 'turn.completed');
    assert.equal(turn.trace.spans[0]!.name, 'claude');
    assert.deepEqual(turn.trace.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    });
    // 100 × $4 + 20 × $20 + 80 × $0.20 per million tokens
    assert.ok(Math.abs(turn.trace.costUsd - 0.000816) < 1e-12, String(turn.trace.costUsd));
    assert.deepEqual(channel.sent, ['Hello!']);
  });
});

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  ctx: ChannelContext | undefined;
  sent: string[] = [];
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send(m: { thread: { id: string }; text: string }) {
    this.sent.push(m.text);
    return { id: `o${this.sent.length}`, channel: this.name, threadId: m.thread.id };
  }
}
