import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Agent, serve } from '@textagent/core';
import type { Channel, ChannelContext, InboundMessage, RunningServer } from '@textagent/core';
import { INGEST_PATH, exporter, hasher } from '@textagent/cloud';
import type { IngestBatch } from '@textagent/cloud';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/db.ts';
import { ingestKeys, messages, projects, traces } from '../src/db/schema.ts';
import { handleIngest } from '../src/ingest/handler.ts';
import { createProjectWithKey, generateKey, hashKey } from '../src/ingest/keys.ts';
import { testDb } from './db.ts';

const SECRET = 's'.repeat(32);
const hash = hasher(SECRET);
const PHONE = '+15551234567';
const NOW = new Date('2026-10-05T12:00:00Z');

let db: Db;
let close: () => Promise<void>;
let errors: unknown[];
beforeEach(async () => {
  ({ db, close } = await testDb());
  errors = [];
});
afterEach(() => close());

function post(body: unknown, key: string | undefined, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`http://localhost${INGEST_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== undefined && { authorization: `Bearer ${key}` }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handleIngest(request, db, { now: NOW, onError: (e) => errors.push(e) });
}

function batch(id = 'turn-1'): IngestBatch {
  return {
    version: 1,
    traces: [
      {
        id,
        conversation: hash('conv'),
        channel: 'telegram',
        threadId: hash(PHONE),
        startedAt: '2026-10-05T11:59:00.000Z',
        durationMs: 840,
        messageIds: [hash('m1')],
        sentCount: 1,
        spans: [{ id: 's1', name: 'claude', startMs: 1, durationMs: 800, attributes: { tool: 'lookup' } }],
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0011,
      },
    ],
    messages: [
      {
        direction: 'in',
        id: hash('m1'),
        channel: 'telegram',
        threadId: hash(PHONE),
        senderId: hash(PHONE),
        text: 'hello',
        at: '2026-10-05T11:59:00.000Z',
      },
    ],
  };
}

async function error(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe('handleIngest', () => {
  it('stores a batch under the key’s project', async () => {
    const { projectId, key } = await createProjectWithKey(db, 'demo');
    const response = await post(batch(), key);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: { traces: 1, messages: 1 } });

    const [row] = await db.select().from(traces);
    assert.equal(row!.projectId, projectId);
    assert.equal(row!.inputTokens, 120);
    assert.equal(row!.startedAt.toISOString(), '2026-10-05T11:59:00.000Z');
    assert.deepEqual(row!.spans[0]!.attributes, { tool: 'lookup' });
    const [message] = await db.select().from(messages);
    assert.equal(message!.text, 'hello');
    assert.equal(message!.proactive, false);
  });

  it('stores a retried batch once', async () => {
    const { key } = await createProjectWithKey(db, 'demo');
    assert.equal((await post(batch(), key)).status, 200);
    assert.equal((await post(batch(), key)).status, 200);
    assert.equal((await db.select().from(traces)).length, 1);
    assert.equal((await db.select().from(messages)).length, 1);
  });

  it('keeps each project’s data under its own key', async () => {
    const a = await createProjectWithKey(db, 'a');
    const b = await createProjectWithKey(db, 'b');
    await post(batch('turn-a'), a.key);
    await post(batch('turn-b'), b.key);
    const rows = await db.select({ id: traces.id }).from(traces).where(eq(traces.projectId, b.projectId));
    assert.deepEqual(rows, [{ id: 'turn-b' }]);
  });

  it('rejects missing, unknown and revoked keys with 401, before reading the body', async () => {
    const { key } = await createProjectWithKey(db, 'demo');
    assert.equal((await post(batch(), undefined)).status, 401);
    assert.equal((await post(batch(), generateKey().key)).status, 401);
    assert.equal((await post(batch(), key, { authorization: `Basic ${key}` })).status, 401);
    assert.equal((await post('not json at all', 'nope')).status, 401, 'auth comes first');

    await db
      .update(ingestKeys)
      .set({ revokedAt: new Date() })
      .where(eq(ingestKeys.keyHash, hashKey(key)));
    const revoked = await post(batch(), key);
    assert.equal(revoked.status, 401);
    assert.equal(await error(revoked), 'invalid or revoked ingestion key');
    assert.equal((await db.select().from(traces)).length, 0);
  });

  it('answers 415, 413 and 400 for bodies it cannot take', async () => {
    const { key } = await createProjectWithKey(db, 'demo');
    assert.equal((await post(batch(), key, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(batch(), key, { 'content-type': 'application/json; charset=utf-8' })).status, 200);
    assert.equal((await post(`"${'x'.repeat(1_000_001)}"`, key)).status, 413);

    const bad = await post('{"version":1,', key);
    assert.equal(bad.status, 400);
    assert.equal(await error(bad), 'body is not valid JSON');

    const raw = batch();
    raw.traces[0]!.threadId = PHONE;
    const unhashed = await post(raw, key);
    assert.equal(unhashed.status, 400);
    assert.match(await error(unhashed), /traces\[0\]\.threadId must be a hashed id/);
    assert.equal((await db.select().from(traces)).length, 1, 'only the charset request was stored');
  });

  it('answers 405 to anything but POST', async () => {
    const response = await handleIngest(new Request(`http://localhost${INGEST_PATH}`), db);
    assert.equal(response.status, 405);
  });

  it('hides database failures behind a bare 500, which the exporter retries', async () => {
    const { key } = await createProjectWithKey(db, 'demo');
    await close();
    const response = await post(batch(), key);
    assert.equal(response.status, 500);
    assert.equal(await error(response), 'internal error');
    assert.equal(errors.length, 1);
    ({ db, close } = await testDb()); // afterEach closes this one
  });
});

