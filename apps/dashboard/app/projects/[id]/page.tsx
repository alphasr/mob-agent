import { projectPage } from '../../../src/auth/request.ts';
import { sharedDb } from '../../../src/db/connect.ts';
import { RANGES, formatCost, formatCount, formatDuration, parseRange } from '../../../src/views/format.ts';
import { getOverview } from '../../../src/views/overview.ts';
import { TimeChart } from './chart.tsx';

export default async function Overview({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { user } = await projectPage(id);
  const rangeParam = (await searchParams).range;
  const range = parseRange(typeof rangeParam === 'string' ? rangeParam : undefined);
  const { summary, buckets, bucket } = await getOverview(sharedDb(), user.id, id, range);
  const starts = buckets.map((b) => b.start);
  const errorRate = summary.turns ? summary.failed / summary.turns : 0;

  return (
    <>
      <form className="filters" method="get">
        <select name="range" defaultValue={range}>
          {Object.keys(RANGES).map((r) => (
            <option key={r} value={r}>
              Last {r}
            </option>
          ))}
        </select>
        <button type="submit">Apply</button>
      </form>

      <dl className="tiles">
        <Tile label="Turns" value={formatCount(summary.turns)} />
        <Tile
          label="Error rate"
          value={`${(errorRate * 100).toFixed(errorRate > 0 && errorRate < 0.01 ? 1 : 0)}%`}
          note={`${formatCount(summary.failed)} failed`}
        />
        <Tile label="Median duration" value={summary.p50 === null ? '—' : formatDuration(summary.p50)} />
        <Tile label="p95 duration" value={summary.p95 === null ? '—' : formatDuration(summary.p95)} />
        <Tile label="Tokens" value={formatCount(summary.tokens)} />
        <Tile label="Cost (estimate)" value={formatCost(summary.costUsd)} />
      </dl>

      {summary.turns === 0 ? (
        <p className="muted">
          No turns in the last {range}. Agents send them with <code>exporter()</code> from <code>@textagent/cloud</code>
          ; create a key in <a href={`/projects/${id}/settings`}>Settings</a>.
        </p>
      ) : (
        <>
          <TimeChart
            title="Turns"
            starts={starts}
            bucket={bucket}
            kind="columns"
            format="count"
            series={[
              { name: 'Succeeded', color: 'series-1', values: buckets.map((b) => b.turns - b.failed) },
              { name: 'Failed', color: 'critical', values: buckets.map((b) => b.failed) },
            ]}
          />
          <TimeChart
            title="Cost (estimate)"
            starts={starts}
            bucket={bucket}
            kind="columns"
            format="cost"
            series={[{ name: 'Cost', color: 'series-1', values: buckets.map((b) => b.costUsd) }]}
          />
          <TimeChart
            title="Turn duration"
            starts={starts}
            bucket={bucket}
            kind="lines"
            format="duration"
            series={[
              { name: 'Median', color: 'series-1', values: buckets.map((b) => b.p50) },
              { name: 'p95', color: 'series-2', values: buckets.map((b) => b.p95) },
            ]}
          />
        </>
      )}
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <small>{note}</small>}
      </dd>
    </div>
  );
}
