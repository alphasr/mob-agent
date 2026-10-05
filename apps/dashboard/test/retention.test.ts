import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { messages, projects, traces } from '../src/db/schema.ts';
import { handlePrune, prune } from '../src/retention.ts';
import { testDb } from './db.ts';

const HASH = 'h'.repeat(43);
const NOW = new Date('2026-10-05T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await testDb()));
afterEach(() => close());

async function seed() {
  const ids = [];
  for (const name of ['a', 'b']) {
    const [project] = await db.insert(projects).values({ name }).returning();
    ids.push(project!.id);
  }
  for (const projectId of ids) {
    for (const [id, age] of [
      ['old', 31],
      ['edge', 29.99],
      ['new', 1],
    ] as const) {
      await db.insert(traces).values({
        projectId,
        id,
        conversation: HASH,
        channel: 'c',
        threadId: HASH,
        startedAt: daysAgo(age),
        durationMs: 1,
        sentCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        messageIds: [],
        spans: [],
      });
      await db
        .insert(messages)
        .values({ projectId, id, direction: 'in', channel: 'c', threadId: HASH, text: 't', at: daysAgo(age) });
    }
  }
}

const request = (authorization?: string) =>
  new Request('http://localhost/v1/cron/prune', authorization ? { headers: { authorization } } : {});

describe('prune', () => {
  it('deletes traces and messages older than 30 days in every project, and keeps the rest', async () => {
    await seed();
    assert.deepEqual(await prune(db, NOW), { traces: 2, messages: 2 });
    const left = (await db.select({ id: traces.id }).from(traces)).map((r) => r.id).sort();
    assert.deepEqual(left, ['edge', 'edge', 'new', 'new']);
    assert.equal((await db.select().from(messages)).length, 4);
    assert.deepEqual(await prune(db, NOW), { traces: 0, messages: 0 }, 'running again deletes nothing');
  });
});

describe('handlePrune', () => {
  const secret = 'cron-secret-value';

  it('runs with the right Bearer secret', async () => {
    await seed();
    const response = await handlePrune(request(`Bearer ${secret}`), db, { secret, now: NOW });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: { traces: 2, messages: 2 } });
  });

  it('stays closed without a secret configured, or with a wrong or missing one', async () => {
    await seed();
    for (const [auth, configured] of [
      [`Bearer ${secret}`, undefined],
      [`Bearer ${secret}`, ''],
      [undefined, secret],
      [`Bearer ${secret}x`, secret],
      [secret, secret],
    ] as const) {
      const response = await handlePrune(request(auth), db, { secret: configured, now: NOW });
      assert.equal(response.status, 401, `${auth} / ${configured}`);
    }
    assert.equal((await db.select().from(traces)).length, 6, 'nothing deleted');
  });

  it('hides database failures behind a bare 500', async () => {
    const errors: unknown[] = [];
    await close();
    const response = await handlePrune(request(`Bearer ${secret}`), db, { secret, onError: (e) => errors.push(e) });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal error' });
    assert.equal(errors.length, 1);
    ({ db, close } = await testDb()); // afterEach closes this one
  });
});
