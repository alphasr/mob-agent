import { projectPage } from '../../../../src/auth/request.ts';
import { sharedDb } from '../../../../src/db/connect.ts';
import {
  RANGES,
  formatCost,
  formatCount,
  formatDuration,
  parseRange,
  shortHash,
} from '../../../../src/views/format.ts';
import { listChannels, listTurns } from '../../../../src/views/turns.ts';
import { LocalTime } from '../../../local-time.tsx';

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function TurnsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Search;
}) {
  const { id } = await params;
  const { user } = await projectPage(id);
  const search = await searchParams;
  const one = (key: string) => (typeof search[key] === 'string' ? search[key] : undefined);
  const range = parseRange(one('range'));
  const channel = one('channel') || undefined;
  const errorsOnly = one('errors') === '1';
  const cursor = one('cursor');

  const db = sharedDb();
  const [{ turns, next }, channels] = await Promise.all([
    listTurns(db, user.id, id, { range, ...(channel && { channel }), errorsOnly, ...(cursor && { cursor }) }),
    listChannels(db, user.id, id, range),
  ]);
  const query = (more: Record<string, string>) =>
    `?${new URLSearchParams({ range, ...(channel && { channel }), ...(errorsOnly && { errors: '1' }), ...more })}`;

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
        <select name="channel" defaultValue={channel ?? ''}>
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" name="errors" value="1" defaultChecked={errorsOnly} /> Errors only
        </label>
        <button type="submit">Apply</button>
      </form>

      {turns.length === 0 ? (
        <section className="empty">
          <p>No turns {cursor ? 'on this page' : `in the last ${range}`}.</p>
          <p className="muted">
            Agents send turns with <code>exporter()</code> from <code>@textagent/cloud</code>; create a key in Settings
            and set <code>TEXTAGENT_INGEST_URL</code>, <code>TEXTAGENT_KEY</code> and <code>TEXTAGENT_HASH_SECRET</code>{' '}
            (or run <code>npx textagent create --dashboard</code>).
          </p>
        </section>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Channel</th>
              <th>Conversation</th>
              <th className="num">Duration</th>
              <th className="num">Spans</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => (
              <tr key={t.id} className={t.error ? 'failed' : undefined}>
                <td>
                  <a href={`/projects/${id}/turns/${encodeURIComponent(t.id)}`}>
                    <LocalTime iso={t.startedAt.toISOString()} />
                  </a>
                </td>
                <td>{t.channel}</td>
                <td>
                  <a href={`/projects/${id}/conversations/${t.conversation}`}>
                    <code>{shortHash(t.conversation)}</code>
                  </a>
                </td>
                <td className="num">{formatDuration(t.durationMs)}</td>
                <td className="num">{t.spanCount}</td>
                <td className="num">{formatCount(t.tokens)}</td>
                <td className="num">{formatCost(t.costUsd)}</td>
                <td className="error">{t.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="pager">
        {cursor && <a href={query({})}>← Newest</a>} {next && <a href={query({ cursor: next })}>Older →</a>}
      </p>
    </>
  );
}
