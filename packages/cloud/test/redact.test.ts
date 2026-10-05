import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboundMessage, TimedAgentEvent, TurnTrace } from '@textagent/core';
import { hasher, redactMessage, redactTrace } from '../src/index.ts';

const SECRET = 's'.repeat(32);
const hash = hasher(SECRET);
const PHONE = '+15551234567';

function trace(): TurnTrace {
  return {
    id: 'turn-1',
    conversation: `imessage\u0000${PHONE}\u0000${PHONE}`,
    channel: 'imessage',
    threadId: PHONE,
    startedAt: new Date('2026-10-05T12:00:00Z'),
    durationMs: 1200,
    messageIds: ['m1', 'm2'],
    sentCount: 1,
    spans: [
      {
        id: 'span-1',
        name: 'claude',
        startMs: 3,
        durationMs: 900,
        attributes: { tool: 'lookup', customer: PHONE },
        usage: [{ model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 20 }],
      },
      { id: 'span-2', parent: 'span-1', name: 'tool', startMs: 10, durationMs: 5, attributes: {}, truncated: true },
    ],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.0008,
    error: 'boom',
  };
}

function inbound(): InboundMessage {
  return {
    id: 'msg-1',
    channel: 'imessage',
    thread: { id: PHONE, channel: 'imessage', isGroup: false },
    sender: { id: PHONE, name: 'Ada Lovelace' },
    text: 'hello',
    attachments: [{ kind: 'image', filename: 'passport.jpg', uri: '/Users/ada/passport.jpg' }],
    timestamp: new Date('2026-10-05T12:00:00Z'),
    raw: { secret: 'channel payload' },
  };
}

describe('hasher', () => {
  it('is stable for one secret and differs across secrets', () => {
    assert.equal(hash(PHONE), hasher(SECRET)(PHONE));
    assert.notEqual(hash(PHONE), hasher('t'.repeat(32))(PHONE));
    assert.notEqual(hash(PHONE), hash('+15551234568'));
    assert.match(hash(PHONE), /^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects short secrets', () => {
    assert.throws(() => hasher('too short'), /at least 32 characters/);
  });
});

describe('redactTrace', () => {
  it('hashes every id that can name a person and leaves the rest', () => {
    const t = trace();
    const out = redactTrace(t, hash, true);
    assert.equal(out.conversation, hash(t.conversation));
    assert.equal(out.threadId, hash(PHONE));
    assert.deepEqual(out.messageIds, [hash('m1'), hash('m2')]);
    assert.equal(out.startedAt, '2026-10-05T12:00:00.000Z');
    assert.equal(out.id, 'turn-1');
    assert.equal(out.channel, 'imessage');
    assert.deepEqual(out.usage, t.usage);
    assert.equal(out.error, 'boom');
    assert.equal(out.spans[1]!.parent, 'span-1');
    assert.equal(out.spans[1]!.truncated, true);
  });

  it('never sends the raw phone number except in attributes the developer chose to keep', () => {
    const withAttributes = JSON.stringify(redactTrace(trace(), hash, true));
    assert.equal(withAttributes.split(PHONE).length - 1, 1); // only spans[0].attributes.customer
    assert.ok(!JSON.stringify(redactTrace(trace(), hash, false)).includes(PHONE));
  });

  it('strips attributes and the truncation flag with attributes off', () => {
    const out = redactTrace(trace(), hash, false);
    assert.deepEqual(out.spans[0]!.attributes, {});
    assert.equal(out.spans[1]!.truncated, undefined);
    assert.deepEqual(out.spans[0]!.usage, trace().spans[0]!.usage);
  });

  it('round-trips through JSON without undefined fields', () => {
    const out = redactTrace(trace(), hash, true);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    assert.ok(!('unpricedModels' in out) && !('droppedSpans' in out));
  });
});

describe('redactMessage', () => {
  const at = new Date('2026-10-05T12:00:01Z');

  it('hashes ids of received messages and keeps only the attachment count', () => {
    const out = redactMessage({ type: 'message.received', message: inbound(), at }, hash);
    assert.deepEqual(out, {
      direction: 'in',
      id: hash('msg-1'),
      channel: 'imessage',
      threadId: hash(PHONE),
      senderId: hash(PHONE),
      text: 'hello',
      attachments: 1,
      at: '2026-10-05T12:00:00.000Z',
    });
    const json = JSON.stringify(out);
    for (const leak of [PHONE, 'Ada', 'passport', 'channel payload']) assert.ok(!json.includes(leak), leak);
  });

  it('links sent messages to the trace by thread hash', () => {
    const event: TimedAgentEvent = {
      type: 'message.sent',
      message: { id: 'out-1', channel: 'imessage', threadId: PHONE },
      text: 'hi there',
      part: 1,
      parts: 1,
      proactive: true,
      at,
    };
    assert.deepEqual(redactMessage(event, hash), {
      direction: 'out',
      id: hash('out-1'),
      channel: 'imessage',
      threadId: redactTrace(trace(), hash, false).threadId,
      text: 'hi there',
      at: '2026-10-05T12:00:01.000Z',
      proactive: true,
    });
  });

  it('ignores other events', () => {
    assert.equal(redactMessage({ type: 'channel.started', channel: 'imessage', at }, hash), undefined);
  });
});
