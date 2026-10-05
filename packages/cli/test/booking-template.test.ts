import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@textagent/core';
import type { Channel, ChannelContext, InboundMessage, MessageContext, ScheduleRequest } from '@textagent/core';
import { reply } from '../templates/claude.ts';
import type { ClaudeClient } from '../templates/claude.ts';
import { Bookings, REMINDER_MS, bookingTools, loadBookingConfig, personOf } from '../templates/booking.ts';
import { describeNow, formatTime, parseTime } from '../templates/time.ts';
import type { BookingConfig } from '../templates/booking.ts';

const tmp = mkdtempSync(join(tmpdir(), 'textagent-booking-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dbPath = () => join(tmp, `booking-${n++}.sqlite`);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const EXAMPLE = loadBookingConfig(readFileSync(new URL('../templates/booking.config.json', import.meta.url), 'utf8'));
/** Open around the clock in UTC, so tests that use the real clock always find slots. */
const ALWAYS_OPEN: BookingConfig = {
  timezone: 'UTC',
  slotMinutes: 60,
  daysAhead: 30,
  minNoticeMinutes: 0,
  maxBookingsPerPerson: 2,
  hours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, ['00:00-24:00']])),
};
/** A whole hour `days` from now. */
const hoursAhead = (hours: number) => Math.ceil(Date.now() / HOUR) * HOUR + hours * HOUR;

describe('loadBookingConfig', () => {
  const valid = JSON.parse(readFileSync(new URL('../templates/booking.config.json', import.meta.url), 'utf8'));
  const load = (patch: Record<string, unknown>) => () => loadBookingConfig(JSON.stringify({ ...valid, ...patch }));

  it('accepts the example and rejects typos and impossible hours', () => {
    assert.equal(EXAMPLE.timezone, 'Europe/London');
    assert.throws(load({ slotMinute: 30 }), /unknown setting slotMinute/);
    assert.throws(load({ timezone: 'Europe/Londn' }), /unknown timezone/);
    assert.throws(load({ slotMinutes: 0 }), /slotMinutes must be a whole number/);
    assert.throws(load({ daysAhead: 400 }), /daysAhead/);
    assert.throws(load({ hours: { monday: ['09:00-17:00'] } }), /"monday" is not mon…sun/);
    assert.throws(load({ hours: { mon: ['17:00-09:00'] } }), /HH:MM-HH:MM/);
    assert.throws(load({ hours: { mon: ['9:00-17:00'] } }), /HH:MM-HH:MM/);
    assert.throws(load({ hours: { mon: '09:00-17:00' } }), /must be a list/);
  });
});

describe('Bookings.openSlots', () => {
  // Monday 2026-1005 13:10 in London (BST, UTC+1).
  const now = Date.parse('2026-10-05T12:10:00Z');

  it('follows opening hours, the lunch break, closed days and minimum notice, in local time', () => {
    const bookings = new Bookings(EXAMPLE, dbPath());
    const today = bookings.openSlots(undefined, now, 4).map((t) => formatTime(t, EXAMPLE.timezone));
    // 13:10 + 60 min notice: 14:00 is too soon, 14:30 is the first.
    assert.deepEqual(today, [
      'Mon 2026-10-05 14:30',
      'Mon 2026-10-05 15:00',
      'Mon 2026-10-05 15:30',
      'Mon 2026-10-05 16:00',
    ]);

    const thursday = bookings
      .openSlots('2026-10-08', now, 30)
      .filter((t) => formatTime(t, EXAMPLE.timezone).startsWith('Thu'));
    const times = thursday.map((t) => formatTime(t, EXAMPLE.timezone).slice(-5));
    assert.equal(times.includes('11:30'), true);
    assert.equal(times.includes('12:00') || times.includes('12:30'), false, 'closed for lunch');
    assert.equal(times.at(-1), '18:30', 'last slot ends at closing');

    const weekend = bookings.openSlots('2026-10-10', now, 30).map((t) => formatTime(t, EXAMPLE.timezone));
    assert.equal(weekend[0], 'Sat 2026-10-10 10:00');
    assert.deepEqual(weekend.slice(7, 9), ['Sat 2026-10-10 13:30', 'Mon 2026-10-12 09:00'], 'Sunday is closed');
    bookings.close();
  });

  it('stops at the end of the booking window and keeps local times across a DST change', () => {
    const bookings = new Bookings(EXAMPLE, dbPath());
    const all = bookings.openSlots(undefined, now, Infinity);
    assert.equal(formatTime(all.at(-1)!, EXAMPLE.timezone), 'Mon 2026-10-19 16:30', '14 days ahead, inclusive');
    assert.deepEqual(bookings.openSlots('2026-11-01', now), [], 'past the window');

    // London leaves BST on 2026-10-25: 09:00 is 08:00Z before, 09:00Z after.
    const afterDst = new Bookings({ ...EXAMPLE, daysAhead: 30 }, dbPath());
    const mon26 = afterDst.openSlots('2026-10-26', now, 1)[0]!;
    assert.equal(new Date(mon26).toISOString(), '2026-10-26T09:00:00.000Z');
    assert.equal(new Date(afterDst.openSlots('2026-10-19', now, 1)[0]!).toISOString(), '2026-10-19T08:00:00.000Z');
    bookings.close();
    afterDst.close();
  });
});

