import type { Range } from './format.ts';

/** Chart geometry shared by the pages; pure, so it is unit-tested. */

/** Round tick values from 0 to at least `max`: steps of 1, 2 or 5 × 10ⁿ, about `target` of them. */
export function niceTicks(max: number, target = 5): number[] {
  if (!(max > 0)) return [0];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough)!; // 10 × magnitude ≥ rough always
  const ticks: number[] = [];
  // i × step, not repeated addition, so 0.1 steps don't drift to 0.30000000000000004.
  for (let i = 0; ; i++) {
    const tick = Number((i * step).toPrecision(12));
    ticks.push(tick);
    if (tick >= max) return ticks;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Hourly buckets for a day, daily ones for longer ranges; all aligned to UTC. */
export function bucketSize(range: Range): 'hour' | 'day' {
  return range === '24h' ? 'hour' : 'day';
}

/**
 * Every bucket from the one containing `now - span` to the one containing `now`, so quiet hours show as
 * zero instead of disappearing. `rows` are keyed by bucket start (ms); missing buckets get `empty`.
 */
export function fillBuckets<T>(
  rows: Map<number, T>,
  size: 'hour' | 'day',
  spanMs: number,
  now: Date,
  empty: () => T,
): Array<{ start: number; value: T }> {
  const step = size === 'hour' ? HOUR : DAY;
  const floor = (ms: number) => ms - (((ms % step) + step) % step);
  const buckets: Array<{ start: number; value: T }> = [];
  for (let start = floor(now.getTime() - spanMs); start <= floor(now.getTime()); start += step) {
    buckets.push({ start, value: rows.get(start) ?? empty() });
  }
  return buckets;
}

/** Bar geometry: each bucket's band, the bar centred in it, at most 24px wide. */
export function band(index: number, count: number, width: number): { x: number; barWidth: number; center: number } {
  const slot = width / Math.max(count, 1);
  const barWidth = Math.max(Math.min(slot * 0.7, 24), 1);
  return { x: index * slot + (slot - barWidth) / 2, barWidth, center: index * slot + slot / 2 };
}

/** An SVG path through the points; a null breaks the line, so a bucket with no turns isn't drawn as zero. */
export function linePath(points: Array<{ x: number; y: number | null }>): string {
  let path = '';
  let drawing = false;
  for (const { x, y } of points) {
    if (y === null) {
      drawing = false;
      continue;
    }
    path += `${drawing ? 'L' : 'M'}${round(x)},${round(y)}`;
    drawing = true;
  }
  return path;
}

/** Index of the bucket under a pointer at `x` (plot coordinates), clamped to the data. */
export function nearestIndex(x: number, count: number, width: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(Math.floor((x / width) * count), 0), count - 1);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A column rising from `baseline` with only its top corners rounded (square where it meets the axis). */
export function columnPath(x: number, top: number, width: number, baseline: number, radius = 4): string {
  const height = baseline - top;
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  return (
    `M${round(x)},${round(baseline)}V${round(top + r)}` +
    `Q${round(x)},${round(top)} ${round(x + r)},${round(top)}H${round(x + width - r)}` +
    `Q${round(x + width)},${round(top)} ${round(x + width)},${round(top + r)}V${round(baseline)}Z`
  );
}
