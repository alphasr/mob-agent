import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../src/db/db.ts';
import { ingestKeys, messages, projects, traces } from '../src/db/schema.ts';
import { MIGRATIONS, testDb } from './db.ts';

const HASH = 'h'.repeat(43);

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await testDb()));
afterEach(() => close());

async function project(name = 'p') {
  const [row] = await db.insert(projects).values({ name }).returning();
  return row!;
}

function trace(projectId: string, id = 'turn-1') {
  return {
    projectId,
    id,
    conversation: HASH,
    channel: 'telegram',
    threadId: HASH,
    startedAt: new Date('2026-10-05T12:00:00Z'),
    durationMs: 12.5,
    sentCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    messageIds: [HASH],
    spans: [{ id: 's1', name: 'claude', startMs: 0, durationMs: 9, attributes: { tool: 'x' } }],
  };
}

describe('schema', () => {
  it('stores a trace with its spans, and ignores a retried insert of the same trace', async () => {
    const { id } = await project();
    await db.insert(traces).values(trace(id)).onConflictDoNothing();
    await db
      .insert(traces)
      .values({ ...trace(id), costUsd: 99 })
      .onConflictDoNothing();
    const rows = await db.select().from(traces);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.costUsd, 0.001);
    assert.deepEqual(rows[0]!.spans[0]!.attributes, { tool: 'x' });
    assert.deepEqual(rows[0]!.messageIds, [HASH]);
  });

  it('keeps the same trace id apart in different projects', async () => {
    const [a, b] = [await project('a'), await project('b')];
    await db.insert(traces).values([trace(a.id), trace(b.id)]);
    assert.equal((await db.select().from(traces).where(eq(traces.projectId, b.id))).length, 1);
  });

  it('keys messages by channel and direction, so equal ids from different sources both survive', async () => {
    const { id: projectId } = await project();
    const base = { projectId, id: HASH, threadId: HASH, text: 'hi', at: new Date() };
    await db
      .insert(messages)
      .values([
        { ...base, channel: 'telegram', direction: 'in' as const },
        { ...base, channel: 'telegram', direction: 'out' as const },
        { ...base, channel: 'whatsapp', direction: 'in' as const },
      ])
      .onConflictDoNothing();
    await db
      .insert(messages)
      .values({ ...base, channel: 'telegram', direction: 'in', text: 'retry' })
      .onConflictDoNothing();
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.text === 'hi' && r.proactive === false));
  });

  it('rejects an unknown message direction in the database too', async () => {
    const { id: projectId } = await project();
    await assert.rejects(
      db.execute(
        sql`insert into messages (project_id, id, direction, channel, thread_id, text, at)
            values (${projectId}, 'x', 'sideways', 'c', 't', '', now())`,
      ),
      (error: Error) => String((error.cause as Error | undefined)?.message).includes('messages_direction_check'),
    );
  });

  it('makes key hashes unique and deletes everything with its project', async () => {
    const { id: projectId } = await project();
    await db.insert(ingestKeys).values({ projectId, keyHash: 'abc', prefix: 'ta_abc' });
    await assert.rejects(db.insert(ingestKeys).values({ projectId, keyHash: 'abc', prefix: 'ta_abc' }));
    await db.insert(traces).values(trace(projectId));
    await db
      .insert(messages)
      .values({ projectId, id: HASH, direction: 'in', channel: 'c', threadId: HASH, text: '', at: new Date() });

    await db.delete(projects).where(eq(projects.id, projectId));
    for (const table of [ingestKeys, traces, messages]) assert.equal((await db.select().from(table)).length, 0);
  });
});

describe('migrations', () => {
  it('match the schema (run `npm run db:generate` after editing schema.ts)', () => {
    const app = dirname(MIGRATIONS);
    // Relative: drizzle-kit mangles absolute --out paths. `.tmp/` is gitignored.
    const out = join('.tmp', `drizzle-check-${process.pid}`);
    try {
      cpSync(MIGRATIONS, join(app, out), { recursive: true });
      const output = execFileSync(
        'npx',
        ['drizzle-kit', 'generate', '--dialect', 'postgresql', '--schema', 'src/db/schema.ts', '--out', out],
        { cwd: app, encoding: 'utf8', stdio: 'pipe' },
      );
      assert.match(output, /No schema changes/, output);
    } finally {
      rmSync(join(app, '.tmp'), { recursive: true, force: true });
    }
  });
});
