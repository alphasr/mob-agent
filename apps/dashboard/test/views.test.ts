import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AccessError, createProject } from '../src/auth/members.ts';
import type { Db } from '../src/db/db.ts';
import { messages, traces } from '../src/db/schema.ts';
import { formatCost, formatCostTick, formatDuration, parseRange, shortHash } from '../src/views/format.ts';
import { getConversation } from '../src/views/conversations.ts';
import { getOverview } from '../src/views/overview.ts';
import { PAGE_SIZE, getTurn, listChannels, listTurns } from '../src/views/turns.ts';
import { signedIn, testDb } from './db.ts';

const NOW = new Date('2026-10-05T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const HASH = (c: string) => c.repeat(43);

let db: Db;
let close: () => Promise<void>;
let ada: string;
let project: string;
beforeEach(async () => {
  ({ db, close } = await testDb());
  ada = await signedIn(db, 'ada', '101');
  project = await createProject(db, ada, 'ada', 'p');
});
afterEach(() => close());

async function turn(
  id: string,
  startedAt: Date,
  more: Partial<typeof traces.$inferInsert> = {},
  projectId = project,
): Promise<void> {
  await db.insert(traces).values({
    projectId,
    id,
    conversation: HASH('c'),
    channel: 'telegram',
    threadId: HASH('t'),
    startedAt,
    durationMs: 100,
    sentCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    messageIds: [],
    spans: [{ id: 's', name: 'x', startMs: 0, durationMs: 1, attributes: {} }],
    ...more,
  });
}

describe('listTurns', () => {
  it('lists this project’s turns in the range, newest first, with derived columns', async () => {
    const other = await createProject(db, ada, 'ada', 'other');
    await turn('old', minutesAgo(60 * 25));
    await turn('a', minutesAgo(10));
    await turn('b', minutesAgo(5), { error: 'boom' });
    await turn('elsewhere', minutesAgo(1), {}, other);

    const { turns, next } = await listTurns(db, ada, project, { range: '24h' }, NOW);
    assert.deepEqual(
      turns.map((t) => t.id),
      ['b', 'a'],
    );
    assert.equal(next, undefined);
    assert.equal(turns[0]!.tokens, 15);
    assert.equal(turns[0]!.spanCount, 1);
    assert.equal(turns[0]!.error, 'boom');
    assert.deepEqual(
      (await listTurns(db, ada, project, { range: '7d' }, NOW)).turns.map((t) => t.id),
      ['b', 'a', 'old'],
    );
  });

  it('filters by channel and by errors', async () => {
    await turn('t1', minutesAgo(3));
    await turn('w1', minutesAgo(2), { channel: 'whatsapp' });
    await turn('w2', minutesAgo(1), { channel: 'whatsapp', error: 'x' });
    const ids = async (filter: Parameters<typeof listTurns>[3]) =>
      (await listTurns(db, ada, project, filter, NOW)).turns.map((t) => t.id);
    assert.deepEqual(await ids({ range: '24h', channel: 'whatsapp' }), ['w2', 'w1']);
    assert.deepEqual(await ids({ range: '24h', errorsOnly: true }), ['w2']);
    assert.deepEqual(await listChannels(db, ada, project, '24h', NOW), ['telegram', 'whatsapp']);
  });

  it('pages through every turn exactly once, even when many share a start time', async () => {
    const same = minutesAgo(30);
    const ids: string[] = [];
    for (let i = 0; i < PAGE_SIZE * 2 + 7; i++) {
      const id = `t${String(i).padStart(3, '0')}`;
      ids.push(id);
      await turn(id, i % 3 === 0 ? same : minutesAgo(i));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listTurns(db, ada, project, { range: '24h', ...(cursor && { cursor }) }, NOW);
      seen.push(...page.turns.map((t) => t.id));
      cursor = page.next;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, ids.length);
    assert.deepEqual([...seen].sort(), ids.sort(), 'no repeats, no gaps');
  });

  it('treats a malformed cursor as the first page', async () => {
    await turn('a', minutesAgo(1));
    for (const cursor of [
      'garbage',
      Buffer.from('["not a date","x"]').toString('base64url'),
      Buffer.from('{}').toString('base64url'),
    ]) {
      assert.deepEqual(
        (await listTurns(db, ada, project, { range: '24h', cursor }, NOW)).turns.map((t) => t.id),
        ['a'],
      );
    }
  });

  it('is only for members', async () => {
    const eve = await signedIn(db, 'eve', '666');
    await assert.rejects(listTurns(db, eve, project, { range: '24h' }, NOW), AccessError);
    await assert.rejects(listChannels(db, eve, project, '24h', NOW), AccessError);
  });
});

describe('format', () => {
  it('formats durations, costs and hashes', () => {
    assert.equal(formatDuration(840.4), '840 ms');
    assert.equal(formatDuration(1_234), '1.2 s');
    assert.equal(formatDuration(123_000), '2m 03s');
    assert.equal(formatCost(0.00112), '$0.0011');
    assert.equal(shortHash('abcdefghijk'), 'abcdefgh');
    assert.deepEqual(
      [0, 0.05, 0.1].map((v) => formatCostTick(v, 0.05)),
      ['$0.00', '$0.05', '$0.10'],
    );
    assert.equal(formatCostTick(0.004, 0.002), '$0.004');
    assert.equal(formatCostTick(20, 5), '$20');
  });

  it('accepts only known ranges from the URL', () => {
    assert.equal(parseRange('7d'), '7d');
    for (const bad of [undefined, '', '1y', 'toString', '__proto__', ['7d']]) assert.equal(parseRange(bad), '24h');
  });
});

describe('getTurn', () => {
  async function message(
    direction: 'in' | 'out',
    id: string,
    at: Date,
    more: Partial<typeof messages.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(messages).values({
      projectId: project,
      id: HASH(id),
      direction,
      channel: 'telegram',
      threadId: HASH('t'),
      text: id,
      at,
      ...more,
    });
  }

  it('returns the turn with the messages it answered and the replies sent during it', async () => {
    const start = minutesAgo(10);
    const at = (ms: number) => new Date(start.getTime() + ms);
    await turn('t1', start, { messageIds: [HASH('a'), HASH('b')], durationMs: 2_000 });
    await message('in', 'a', at(-3_000));
    await message('in', 'b', at(-1_000));
    await message('out', 'r', at(1_500));
    await message('out', 'late', at(2_500)); // within the 1s slack
    await message('in', 'other-turn', at(500)); // not one of this turn's ids
    await message('out', 'next-turn', at(60_000));
    await message('out', 'other-thread', at(1_000), { threadId: HASH('x') });
    await message('out', 'other-channel', at(1_000), { channel: 'whatsapp' });

    const result = await getTurn(db, ada, project, 't1');
    assert.equal(result?.turn.id, 't1');
    assert.deepEqual(
      result.messages.map((m) => `${m.direction}:${m.text}`),
      ['in:a', 'in:b', 'out:r', 'out:late'],
    );
  });

  it('finds nothing for unknown turns, other projects’ turns and non-members', async () => {
    const other = await createProject(db, ada, 'ada', 'other');
    await turn('theirs', minutesAgo(1), {}, other);
    assert.equal(await getTurn(db, ada, project, 'theirs'), undefined);
    assert.equal(await getTurn(db, ada, project, "x' or '1'='1"), undefined);
    const eve = await signedIn(db, 'eve', '666');
    await assert.rejects(getTurn(db, eve, other, 'theirs'), AccessError);
  });
});

describe('getOverview', () => {
  it('summarises the range and fills every hourly bucket, quiet ones included', async () => {
    const other = await createProject(db, ada, 'ada', 'other');
    // NOW is 12:00 UTC; turns at 11:10, 11:20 (failed), 11:50 and 09:30, plus noise outside.
    await turn('a', minutesAgo(50), { durationMs: 100, costUsd: 0.01 });
    await turn('b', minutesAgo(40), { durationMs: 300, costUsd: 0.02, error: 'x' });
    await turn('c', minutesAgo(10), { durationMs: 200, costUsd: 0.03 });
    await turn('d', minutesAgo(150), { durationMs: 1000, costUsd: 0.04 });
    await turn('old', minutesAgo(60 * 25), { durationMs: 99_999 });
    await turn('elsewhere', minutesAgo(5), { durationMs: 99_999 }, other);

    const { summary, buckets, bucket } = await getOverview(db, ada, project, '24h', NOW);
    assert.equal(bucket, 'hour');
    assert.equal(summary.turns, 4);
    assert.equal(summary.failed, 1);
    assert.equal(summary.p50, 250);
    assert.equal(summary.tokens, 60);
    assert.ok(Math.abs(summary.costUsd - 0.1) < 1e-9);

    assert.equal(buckets.length, 25);
    const at = (iso: string) => buckets.find((b) => b.start === Date.parse(iso))!;
    assert.deepEqual(at('2026-10-05T11:00:00Z'), {
      start: Date.parse('2026-10-05T11:00:00Z'),
      turns: 3,
      failed: 1,
      costUsd: 0.06,
      p50: 200,
      p95: 290,
    });
    assert.deepEqual(at('2026-10-05T10:00:00Z'), {
      start: Date.parse('2026-10-05T10:00:00Z'),
      turns: 0,
      failed: 0,
      costUsd: 0,
      p50: null,
      p95: null,
    });
    assert.equal(at('2026-10-05T09:00:00Z').turns, 1);
  });

  it('reports zeros and no latency for an empty project, and is only for members', async () => {
    const { summary } = await getOverview(db, ada, project, '7d', NOW);
    assert.deepEqual(summary, { turns: 0, failed: 0, p50: null, p95: null, tokens: 0, costUsd: 0 });
    const eve = await signedIn(db, 'eve', '666');
    await assert.rejects(getOverview(db, eve, project, '24h', NOW), AccessError);
  });
});

describe('getConversation', () => {
  it('returns one conversation’s turns, totals and thread, and nothing from other conversations or projects', async () => {
    const other = await createProject(db, ada, 'ada', 'other');
    await turn('c1', minutesAgo(30), { costUsd: 0.01 });
    await turn('c2', minutesAgo(20), { costUsd: 0.02, error: 'x' });
    await turn('elsewhere', minutesAgo(10), { conversation: HASH('d') });
    await turn('same-hash-other-project', minutesAgo(5), {}, other);
    const msg = (id: string, at: Date, more: Partial<typeof messages.$inferInsert> = {}) =>
      db.insert(messages).values({
        projectId: project,
        id: HASH(id),
        direction: 'in',
        channel: 'telegram',
        threadId: HASH('t'),
        text: id,
        at,
        ...more,
      });
    await msg('a', minutesAgo(31));
    await msg('b', minutesAgo(21), { direction: 'out' });
    await msg('w', minutesAgo(21), { channel: 'whatsapp' });
    await msg('x', minutesAgo(21), { threadId: HASH('x') });

    const c = await getConversation(db, ada, project, HASH('c'));
    assert.ok(c);
    assert.equal(c.channel, 'telegram');
    assert.deepEqual(
      c.turns.map((t) => t.id),
      ['c2', 'c1'],
    );
    assert.equal(c.totals.turns, 2);
    assert.equal(c.totals.failed, 1);
    assert.ok(Math.abs(c.totals.costUsd - 0.03) < 1e-9);
    assert.equal(c.totals.first.toISOString(), minutesAgo(30).toISOString());
    assert.deepEqual(
      c.messages.map((m) => m.text),
      ['a', 'b'],
      'oldest first; other channels and threads excluded',
    );
  });

  it('finds nothing for unknown or malformed hashes, and is only for members', async () => {
    assert.equal(await getConversation(db, ada, project, HASH('z')), undefined);
    assert.equal(await getConversation(db, ada, project, "x' or 1=1 --"), undefined);
    const eve = await signedIn(db, 'eve', '666');
    await assert.rejects(getConversation(db, eve, project, HASH('c')), AccessError);
  });
});
