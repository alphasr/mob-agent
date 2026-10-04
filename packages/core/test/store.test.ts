import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MemoryStore, SqliteStore } from '../src/index.ts';
import type { HistoryEntry, Store } from '../src/index.ts';

const entry = (n: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  channel: 'imessage',
  threadId: 't1',
  messageId: `m${n}`,
  role: n % 2 ? 'agent' : 'user',
  ...(n % 2 ? {} : { senderId: '+15550001' }),
  text: `message ${n}`,
  timestamp: new Date(1_700_000_000_000 + n * 1000),
  ...overrides,
});

for (const [name, make] of [
  ['MemoryStore', () => new MemoryStore()],
  ['SqliteStore', () => new SqliteStore(':memory:')],
] as Array<[string, () => Store]>) {
  describe(name, () => {
    it('markSeen is true once, then false; scoped per channel', async () => {
      const store = make();
      assert.equal(await store.markSeen('whatsapp', 'wamid.1'), true);
      assert.equal(await store.markSeen('whatsapp', 'wamid.1'), false);
      assert.equal(await store.markSeen('telegram', 'wamid.1'), true);
      await store.close();
    });

    it('stores and overwrites channel state', async () => {
      const store = make();
      assert.equal(await store.getState('imessage', 'cursor'), undefined);
      await store.setState('imessage', 'cursor', '100');
      await store.setState('imessage', 'cursor', '250');
      await store.setState('telegram', 'cursor', '7');
      assert.equal(await store.getState('imessage', 'cursor'), '250');
      assert.equal(await store.getState('telegram', 'cursor'), '7');
      await store.close();
    });

    it('returns the latest N history entries oldest-first, per thread', async () => {
      const store = make();
      for (let i = 0; i < 5; i++) await store.appendHistory(entry(i));
      await store.appendHistory(entry(99, { threadId: 'other' }));

      const last3 = await store.getHistory('imessage', 't1', 3);
      assert.deepEqual(last3.map((e) => e.messageId), ['m2', 'm3', 'm4']);
      assert.deepEqual(last3[1], entry(3));
      assert.deepEqual(last3[2], entry(4));
      assert.deepEqual(await store.getHistory('imessage', 't1', 0), []);
      assert.deepEqual(await store.getHistory('email', 't1', 10), []);
      await store.close();
    });
  });
}

describe('SqliteStore on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'textagent-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('survives a restart: dedupe, cursors and history persist', async () => {
    const path = join(dir, 'agent.sqlite');
    const first = new SqliteStore(path);
    await first.markSeen('whatsapp', 'wamid.1');
    await first.setState('imessage', 'cursor', '4821');
    await first.appendHistory(entry(0));
    await first.close();

    const second = new SqliteStore(path);
    assert.equal(await second.markSeen('whatsapp', 'wamid.1'), false);
    assert.equal(await second.getState('imessage', 'cursor'), '4821');
    assert.deepEqual(await second.getHistory('imessage', 't1', 10), [entry(0)]);
    await second.close();
  });

  it('close() is safe to call twice', async () => {
    const store = new SqliteStore(join(dir, 'twice.sqlite'));
    await store.close();
    await store.close();
  });
});
