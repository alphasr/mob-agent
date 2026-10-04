import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryStore } from '@textagent/core';
import type { InboundMessage } from '@textagent/core';
import { ChatDbPoller, ChatDbReader, decodeAttributedBody } from '../src/index.ts';
import { FakeChatDb, attributedBody } from './fixture.ts';

const DM = 'iMessage;-;+15550001';
const GROUP = 'iMessage;+;chat123456';

describe('decodeAttributedBody', () => {
  it('decodes short, emoji and long (2-byte length) text', () => {
    for (const text of ['hi', 'café ☕️ 👩‍👩‍👧', 'x'.repeat(300), 'line one\nline two']) {
      assert.equal(decodeAttributedBody(attributedBody(text)), text);
    }
  });

  it('returns undefined for empty or unrecognized blobs instead of throwing', () => {
    assert.equal(decodeAttributedBody(null), undefined);
    assert.equal(decodeAttributedBody(new Uint8Array()), undefined);
    assert.equal(decodeAttributedBody(Buffer.from('not a typedstream')), undefined);
    const truncated = attributedBody('hello world').subarray(0, -10);
    assert.equal(decodeAttributedBody(truncated), undefined);
  });
});

describe('ChatDbReader', () => {
  let fake: FakeChatDb;
  let reader: ChatDbReader;
  beforeEach(() => {
    fake = new FakeChatDb();
    fake.chat(DM, 45);
    fake.chat(GROUP, 43, 'Weekend plans');
    reader = new ChatDbReader(fake.path);
  });
  afterEach(() => {
    reader.close();
    fake.cleanup();
  });

  it('normalizes a direct message, with a nanosecond date that overflows JS numbers', () => {
    const rowid = fake.message({ text: 'hello', from: '+15550001', chat: DM });
    const { messages, cursor } = reader.read(0);

    assert.equal(cursor, rowid);
    assert.equal(messages.length, 1);
    const m = messages[0]!;
    assert.equal(m.id, 'GUID-1');
    assert.equal(m.channel, 'imessage');
    assert.deepEqual(m.thread, { id: DM, channel: 'imessage', isGroup: false });
    assert.deepEqual(m.sender, { id: '+15550001' });
    assert.equal(m.text, 'hello');
    assert.equal(m.timestamp.toISOString(), '2026-10-04T12:00:00.000Z');
  });

  it('falls back to attributedBody when text is NULL', () => {
    fake.message({ text: null, body: 'only in the blob 🎉', from: '+15550001', chat: DM });
    assert.equal(reader.read(0).messages[0]?.text, 'only in the blob 🎉');
  });

  it('skips own messages, tapbacks, system events and app balloons, but keeps link previews', () => {
    fake.message({ text: 'mine', fromMe: true, chat: DM });
    fake.message({ text: 'Loved "hello"', associatedType: 2000, from: '+15550001', chat: DM });
    fake.message({ text: null, itemType: 2, from: '+15550001', chat: GROUP });
    fake.message({ text: '￼', balloon: 'com.apple.PassbookUIService.PeerPaymentMessagesExtension', from: '+15550001', chat: DM });
    fake.message({ text: 'https://example.com', balloon: 'com.apple.messages.URLBalloonProvider', from: '+15550001', chat: DM });
    fake.message({ text: '   ', from: '+15550001', chat: DM });

    const { messages, skipped, cursor } = reader.read(0);
    assert.deepEqual(messages.map((m) => m.text), ['https://example.com']);
    assert.deepEqual(skipped.map((s) => s.reason), ['from-me', 'reaction', 'system', 'app', 'empty']);
    assert.equal(cursor, 6, 'cursor moves past skipped rows too');
  });

  it('marks group chats and keeps the chat guid as the thread id for replies', () => {
    fake.message({ text: 'who is in?', from: '+15550002', chat: GROUP });
    const m = reader.read(0).messages[0]!;
    assert.equal(m.thread.isGroup, true);
    assert.equal(m.thread.id, GROUP);
    assert.equal((m.raw as { chatName: string }).chatName, 'Weekend plans');
  });

  it('includes attachments and strips the inline placeholder', () => {
    fake.message({
      text: '￼look at this',
      from: '+15550001',
      chat: DM,
      attachments: [{ filename: '~/Library/Messages/Attachments/ab/IMG_1.heic', mime: 'image/heic', name: 'IMG_1.heic' }],
    });
    fake.message({
      text: '￼',
      from: '+15550001',
      chat: DM,
      attachments: [{ filename: '~/Library/Messages/Attachments/cd/memo.m4a', mime: 'audio/x-m4a', name: 'memo.m4a' }],
    });

    const [withText, voiceMemo] = reader.read(0).messages;
    assert.equal(withText?.text, 'look at this');
    assert.deepEqual(withText?.attachments, [
      {
        kind: 'image',
        mimeType: 'image/heic',
        filename: 'IMG_1.heic',
        uri: join(homedir(), 'Library/Messages/Attachments/ab/IMG_1.heic'),
      },
    ]);
    assert.equal(voiceMemo?.text, '', 'attachment-only messages are delivered with empty text');
    assert.equal(voiceMemo?.attachments[0]?.kind, 'audio');
  });

  it('waits for a message whose chat link is not written yet, without skipping past it', () => {
    const first = fake.message({ text: 'first', from: '+15550001', chat: DM });
    const orphan = fake.message({ text: 'mid-write', from: '+15550001', chat: DM, orphan: true });
    fake.message({ text: 'after', from: '+15550001', chat: DM });

    const r1 = reader.read(0);
    assert.deepEqual(r1.messages.map((m) => m.text), ['first']);
    assert.equal(r1.cursor, first);

    fake.link(orphan, DM);
    const r2 = reader.read(r1.cursor);
    assert.deepEqual(r2.messages.map((m) => m.text), ['mid-write', 'after']);
  });

  it('gives up on a message that never gets a chat link', () => {
    const r = new ChatDbReader(fake.path, { maxOrphanReads: 3 });
    const orphan = fake.message({ text: 'lost', from: '+15550001', orphan: true });
    fake.message({ text: 'next', from: '+15550001', chat: DM });

    assert.equal(r.read(0).cursor, 0);
    assert.equal(r.read(0).cursor, 0);
    const third = r.read(0);
    assert.deepEqual(third.skipped, [{ rowid: orphan, reason: 'no-chat' }]);
    assert.deepEqual(third.messages.map((m) => m.text), ['next']);
    r.close();
  });

  it('reports the latest row id', () => {
    assert.equal(reader.latestRowId(), 0);
    fake.message({ text: 'a', from: '+15550001', chat: DM });
    fake.message({ text: 'b', from: '+15550001', chat: DM });
    assert.equal(reader.latestRowId(), 2);
  });

  it('explains a missing database', () => {
    assert.throws(() => new ChatDbReader(join(fake.dir, 'nope.db')), /No Messages database/);
  });
});

