import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { describe, it } from 'node:test';
import { formatEvent } from '../src/index.ts';
import type { InboundMessage, TimedAgentEvent } from '../src/index.ts';

const at = new Date(2026, 9, 4, 12, 0, 1);
const message: InboundMessage = {
  id: 'm1',
  channel: 'telegram',
  thread: { id: '42', channel: 'telegram', isGroup: false },
  sender: { id: '42', name: 'Ada' },
  text: 'what are\nyour hours?',
  attachments: [],
  timestamp: at,
  raw: null,
};
const line = (e: TimedAgentEvent, opts = {}) => {
  const out = formatEvent(e, opts);
  return out === undefined ? undefined : stripVTControlCharacters(out);
};

describe('formatEvent', () => {
  it('prints one readable line per message in and out', () => {
    assert.equal(line({ type: 'message.received', message, at }), '12:00:01 ← telegram Ada (42) "what are your hours?"');
    assert.equal(
      line({ type: 'message.sent', message: { id: 'o1', channel: 'telegram', threadId: '42' }, text: '9 to 5', part: 1, parts: 2, at }),
      '12:00:01 → telegram 42 [1/2] "9 to 5"',
    );
    assert.equal(line({ type: 'message.filtered', message, reason: 'not-allowed', at }), '12:00:01 ⊘ telegram 42 ignored (not-allowed)');
  });

  it('can hide message text, and hides timings unless verbose', () => {
    assert.equal(line({ type: 'message.received', message, at }, { showText: false }), '12:00:01 ← telegram Ada (42)');
    const timing: TimedAgentEvent = { type: 'handler.finished', conversation: 'c', durationMs: 12.4, at };
    assert.equal(line(timing), undefined);
    assert.equal(line(timing, { verbose: true }), '12:00:01 ✓ handled in 12ms');
  });

  it('shows errors with their message', () => {
    assert.equal(line({ type: 'channel.error', channel: 'email', error: new Error('IMAP login failed'), at }), '12:00:01 ✖ email: IMAP login failed');
  });
});