describe('exporter → ingest, end to end', () => {
  let server: RunningServer;
  afterEach(() => server.close());

  it('stores a real agent turn with hashed ids, and its texts when includeText is on', async () => {
    const { projectId, key } = await createProjectWithKey(db, 'demo');
    server = await serve((request) => handleIngest(request, db), { port: 0, path: INGEST_PATH });
    const traceExporter = exporter({ url: new URL(server.url).origin, key, hashSecret: SECRET, includeText: true });

    const channel = new FakeChannel();
    const agent = new Agent({ channels: [channel], debounceMs: 0 });
    agent.on('message', async (ctx) => {
      await ctx.trace.span('claude', { step: 1 }, () => ctx.reply('hi back'));
    });
    agent.on('event', traceExporter);
    await agent.start();
    try {
      await channel.ctx!.receive(inbound('in-1', 'hello there'));
      await agent.idle();
    } finally {
      await agent.stop();
      await traceExporter.close();
    }

    const [trace] = await db.select().from(traces).where(eq(traces.projectId, projectId));
    assert.equal(trace!.threadId, hash(PHONE));
    assert.equal(trace!.spans[0]!.name, 'claude');
    assert.deepEqual(trace!.messageIds, [hash('in-1')]);
    const stored = await db.select().from(messages).where(eq(messages.projectId, projectId));
    assert.deepEqual(stored.map((m) => [m.direction, m.text]).sort(), [
      ['in', 'hello there'],
      ['out', 'hi back'],
    ]);
    assert.ok(!JSON.stringify([trace, stored]).includes(PHONE), 'no raw phone number anywhere');
  });
});

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  ctx: ChannelContext | undefined;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send() {
    return { id: 'out-1', channel: this.name, threadId: PHONE };
  }
}

function inbound(id: string, text: string): InboundMessage {
  return {
    id,
    channel: 'fake',
    thread: { id: PHONE, channel: 'fake', isGroup: false },
    sender: { id: PHONE },
    text,
    attachments: [],
    timestamp: new Date(),
    raw: {},
  };
}

describe('handleIngest with message text turned off', () => {
  it('stores traces but drops message text, and still answers 200', async () => {
    const { projectId, key } = await createProjectWithKey(db, 'private');
    await db.update(projects).set({ storeText: false }).where(eq(projects.id, projectId));
    const response = await post(batch(), key);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: { traces: 1, messages: 0 } });
    assert.equal((await db.select().from(traces)).length, 1);
    assert.equal((await db.select().from(messages)).length, 0);
  });
});
