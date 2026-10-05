import { notFound } from 'next/navigation';
import { projectPage } from '../../../../../src/auth/request.ts';
import { sharedDb } from '../../../../../src/db/connect.ts';
import { formatCost, formatCount, formatDuration, shortHash } from '../../../../../src/views/format.ts';
import { getTurn } from '../../../../../src/views/turns.ts';
import { LocalTime } from '../../../../local-time.tsx';
import { MessageList } from '../../messages.tsx';
import { Waterfall } from './waterfall.tsx';

export default async function TurnPage({ params }: { params: Promise<{ id: string; turnId: string }> }) {
  const { id, turnId } = await params;
  const { user, project } = await projectPage(id);
  const result = await getTurn(sharedDb(), user.id, id, decodeURIComponent(turnId));
  if (!result) notFound();
  const { turn, messages } = result;
  const spansWithAttributes = turn.spans.filter((s) => Object.keys(s.attributes).length > 0);

  return (
    <>
      <p>
        <a href={`/projects/${id}/turns`}>← Turns</a>
      </p>
      <h2>
        Turn <LocalTime iso={turn.startedAt.toISOString()} />
      </h2>
      <ul className="facts">
        <li>
          <span>Channel</span> {turn.channel}
        </li>
        <li>
          <span>Conversation</span>{' '}
          <a href={`/projects/${id}/conversations/${turn.conversation}`}>
            <code>{shortHash(turn.conversation)}</code>
          </a>
        </li>
        <li>
          <span>Duration</span> {formatDuration(turn.durationMs)}
        </li>
        <li>
          <span>Messages</span> {turn.messageIds.length} in, {turn.sentCount} sent
        </li>
        <li>
          <span>Tokens</span> {formatCount(turn.inputTokens)} in, {formatCount(turn.outputTokens)} out
          {turn.cacheReadTokens + turn.cacheWriteTokens > 0 &&
            `, ${formatCount(turn.cacheReadTokens)} cache read, ${formatCount(turn.cacheWriteTokens)} cache write`}
        </li>
        <li>
          <span>Cost (estimate)</span> {formatCost(turn.costUsd)}
          {turn.unpricedModels?.length ? ` + unpriced: ${turn.unpricedModels.join(', ')}` : ''}
        </li>
      </ul>
      {turn.error && <p className="error">✖ Handler failed: {turn.error}</p>}

      <h3>Spans</h3>
      {turn.spans.length === 0 ? (
        <p className="muted">
          No spans recorded. Wrap model and tool calls in <code>ctx.trace.span()</code> to see them here.
        </p>
      ) : (
        <>
          <Waterfall spans={turn.spans} turnDurationMs={turn.durationMs} />
          {turn.droppedSpans ? (
            <p className="muted">{turn.droppedSpans} more spans were over the limit of 50.</p>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>Span</th>
                <th className="num">Starts at</th>
                <th className="num">Duration</th>
                <th>Model usage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {turn.spans.map((s) => (
                <tr key={s.id} className={s.error ? 'failed' : undefined}>
                  <td>{s.name}</td>
                  <td className="num">{formatDuration(s.startMs)}</td>
                  <td className="num">{formatDuration(s.durationMs)}</td>
                  <td>
                    {(s.usage ?? []).map((u, i) => (
                      <div key={i}>
                        {u.model}: {formatCount(u.inputTokens)} in, {formatCount(u.outputTokens)} out
                      </div>
                    ))}
                  </td>
                  <td className={s.error ? 'error' : undefined}>
                    {s.error ? `✖ ${s.error}` : s.unfinished ? 'unfinished' : 'ok'}
                    {s.truncated ? ' · attributes truncated' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {spansWithAttributes.length > 0 && (
        <>
          <h3>Attributes</h3>
          {spansWithAttributes.map((s) => (
            <details key={s.id}>
              <summary>{s.name}</summary>
              <pre>{JSON.stringify(s.attributes, null, 2)}</pre>
            </details>
          ))}
        </>
      )}

      <h3>Messages</h3>
      <MessageList messages={messages} storeText={project.storeText} empty="No message text for this turn." />
    </>
  );
}
