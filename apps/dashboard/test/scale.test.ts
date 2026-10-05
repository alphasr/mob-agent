import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { band, bucketSize, columnPath, fillBuckets, linePath, nearestIndex } from '../src/views/scale.ts';

const HOUR = 3_600_000;

describe('fillBuckets', () => {
  it('covers the range in UTC hours, filling quiet hours with the empty value', () => {
    const now = new Date('2026-10-05T12:30:00Z');
    const start = Date.parse('2026-10-05T10:00:00Z');
    const buckets = fillBuckets(new Map([[start + HOUR, 7]]), 'hour', 2 * HOUR, now, () => 0);
    assert.deepEqual(
      buckets.map((b) => [new Date(b.start).toISOString().slice(11, 16), b.value]),
      [
        ['10:00', 0],
        ['11:00', 7],
        ['12:00', 0],
      ],
    );
  });

  it('has 25 hourly buckets for 24h (the first partial) and 8 daily ones for 7d', () => {
    const now = new Date('2026-10-05T12:30:00Z');
    assert.equal(fillBuckets(new Map(), 'hour', 24 * HOUR, now, () => 0).length, 25);
    const days = fillBuckets(new Map(), 'day', 7 * 24 * HOUR, now, () => 0);
    assert.equal(days.length, 8);
    assert.equal(new Date(days[0]!.start).toISOString(), '2026-09-28T00:00:00.000Z');
  });

  it('picks hourly buckets for a day and daily ones beyond', () => {
    assert.equal(bucketSize('24h'), 'hour');
    assert.equal(bucketSize('7d'), 'day');
    assert.equal(bucketSize('30d'), 'day');
  });
});

describe('band', () => {
  it('centres bars in their slot and caps them at 24px', () => {
    assert.deepEqual(band(0, 10, 1000), { x: 38, barWidth: 24, center: 50 });
    const narrow = band(3, 25, 500);
    assert.equal(narrow.barWidth, 14);
    assert.equal(narrow.center, 70);
  });
});

describe('linePath', () => {
  it('breaks the line at missing values instead of dropping to zero', () => {
    assert.equal(
      linePath([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
        { x: 20, y: null },
        { x: 30, y: 5 },
        { x: 40, y: 6.25 },
      ]),
      'M0,10L10,20M30,5L40,6.3',
    );
    assert.equal(linePath([{ x: 0, y: null }]), '');
  });
});

describe('nearestIndex', () => {
  it('maps a pointer position to its bucket, clamped to the data', () => {
    assert.equal(nearestIndex(0, 10, 100), 0);
    assert.equal(nearestIndex(55, 10, 100), 5);
    assert.equal(nearestIndex(100, 10, 100), 9);
    assert.equal(nearestIndex(-20, 10, 100), 0);
    assert.equal(nearestIndex(10, 0, 100), -1);
  });
});

describe('columnPath', () => {
  it('rounds only the top corners, shrinking the radius for tiny bars, and draws nothing for zero', () => {
    assert.equal(columnPath(10, 50, 20, 100), 'M10,100V54Q10,50 14,50H26Q30,50 30,54V100Z');
    assert.equal(columnPath(10, 98, 20, 100), 'M10,100V100Q10,98 12,98H28Q30,98 30,100V100Z');
    assert.equal(columnPath(10, 100, 20, 100), '');
  });
});