describe('Bookings', () => {
  const now = Date.parse('2026-10-05T12:10:00Z');
  const slot = (text: string) => parseTime(text, EXAMPLE.timezone)!;

  it('never gives one slot to two people, and takes the slot off the open list', () => {
    const bookings = new Bookings(EXAMPLE, dbPath());
    bookings.book('telegram:ada', slot('2026-10-06 09:30'), now);
    assert.throws(() => bookings.book('telegram:bob', slot('2026-10-06 09:30'), now), /not an open slot/);
    assert.equal(bookings.openSlots('2026-10-06', now).includes(slot('2026-10-06 09:30')), false);
    assert.throws(() => bookings.book('telegram:bob', slot('2026-10-06 09:15'), now), /not an open slot/, 'off-grid');
    assert.throws(() => bookings.book('telegram:bob', slot('2026-10-11 10:00'), now), /not an open slot/, 'Sunday');
    bookings.close();
  });

  it('relies on the database, not the check before it, when two processes race for a slot', () => {
    const path = dbPath();
    const first = new Bookings(EXAMPLE, path);
    // A second process that read the open slots before the first one booked.
    const stale = new (class extends Bookings {
      override openSlots(): number[] {
        return [slot('2026-10-06 09:30')];
      }
    })(EXAMPLE, path);
    first.book('telegram:ada', slot('2026-10-06 09:30'), now);
    assert.throws(() => stale.book('telegram:bob', slot('2026-10-06 09:30'), now), /was just taken/);
    first.close();
    stale.close();
  });

  it('caps upcoming bookings per person and scopes listing and cancelling to that person', () => {
    const bookings = new Bookings({ ...EXAMPLE, maxBookingsPerPerson: 2 }, dbPath());
    bookings.book('telegram:ada', slot('2026-10-06 09:30'), now);
    bookings.book('telegram:ada', slot('2026-10-06 10:00'), now);
    assert.throws(() => bookings.book('telegram:ada', slot('2026-10-06 10:30'), now), /already have 2/);
    bookings.book('telegram:bob', slot('2026-10-06 10:30'), now);

    assert.deepEqual(
      bookings.upcoming('telegram:ada', now).map((b) => formatTime(b.start, EXAMPLE.timezone)),
      ['Tue 2026-10-06 09:30', 'Tue 2026-10-06 10:00'],
    );
    assert.equal(bookings.upcoming('whatsapp:ada', now).length, 0, 'same id on another channel is someone else');
    assert.equal(bookings.cancel('telegram:bob', slot('2026-10-06 09:30'), now), undefined, "not bob's to cancel");
    assert.equal(bookings.upcoming('telegram:ada', now).length, 2);
    assert.equal(bookings.cancel('telegram:ada', slot('2026-10-06 09:30'), now + 2 * DAY), undefined, 'already past');
    assert.equal(bookings.cancel('telegram:ada', slot('2026-10-06 09:30'), now)?.start, slot('2026-10-06 09:30'));
    assert.equal(bookings.openSlots('2026-10-06', now).includes(slot('2026-10-06 09:30')), true, 'open again');
    bookings.close();
  });

  it('keeps old bookings blocking their time after the slot length changes', () => {
    const path = dbPath();
    const hourly = new Bookings({ ...EXAMPLE, slotMinutes: 60 }, path);
    hourly.book('telegram:ada', slot('2026-10-06 09:00'), now); // 09:00–10:00
    const halfHourly = new Bookings(EXAMPLE, path);
    const open = halfHourly.openSlots('2026-10-06', now, 3).map((t) => formatTime(t, EXAMPLE.timezone).slice(-5));
    assert.deepEqual(open, ['10:00', '10:30', '11:00'], '09:30 overlaps the hour-long booking');
    hourly.close();
    halfHourly.close();
  });
});

