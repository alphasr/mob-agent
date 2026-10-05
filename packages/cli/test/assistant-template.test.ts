import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@textagent/core';
import type { Channel, ChannelContext, InboundMessage, MessageContext } from '@textagent/core';
import { MAX_NOTE_LENGTH, Notes, assistantTools } from '../templates/assistant.ts';
import { reply } from '../templates/claude.ts';
import type { ClaudeClient, Tool } from '../templates/claude.ts';
import { describeNow, formatTime } from '../templates/time.ts';

const tmp = mkdtempSync(join(tmpdir(), 'textagent-assistant-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dbPath = () => join(tmp, `assistant-${n++}.sqlite`);
const HOUR = 60 * 60_000;
/** A whole minute `hours` from now, as the tools read and write it. */
const inHours = (hours: number) => formatTime(Math.ceil(Date.now() / 60_000) * 60_000 + hours * HOUR, 'UTC');

describe('Notes', () => {
  it('finds notes containing every word, in any case, newest first', () => {
    const notes = new Notes(dbPath());
    notes.add('telegram:1', 'Wifi password is hunter2');
    notes.add('telegram:1', 'Dentist is Dr Lee, 020 7946 0000');
    notes.add('telegram:1', 'Spare key is with the neighbours (wifi box is in the hall)');
    assert.deepEqual(
      notes.search('telegram:1', 'WIFI').map((x) => x.text),
      ['Spare key is with the neighbours (wifi box is in the hall)', 'Wifi password is hunter2'],
    );
    assert.deepEqual(
      notes.search('telegram:1', 'hunter2 WIFI').map((x) => x.id),
      [1],
    );
    assert.equal(notes.search('telegram:1', '').length, 3, 'empty query lists the newest');
    assert.equal(notes.search('telegram:1', '', 2).length, 2);
    notes.close();
  });

  it('treats % and _ in a query as text, not wildcards', () => {
    const notes = new Notes(dbPath());
    notes.add('telegram:1', 'Rent goes up 5% in May');
    notes.add('telegram:1', 'Nothing to see');
    assert.equal(notes.search('telegram:1', '%').length, 1);
    assert.equal(notes.search('telegram:1', '_').length, 0);
    notes.close();
  });

  it('keeps each sender to their own notes', () => {
    const notes = new Notes(dbPath());
    const mine = notes.add('telegram:1', 'mine');
    notes.add('telegram:2', 'theirs');
    assert.deepEqual(
      notes.search('telegram:1', '').map((x) => x.text),
      ['mine'],
    );
    assert.equal(notes.search('email:1', '').length, 0, 'the same id on another channel is someone else');
    assert.equal(notes.delete('telegram:2', mine.id), false, "can't delete someone else's note");
    assert.equal(notes.delete('telegram:1', mine.id), true);
    assert.equal(notes.search('telegram:1', '').length, 0);
    notes.close();
  });

  it('refuses empty and oversized notes', () => {
    const notes = new Notes(dbPath());
    assert.throws(() => notes.add('telegram:1', '   '), /empty/);
    assert.throws(() => notes.add('telegram:1', 'x'.repeat(MAX_NOTE_LENGTH + 1)), /at most/);
    assert.equal(notes.add('telegram:1', ` ${'x'.repeat(MAX_NOTE_LENGTH)} `).text.length, MAX_NOTE_LENGTH);
    notes.close();
  });
});

describe('assistantTools', () => {
  let agent: Agent | undefined;
  afterEach(async () => agent?.stop());

  const ctxFor = (sender: string) =>
    ({
      channel: { name: 'fake' },
      thread: { id: sender, channel: 'fake', isGroup: false },
      sender: { id: sender },
    }) as unknown as MessageContext; // the tools read only channel, thread and sender
  const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!;

  async function setup() {
    agent = new Agent({ channels: [new FakeChannel()] });
    agent.on('message', () => {}); // the tools are called directly here
    await agent.start();
    const notes = new Notes(dbPath());
    return { notes, owner: assistantTools(agent, ctxFor('owner'), notes, 'UTC') };
  }

  it('saves, searches and deletes notes for the sender', async () => {
    const { notes, owner } = await setup();
    assert.equal(await tool(owner, 'save_note').run({ text: 'Bin day is Tuesday' }), 'Saved as #1.');
    assert.match(String(await tool(owner, 'search_notes').run({ query: 'bin' })), /^#1 \(\d{4}-\d\d-\d\d\): Bin day/);
    assert.equal(await tool(owner, 'delete_note').run({ id: 1 }), 'Deleted #1.');
    await assert.rejects(async () => tool(owner, 'delete_note').run({ id: 1 }), /no note #1/);
    assert.equal(await tool(owner, 'search_notes').run({ query: '' }), 'No matching notes.');
    notes.close();
  });

  it('schedules a reminder back to this conversation, at the local time given', async () => {
    const { notes, owner } = await setup();
    const at = inHours(2);
    assert.equal(await tool(owner, 'set_reminder').run({ at, text: 'call the bank' }), `Set for ${at}.`);
    const [job] = await agent!.listScheduled({ status: 'pending' });
    assert.equal(formatTime(job!.at.getTime(), 'UTC'), at);
    assert.deepEqual(job!.request, {
      thread: { id: 'owner', channel: 'fake', isGroup: false },
      to: 'owner',
      text: 'Reminder: call the bank',
    });
    assert.match(
      String(await tool(owner, 'list_reminders').run({})),
      new RegExp(`^${job!.id}: ${at}, "Reminder: call the bank"$`),
    );
    notes.close();
  });

  it('rejects times that have passed, malformed times and empty text', async () => {
    const { notes, owner } = await setup();
    const set = tool(owner, 'set_reminder');
    await assert.rejects(async () => set.run({ at: inHours(-1), text: 'x' }), /already passed/);
    await assert.rejects(async () => set.run({ at: 'friday at 9', text: 'x' }), /not a time/);
    await assert.rejects(async () => set.run({ at: inHours(2), text: '  ' }), /1 to 500 characters/);
    assert.deepEqual(await agent!.listScheduled(), []);
    notes.close();
  });

  it("cancels only this conversation's reminders", async () => {
    const { notes, owner } = await setup();
    const other = assistantTools(agent!, ctxFor('someone-else'), notes, 'UTC');
    await tool(other, 'set_reminder').run({ at: inHours(3), text: 'theirs' });
    const [theirs] = await agent!.listScheduled({ status: 'pending' });

    assert.equal(await tool(owner, 'list_reminders').run({}), 'No reminders set.');
    await assert.rejects(async () => tool(owner, 'cancel_reminder').run({ id: theirs!.id }), /no reminder/);
    assert.equal((await agent!.listScheduled({ status: 'pending' })).length, 1, 'still pending');

    assert.match(String(await tool(other, 'cancel_reminder').run({ id: theirs!.id })), /^Cancelled the reminder for/);
    assert.equal((await agent!.listScheduled({ status: 'pending' })).length, 0);
    notes.close();
  });

  it('lets Claude choose note text, ids and times, never whose notes or where reminders go', async () => {
    const { notes, owner } = await setup();
    assert.deepEqual(
      owner.map((t) => [t.name, Object.keys(t.input_schema.properties as object), t.input_schema.additionalProperties]),
      [
        ['save_note', ['text'], false],
        ['search_notes', ['query'], false],
        ['delete_note', ['id'], false],
        ['set_reminder', ['at', 'text'], false],
        ['list_reminders', [], false],
        ['cancel_reminder', ['id'], false],
      ],
    );
    notes.close();
  });
});

describe('assistant agent', () => {
  let agent: Agent | undefined;
  afterEach(async () => agent?.stop());

  it('turns "remind me" into a scheduled message, with the time in the system prompt', async () => {
    const channel = new FakeChannel();
    agent = new Agent({ channels: [channel], debounceMs: 0 });
    const notes = new Notes(dbPath());
    const at = inHours(5);
    const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const responses: Array<Partial<Anthropic.Beta.BetaMessage>> = [
      { stop_reason: 'tool_use', content: [toolUse('r1', 'set_reminder', { at, text: 'water the plants' })] },
      { content: [text(`Done, I'll remind you at ${at.slice(-5)}.`)] },
    ];
    const claude: ClaudeClient = {
      beta: {
        messages: {
          create: (async (body: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
            requests.push(structuredClone(body));
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
    // The handler generated for --template assistant.
    agent.on('message', async (ctx) => {
      const out = await reply(claude, ctx, {
        system: `instructions\n${describeNow('UTC')}`,
        tools: assistantTools(agent!, ctx, notes, 'UTC'),
      });
      if (out) await ctx.reply(out);
    });
    await agent.start();

    await channel.deliver('owner', 'remind me to water the plants in 5 hours');
    await agent.idle();
    assert.deepEqual(channel.replies, [{ to: 'owner', text: `Done, I'll remind you at ${at.slice(-5)}.` }]);
    assert.match(
      (requests[0]!.system as Array<{ text: string }>)[0]!.text,
      /\nIt is now \w{3} \d{4}-\d\d-\d\d \d\d:\d\d \(UTC\)\.$/,
    );
    const [job] = await agent.listScheduled({ status: 'pending' });
    assert.equal(formatTime(job!.at.getTime(), 'UTC'), at);
    assert.equal('text' in job!.request && job!.request.text, 'Reminder: water the plants');
    notes.close();
  });
});

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.Beta.BetaContentBlock;
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  ctx: ChannelContext | undefined;
  replies: Array<{ to: string; text: string }> = [];
  #n = 0;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send(m: { thread: { id: string }; text: string }) {
    this.replies.push({ to: m.thread.id, text: m.text });
    return { id: `o${this.#n++}`, channel: this.name, threadId: m.thread.id };
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
