import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeNow, formatTime, isTimezone, parseTime } from '../templates/time.ts';

describe('time.ts', () => {
  it('round-trips local times and rejects times that do not exist', () => {
    const london = 'Europe/London';
    const t = Date.parse('2026-10-06T08:30:00Z');
    assert.equal(formatTime(t, london), 'Tue 2026-10-06 09:30');
    assert.equal(parseTime('Tue 2026-10-06 09:30', london), t);
    assert.equal(parseTime('2026-10-06 09:30', london), t);
    assert.equal(parseTime('2026-02-30 09:30', london), undefined);
    assert.equal(parseTime('2026-10-06 24:00', london), undefined);
    assert.equal(parseTime('2027-03-28 01:30', london), undefined, 'skipped when clocks go forward');
    assert.equal(parseTime('tomorrow at 9', london), undefined);
  });

  it('converts correctly on both sides of a DST change west of UTC', () => {
    // The naive guess lands on the other side of the change; the second pass corrects it.
    const newYork = 'America/New_York';
    assert.equal(new Date(parseTime('2026-11-01 03:00', newYork)!).toISOString(), '2026-11-01T08:00:00.000Z');
    assert.equal(new Date(parseTime('2026-03-08 03:30', newYork)!).toISOString(), '2026-03-08T07:30:00.000Z');
    assert.equal(
      new Date(parseTime('2026-10-06 09:00', 'America/St_Johns')!).toISOString(),
      '2026-10-06T11:30:00.000Z',
    );
  });

  it('describes now for the system prompt and checks timezone names', () => {
    assert.equal(
      describeNow('Asia/Kolkata', Date.parse('2026-10-05T12:10:00Z')),
      'It is now Mon 2026-10-05 17:40 (Asia/Kolkata).',
    );
    assert.equal(isTimezone('Europe/London'), true);
    assert.equal(isTimezone('Europe/Londn'), false);
  });
});
