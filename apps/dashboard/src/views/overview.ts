import { and, eq, gte, sql } from 'drizzle-orm';
import { requireMember } from '../auth/members.ts';
import type { Db } from '../db/db.ts';
import { traces } from '../db/schema.ts';
import { RANGES } from './format.ts';
import type { Range } from './format.ts';
import { bucketSize, fillBuckets } from './scale.ts';

export interface Summary {
  turns: number;
  failed: number;
  /** Turn duration percentiles in ms; null with no turns. */
  p50: number | null;
  p95: number | null;
  tokens: number;
  costUsd: number;
}

export interface Bucket {
  /** UTC start, ms since the epoch. */
  start: number;
  turns: number;
  failed: number;
  costUsd: number;
  /** Null for a bucket with no turns: there is no latency to plot. */
  p50: number | null;
  p95: number | null;
}

const p50 = sql<number | null>`percentile_cont(0.5) within group (order by ${traces.durationMs})`;
const p95 = sql<number | null>`percentile_cont(0.95) within group (order by ${traces.durationMs})`;
const asNumber = (value: unknown) => (value === null ? null : Number(value));

/** Headline numbers and per-bucket series for one project and range; aggregated in SQL. */
export async function getOverview(
  db: Db,
  userId: string,
  projectId: string,
  range: Range,
  now: Date = new Date(),
): Promise<{ summary: Summary; buckets: Bucket[]; bucket: 'hour' | 'day' }> {
  await requireMember(db, userId, projectId);
  const scope = and(eq(traces.projectId, projectId), gte(traces.startedAt, new Date(now.getTime() - RANGES[range])));
  const size = bucketSize(range);
  // Epoch milliseconds of the UTC bucket: a plain timestamp would be read in the server's local timezone.
  // The unit is inlined (it is 'hour' or 'day' from code, never input): as a parameter, the SELECT and the
  // GROUP BY copies get different placeholders and Postgres refuses to treat them as the same expression.
  const start = sql<number>`extract(epoch from date_trunc(${sql.raw(`'${size}'`)}, ${traces.startedAt} at time zone 'UTC')) * 1000`;

  const [totals, rows] = await Promise.all([
    db
      .select({
        turns: sql<number>`count(*)`.mapWith(Number),
        failed: sql<number>`count(${traces.error})`.mapWith(Number),
        p50,
        p95,
        tokens: sql<number>`coalesce(sum(${traces.inputTokens} + ${traces.outputTokens}), 0)`.mapWith(Number),
        costUsd: sql<number>`coalesce(sum(${traces.costUsd}), 0)`.mapWith(Number),
      })
      .from(traces)
      .where(scope),
    db
      .select({
        start: start.mapWith(Number),
        turns: sql<number>`count(*)`.mapWith(Number),
        failed: sql<number>`count(${traces.error})`.mapWith(Number),
        costUsd: sql<number>`sum(${traces.costUsd})`.mapWith(Number),
        p50,
        p95,
      })
      .from(traces)
      .where(scope)
      .groupBy(start),
  ]);

  const summary = totals[0]!; // an aggregate without GROUP BY always returns one row
  const byStart = new Map(rows.map((r) => [r.start, { ...r, p50: asNumber(r.p50), p95: asNumber(r.p95) }]));
  const buckets = fillBuckets(byStart, size, RANGES[range], now, () => null).map(
    ({ start, value }): Bucket => value ?? { start, turns: 0, failed: 0, costUsd: 0, p50: null, p95: null },
  );
  return { summary: { ...summary, p50: asNumber(summary.p50), p95: asNumber(summary.p95) }, buckets, bucket: size };
}