describe('bookingTools', () => {
  const ctx = {
    channel: { name: 'telegram' },
    thread: { id: 'chat-42', channel: 'telegram', isGroup: false },
    sender: { id: '42' },
  } as unknown as MessageContext; // the tools read only channel, thread and sender

  function fakeAgent() {
    const scheduled: ScheduleRequest[] = [];
    const canceled: unknown[] = [];
    let failNext = false;
    return {
      scheduled,
      canceled,
      failSchedule: () => (failNext = true),
      agent: {
        schedule: async (request: ScheduleRequest) => {
          if (failNext) throw new Error('store is down');
          scheduled.push(request);
          return {} as Awaited<ReturnType<Agent['schedule']>>; // the tools ignore the result
        },
        cancelScheduled: async (by: { id: string } | { key: string }) => (canceled.push(by), true),
      },
    };
  }
  const tool = (tools: ReturnType<typeof bookingTools>, name: string) => tools.find((t) => t.name === name)!;

  it('books for the sender and schedules a reminder 24 hours before, to the same conversation', async () => {
    const fake = fakeAgent();
    const bookings = new Bookings(ALWAYS_OPEN, dbPath());
    const tools = bookingTools(fake.agent, ctx, bookings);
    const start = hoursAhead(72);
    const text = formatTime(start, ALWAYS_OPEN.timezone);

    assert.equal(await tool(tools, 'book_slot').run({ start: text }), `Booked ${text}.`);
    assert.equal(bookings.upcoming('telegram:42')[0]?.start, start);
    const [reminder] = fake.scheduled;
    assert.equal(reminder?.at.getTime(), start - REMINDER_MS);
    assert.deepEqual(
      { ...reminder, at: undefined, key: undefined },
      {
        thread: ctx.thread,
        to: '42',
        text: `Reminder: you're booked for ${text} (UTC). Reply here if you need to cancel.`,
        at: undefined,
        key: undefined,
      },
    );
    assert.match(reminder!.key!, /^booking:[0-9a-f-]{36}:reminder$/);

    assert.equal(await tool(tools, 'list_my_bookings').run({}), text);
    assert.equal(await tool(tools, 'cancel_booking').run({ start: text }), `Cancelled ${text}.`);
    assert.deepEqual(fake.canceled, [{ key: reminder!.key }]);
    assert.equal(await tool(tools, 'list_my_bookings').run({}), 'No upcoming bookings.');
    bookings.close();
  });

  it('sends no reminder for a booking less than 24 hours away', async () => {
    const fake = fakeAgent();
    const bookings = new Bookings(ALWAYS_OPEN, dbPath());
    await tool(bookingTools(fake.agent, ctx, bookings), 'book_slot').run({
      start: formatTime(hoursAhead(3), ALWAYS_OPEN.timezone),
    });
    assert.equal(bookings.upcoming('telegram:42').length, 1);
    assert.deepEqual(fake.scheduled, []);
    bookings.close();
  });

  it('undoes the booking when its reminder cannot be scheduled', async () => {
    const fake = fakeAgent();
    fake.failSchedule();
    const bookings = new Bookings(ALWAYS_OPEN, dbPath());
    const book = tool(bookingTools(fake.agent, ctx, bookings), 'book_slot');
    await assert.rejects(
      async () => book.run({ start: formatTime(hoursAhead(72), ALWAYS_OPEN.timezone) }),
      /store is down/,
    );
    assert.deepEqual(bookings.upcoming('telegram:42'), []);
    bookings.close();
  });

  it("can't cancel someone else's booking, and touches no reminder trying", async () => {
    const fake = fakeAgent();
    const bookings = new Bookings(ALWAYS_OPEN, dbPath());
    const start = hoursAhead(72);
    bookings.book('telegram:someone-else', start);
    const cancel = tool(bookingTools(fake.agent, ctx, bookings), 'cancel_booking');
    await assert.rejects(
      async () => cancel.run({ start: formatTime(start, ALWAYS_OPEN.timezone) }),
      /no upcoming booking/,
    );
    assert.deepEqual(fake.canceled, []);
    assert.equal(bookings.upcoming('telegram:someone-else').length, 1);
    bookings.close();
  });

  it('lets Claude choose only times, never whose booking or where reminders go', () => {
    const tools = bookingTools(fakeAgent().agent, ctx, new Bookings(ALWAYS_OPEN, dbPath()));
    assert.deepEqual(
      tools.map((t) => [t.name, Object.keys(t.input_schema.properties as object), t.input_schema.additionalProperties]),
      [
        ['list_open_slots', ['from'], false],
        ['book_slot', ['start'], false],
        ['list_my_bookings', [], false],
        ['cancel_booking', ['start'], false],
      ],
    );
    assert.equal(personOf(ctx), 'telegram:42');
  });
});

