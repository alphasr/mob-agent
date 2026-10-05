import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@textagent/core';
import type { Channel, ChannelContext, InboundMessage, MessageContext, NewMessage } from '@textagent/core';
import { reply } from '../templates/claude.ts';
import type { ClaudeClient } from '../templates/claude.ts';
import { Handoffs, PAUSE_MS, conversationOf, handoffTool } from '../templates/support.ts';

const tmp = mkdtempSync(join(tmpdir(), 'textagent-support-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dbPath = () => join(tmp, `support-${n++}.sqlite`);

describe('Handoffs', () => {
  it('pauses a conversation for 24 hours, survives a restart, and can be resumed early', () => {
    const path = dbPath();
    const now = Date.parse('2026-10-05T12:00:00Z');
    const first = new Handoffs(path);
    first.pause('telegram:42', now);
    assert.equal(first.isPaused('telegram:42', now + PAUSE_MS - 1), true);
    assert.equal(first.isPaused('telegram:42', now + PAUSE_MS), false);
    assert.equal(first.isPaused('telegram:43', now), false);
    first.close();

    const restarted = new Handoffs(path);
    assert.equal(restarted.isPaused('telegram:42', now + 1), true, 'kept across a restart');
    restarted.resume('telegram:42');
    assert.equal(restarted.isPaused('telegram:42', now + 1), false);
    restarted.close();
  });
});

describe('handoffTool', () => {
  const ctx = {
    channel: { name: 'telegram' },
    thread: { id: '42', channel: 'telegram', isGroup: false },
    sender: { id: '42', name: 'Ada' },
  } as unknown as MessageContext; // the tool reads only channel, thread and sender

  it('sends the summary to the operator from .env and pauses the conversation', async () => {
    const sent: unknown[] = [];
    const handoffs = new Handoffs(dbPath());
    const tool = handoffTool(
      { send: async (r) => (sent.push(r), []) },
      ctx,
      { channel: 'email', to: 'ops@example.com' },
      handoffs,
    );
    const result = await tool.run({ summary: 'Wants a refund for order 17.' });

    assert.deepEqual(sent, [
      {
        channel: 'email',
        to: 'ops@example.com',
        text: 'Handoff from telegram Ada (42):\nWants a refund for order 17.',
      },
    ]);
    assert.match(result, /team member/);
    assert.equal(handoffs.isPaused(conversationOf(ctx)), true);
    handoffs.close();
  });

  it('only lets Claude choose the summary, never the recipient', () => {
    const tool = handoffTool(
      { send: async () => [] },
      ctx,
      { channel: 'email', to: 'ops@example.com' },
      new Handoffs(dbPath()),
    );
    assert.deepEqual(Object.keys(tool.input_schema.properties as object), ['summary']);
    assert.equal(tool.input_schema.additionalProperties, false);
  });
});

describe('support agent', () => {
  let agent: Agent | undefined;
  afterEach(async () => agent?.stop());

  it('hands over, tells the customer, then stays quiet in that conversation only', async () => {
    const channel = new FakeChannel();
    agent = new Agent({ channels: [channel], debounceMs: 0 });
    const handoffs = new Handoffs(dbPath());
    const operator = { channel: 'fake', to: 'operator-1' };
    const responses: Array<Partial<Anthropic.Beta.BetaMessage>> = [
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'h1', name: 'handoff_to_human', input: { summary: 'Asks for a refund.' } },
        ] as unknown as Anthropic.Beta.BetaContentBlock[],
      },
      {
        content: [
          { type: 'text', text: 'A person from our team will text you shortly.' },
        ] as Anthropic.Beta.BetaContentBlock[],
      },
      { content: [{ type: 'text', text: 'We open at 8.' }] as Anthropic.Beta.BetaContentBlock[] },
    ];
    let calls = 0;
    const claude = {
      beta: {
        messages: {
          create: (async () => {
            calls++;
            return {
              model: 'claude-opus-5-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
              ...responses.shift(),
            };
          }) as unknown as ClaudeClient['beta']['messages']['create'], // a fake: only what reply() calls
        },
      },
    };
    // The handler generated for --template support, minus the knowledge base.
    agent.on('message', async (ctx) => {
      if (handoffs.isPaused(conversationOf(ctx))) return;
      const text = await reply(claude, ctx, { system: 's', tools: [handoffTool(agent!, ctx, operator, handoffs)] });
      if (text) await ctx.reply(text);
    });
    await agent.start();

    await channel.deliver('ada', 'I want my money back');
    await agent.idle();
    assert.deepEqual(channel.sentNew, [{ to: 'operator-1', text: 'Handoff from fake ada:\nAsks for a refund.' }]);
    assert.deepEqual(channel.replies, [{ to: 'ada', text: 'A person from our team will text you shortly.' }]);

    await channel.deliver('ada', 'hello? anyone?');
    await agent.idle();
    assert.equal(calls, 2, 'no model call while a person has the conversation');
    assert.equal(channel.replies.length, 1);

    await channel.deliver('bob', 'when do you open?');
    await agent.idle();
    assert.deepEqual(channel.replies.at(-1), { to: 'bob', text: 'We open at 8.' }, 'other customers still get answers');
    handoffs.close();
  });
});

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  ctx: ChannelContext | undefined;
  replies: Array<{ to: string; text: string }> = [];
  sentNew: Array<{ to: string; text: string }> = [];
  #n = 0;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send(m: { thread: { id: string }; text: string }) {
    this.replies.push({ to: m.thread.id, text: m.text });
    return { id: `o${this.#n++}`, channel: this.name, threadId: m.thread.id };
  }
  async sendNew(m: NewMessage) {
    this.sentNew.push({ to: m.to, text: m.text ?? '' });
    return { id: `o${this.#n++}`, channel: this.name, threadId: m.to };
  }
  deliver(sender: string, text: string) {
    const message: InboundMessage = {
      id: `i${this.#n++}`,
      channel: this.name,
      thread: { id: sender, channel: this.name, isGroup: false },
      sender: { id: sender },
      text,
      attachments: [],
      timestamp: new Date(),
      raw: {},
    };
    return this.ctx!.receive(message);
  }
}
