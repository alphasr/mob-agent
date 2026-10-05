import type { TurnMessage } from '../../../src/views/turns.ts';
import { LocalTime } from '../../local-time.tsx';

/** Message text as plain, escaped text, or why there is none. */
export function MessageList({
  messages,
  storeText,
  empty,
}: {
  messages: TurnMessage[];
  storeText: boolean;
  empty: string;
}) {
  if (!storeText) return <p className="muted">This project doesn't store message text (Settings).</p>;
  if (messages.length === 0) {
    return (
      <p className="muted">
        {empty} Agents send it with <code>exporter({'{ includeText: true }'})</code>.
      </p>
    );
  }
  return (
    <ul className="messages">
      {messages.map((m, i) => (
        <li key={i} className={m.direction}>
          <span className="muted">
            {m.direction === 'in' ? '← received' : m.proactive ? '→ sent (proactive)' : '→ sent'}{' '}
            <LocalTime iso={m.at.toISOString()} />
            {m.attachments ? ` · ${m.attachments} attachment(s)` : ''}
          </span>
          <p>{m.text}</p>
        </li>
      ))}
    </ul>
  );
}