describe('booking agent', () => {
  let agent: Agent | undefined;
  afterEach(async () => agent?.stop());

  it('books through Claude, refuses a taken slot to the next person, and keeps the reminder in the store', async () => {
    const channel = new FakeChannel();
    agent = new Agent({ channels: [channel], debounceMs: 0 });
    const bookings = new Bookings(ALWAYS_OPEN, dbPath());
    const slotText = formatTime(hoursAhead(72), ALWAYS_OPEN.timezone);
    const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const responses: Array<Partial<Anthropic.Beta.BetaMessage>> = [
      { stop_reason: 'tool_use', content: [toolUse('b1', 'book_slot', { start: slotText })] },
      { content: [text(`You're booked for ${slotText}.`)] },
      { stop_reason: 'tool_use', content: [toolUse('b2', 'book_slot', { start: slotText })] },
      { content: [text('Sorry, that time is taken.')] },
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
    // The handler generated for --template booking.
    agent.on('message', async (ctx) => {
      const out = await reply(claude, ctx, {
        system: `instructions\n${describeNow(ALWAYS_OPEN.timezone)}`,
        tools: bookingTools(agent!, ctx, bookings),
      });
      if (out) await ctx.reply(out);
    });
    await agent.start();

    await channel.deliver('ada', `Book me in for ${slotText}`);
    await agent.idle();
    assert.deepEqual(channel.replies, [{ to: 'ada', text: `You're booked for ${slotText}.` }]);
    assert.match(
      String(requests[0]!.system && (requests[0]!.system as Array<{ text: string }>)[0]!.text),
      /It is now /,
    );
    const reminders = await agent.listScheduled({ status: 'pending' });
    assert.equal(reminders.length, 1);
    assert.deepEqual(reminders[0]!.request, {
      thread: { id: 'ada', channel: 'fake', isGroup: false },
      to: 'ada',
      text: `Reminder: you're booked for ${slotText} (UTC). Reply here if you need to cancel.`,
    });

    await channel.deliver('bob', `Book me in for ${slotText}`);
    await agent.idle();
    const toolResult = (requests.at(-1)!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
    assert.equal(toolResult.is_error, true);
    assert.match(String(toolResult.content), /not an open slot/);
    assert.deepEqual(channel.replies.at(-1), { to: 'bob', text: 'Sorry, that time is taken.' });
    assert.equal(bookings.upcoming('fake:bob').length, 0);
    assert.equal((await agent.listScheduled({ status: 'pending' })).length, 1);
    bookings.close();
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
