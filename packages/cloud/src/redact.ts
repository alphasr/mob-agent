import { createHmac } from 'node:crypto';
import type { SpanRecord, TimedAgentEvent, TurnTrace } from '@textagent/core';
import type { ExportedMessage, ExportedSpan, ExportedTrace } from './protocol.ts';

/** Phone numbers are guessable, so the secret must be too long to guess instead. */
export const MIN_SECRET_LENGTH = 32;

export type Hash = (id: string) => string;

/** HMAC-SHA256 under the project's hash secret, base64url. The secret never leaves the machine. */
export function hasher(secret: string): Hash {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`The hash secret must be at least ${MIN_SECRET_LENGTH} characters (set TEXTAGENT_HASH_SECRET)`);
  }
  return (id) => createHmac('sha256', secret).update(id).digest('base64url');
}

/**
 * Fields are copied one by one, never spread: a field added to `TurnTrace` or `SpanRecord` is a
 * compile error here until someone decides whether it may leave the machine.
 */
export function redactTrace(trace: TurnTrace, hash: Hash, keepAttributes: boolean): ExportedTrace {
  const {
    id,
    conversation,
    channel,
    threadId,
    startedAt,
    durationMs,
    messageIds,
    sentCount,
    spans,
    usage,
    costUsd,
    unpricedModels,
    droppedSpans,
    error,
    ...unhandled
  } = trace;
  const allHandled: Record<string, never> = unhandled;
  void allHandled;

  return {
    id,
    conversation: hash(conversation),
    channel,
    threadId: hash(threadId),
    startedAt: startedAt.toISOString(),
    durationMs,
    messageIds: messageIds.map(hash),
    sentCount,
    spans: spans.map((span) => redactSpan(span, keepAttributes)),
    usage,
    costUsd,
    ...(unpricedModels && { unpricedModels }),
    ...(droppedSpans !== undefined && { droppedSpans }),
    ...(error !== undefined && { error }),
  };
}

function redactSpan(span: SpanRecord, keepAttributes: boolean): ExportedSpan {
  const { id, parent, name, startMs, durationMs, attributes, usage, error, unfinished, truncated, ...unhandled } = span;
  const allHandled: Record<string, never> = unhandled;
  void allHandled;

  return {
    id,
    ...(parent !== undefined && { parent }),
    name,
    startMs,
    durationMs,
    attributes: keepAttributes ? attributes : {},
    ...(usage && { usage }),
    ...(error !== undefined && { error }),
    ...(unfinished && { unfinished }),
    ...(keepAttributes && truncated && { truncated }),
  };
}

/** The message text of a received or sent message event; undefined for every other event. */
export function redactMessage(event: TimedAgentEvent, hash: Hash): ExportedMessage | undefined {
  if (event.type === 'message.received') {
    const { message } = event;
    return {
      direction: 'in',
      id: hash(message.id),
      channel: message.channel,
      threadId: hash(message.thread.id),
      senderId: hash(message.sender.id),
      text: message.text,
      ...(message.attachments.length > 0 && { attachments: message.attachments.length }),
      at: message.timestamp.toISOString(),
    };
  }
  if (event.type === 'message.sent') {
    const { message } = event;
    return {
      direction: 'out',
      id: hash(message.id),
      channel: message.channel,
      threadId: hash(message.threadId),
      text: event.text,
      at: event.at.toISOString(),
      ...(event.proactive && { proactive: true }),
    };
  }
  return undefined;
}