describe('ChatDbPoller', () => {
  let fake: FakeChatDb;
  beforeEach(() => {
    fake = new FakeChatDb();
    fake.chat(DM, 45);
  });
  afterEach(() => fake.cleanup());

  function poller(store: MemoryStore, received: InboundMessage[], batchSize = 200) {
    const reader = new ChatDbReader(fake.path);
    const p = new ChatDbPoller({
      reader,
      state: { get: (k) => store.getState('imessage', k), set: (k, v) => store.setState('imessage', k, v) },
      onMessage: async (m) => void received.push(m),
      onError: (e) => assert.fail(String(e)),
      intervalMs: 10_000,
      batchSize,
    });
    return { reader, p };
  }

  it('does not answer history on first start, then delivers new messages', async () => {
    fake.message({ text: 'old news', from: '+15550001', chat: DM });
    const store = new MemoryStore();
    const received: InboundMessage[] = [];
    const { reader, p } = poller(store, received);

    await p.start();
    await p.stop();
    assert.deepEqual(received, []);

    fake.message({ text: 'new', from: '+15550001', chat: DM });
    await p.poll();
    assert.deepEqual(received.map((m) => m.text), ['new']);
    assert.equal(await store.getState('imessage', 'cursor'), '2');
    reader.close();
  });

  it('pages through a backlog in order and resumes from the saved cursor after restart', async () => {
    const store = new MemoryStore();
    await store.setState('imessage', 'cursor', '0');
    for (let i = 1; i <= 5; i++) fake.message({ text: `m${i}`, from: '+15550001', chat: DM });

    const received: InboundMessage[] = [];
    const first = poller(store, received, 2);
    await first.p.poll();
    assert.deepEqual(received.map((m) => m.text), ['m1', 'm2', 'm3', 'm4', 'm5']);
    first.reader.close();

    fake.message({ text: 'm6', from: '+15550001', chat: DM });
    const second = poller(store, received, 2);
    await second.p.start();
    await second.p.stop();
    await second.p.poll();
    assert.deepEqual(received.map((m) => m.text).slice(5), ['m6'], 'restart resumes, no repeats');
    second.reader.close();
  });
});
