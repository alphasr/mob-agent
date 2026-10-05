import { notFound } from 'next/navigation';
import { projectPage } from '../../../../../src/auth/request.ts';
import { sharedDb } from '../../../../../src/db/connect.ts';
import { MAX_TURNS, getConversation } from '../../../../../src/views/conversations.ts';
import { formatCost, formatCount, formatDuration, shortHash } from '../../../../../src/views/format.ts';
import { LocalTime } from '../../../../local-time.tsx';
import { MessageList } from '../../messages.tsx';

export default async function ConversationPage({ params }: { params: Promise<{ id: string; hash: string }> }) {
  const { id, hash } = await params;
  const { user, project } = await projectPage(id);
  const conversation = await getConversation(sharedDb(), user.id, id, hash);
  if (!conversation) notFound();
  const { channel, totals, turns, messages } = conversation;

  return (
    <>
      <p>
        <a href={`/projects/${id}/turns`}>← Turns</a>
      </p>
      <h2>
        Conversation <code>{shortHash(hash)}</code>
      </h2>
      <p className="muted">
        Sender and thread are hashed before they leave the agent, so who this is stays unknown here.
      </p>
      <ul className="facts">
        <li>
          <span>Channel</span> {channel}
        </li>
        <li>
          <span>Turns</span> {formatCount(totals.turns)}
          {totals.failed > 0 && `, ${formatCount(totals.failed)} failed`}
        </li>
        <li>
          <span>Tokens</span> {formatCount(totals.tokens)}
        </li>
        <li>
          <span>Cost (estimate)</span> {formatCost(totals.costUsd)}
        </li>
        <li>
          <span>First</span> <LocalTime iso={totals.first.toISOString()} />
        </li>
        <li>
          <span>Last</span> <LocalTime iso={totals.last.toISOString()} />
        </li>
      </ul>

      <h3>Turns</h3>
      {totals.turns > MAX_TURNS && <p className="muted">Showing the newest {MAX_TURNS}.</p>}
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th className="num">Duration</th>
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
              <td className="num">{formatDuration(t.durationMs)}</td>
              <td className="num">{formatCount(t.tokens)}</td>
              <td className="num">{formatCost(t.costUsd)}</td>
              <td className="error">{t.error}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Messages in this thread</h3>
      <MessageList messages={messages} storeText={project.storeText} empty="No message text in this thread." />
    </>
  );
}
