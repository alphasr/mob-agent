import { styleText } from 'node:util';
import type { EventListener } from './agent.ts';
import type { TimedAgentEvent } from './events.ts';

export interface LogOptions {
  /** Where lines go. Default: console.log */
  write?: (line: string) => void;
  /** Include message text. Turn off where logs are kept, since texts are private. Default: true */
  showText?: boolean;
  /** Also log handler start/finish timings. Default: false */
  verbose?: boolean;
  /** "pretty" for people (default), "json" for log shippers: one JSON object per line. */
  format?: 'pretty' | 'json';
}

/** A readable one-line-per-event log: `agent.on('event', logEvents())`. */
export function logEvents(options: LogOptions = {}): EventListener {
  const write = options.write ?? ((line: string) => console.log(line));
  if (options.format === 'json') {
    return (event) => write(eventToJson(event, options.showText ?? true));
  }
  return (event) => {
    const line = formatEvent(event, options);
    if (line) write(line);
  };
}

/** One line for an event, or undefined for events hidden at this verbosity. */
export function formatEvent(event: TimedAgentEvent, options: Omit<LogOptions, 'write'> = {}): string | undefined {
  const showText = options.showText ?? true;
  const time = styleText('dim', event.at.toTimeString().slice(0, 8));
  const quote = (text: string) => (showText ? ` ${JSON.stringify(truncate(text))}` : '');

  switch (event.type) {
    case 'channel.started':
      return `${time} ${styleText('green', '●')} ${event.channel} started`;
    case 'channel.stopped':
      return `${time} ${styleText('dim', '○')} ${event.channel} stopped`;
    case 'channel.error':
      return `${time} ${styleText('red', '✖')} ${event.channel}: ${errorText(event.error)}`;
    case 'store.error':
      return `${time} ${styleText('red', '✖')} store ${event.operation}: ${errorText(event.error)}`;
    case 'message.received': {
      const { message: m } = event;
      const who = m.sender.name ? `${m.sender.name} (${m.sender.id})` : m.sender.id;
      const files = m.attachments.length ? ` +${m.attachments.length} attachment(s)` : '';
      return `${time} ${styleText('cyan', '←')} ${m.channel} ${who}${quote(m.text)}${files}`;
    }
    case 'message.duplicate':
      return options.verbose ? `${time} ${styleText('dim', '·')} duplicate ${event.message.id} ignored` : undefined;
    case 'message.filtered':
      return `${time} ${styleText('yellow', '⊘')} ${event.message.channel} ${event.message.sender.id} ignored (${event.reason})`;
    case 'message.sent': {
      const part = event.parts > 1 ? ` [${event.part}/${event.parts}]` : '';
      return `${time} ${styleText('magenta', '→')} ${event.message.channel} ${event.message.threadId}${part}${quote(event.text)}`;
    }
    case 'handler.started':
      return options.verbose
        ? `${time} ${styleText('dim', '…')} handling ${event.messageIds.length} message(s)`
        : undefined;
    case 'handler.finished':
      return options.verbose
        ? `${time} ${styleText('dim', '✓')} handled in ${Math.round(event.durationMs)}ms`
        : undefined;
    case 'schedule.created':
      return `${time} ${styleText('blue', '⏰')} scheduled ${event.job.conversation} for ${event.job.at.toLocaleString()}`;
    case 'schedule.sent':
      return options.verbose ? `${time} ${styleText('blue', '⏰')} scheduled message ${event.job.id} sent` : undefined;
    case 'schedule.retrying':
      return `${time} ${styleText('yellow', '⏰')} scheduled message will retry: ${event.error}`;
    case 'schedule.failed':
    case 'schedule.expired':
      return `${time} ${styleText('red', '⏰')} scheduled message ${event.type.slice(9)}: ${event.error}`;
    case 'schedule.canceled':
      return `${time} ${styleText('dim', '⏰')} canceled ${'id' in event.by ? event.by.id : event.by.key}`;
    case 'handler.error':
      return `${time} ${styleText('red', '✖')} handler failed after ${Math.round(event.durationMs)}ms: ${errorText(event.error)}`;
    case 'turn.completed': {
      const t = event.trace;
      const tokens = t.usage.inputTokens + t.usage.outputTokens;
      const parts = [
        `${(t.durationMs / 1000).toFixed(1)}s`,
        `${t.spans.length} span${t.spans.length === 1 ? '' : 's'}`,
        ...(tokens ? [`${tokens.toLocaleString('en-US')} tokens`, `$${t.costUsd.toFixed(4)}`] : []),
      ];
      return `${time} ${styleText(t.error ? 'red' : 'green', '◆')} turn ${parts.join(' · ')}`;
    }
    default:
      return assertNever(event);
  }
}

/** Compile error if a new event type isn't handled above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled event ${JSON.stringify(value)}`);
}

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line of JSON per event. Errors become { name, message } (no stacks), channel payloads
 * (`raw`) are dropped, and with showText false every message text is blanked.
 */
export function eventToJson(event: TimedAgentEvent, showText = true): string {
  return JSON.stringify(event, (key, value: unknown) => {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (key === 'raw') return undefined;
    if (!showText && key === 'text' && typeof value === 'string') return '';
    return value;
  });
}
