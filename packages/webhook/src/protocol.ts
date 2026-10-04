import type { Attachment, Participant, Thread } from '@textagent/core';

/**
 * The wire format, shared by the agent and receivers. Every request in either direction
 * carries a `textagent-signature` header over the raw body (see `signBody` in core).
 */

/** POSTed to your webhook URL for each conversation turn. Answer 2xx right away; reply later. */
export interface TurnPayload {
  type: 'turn';
  turn: {
    id: string;
    /** After this, replies are rejected and the conversation moves on. */
    expiresAt: string;
    /** Where to POST `TurnAction`s, when the agent knows its public URL. */
    replyUrl?: string;
  };
  channel: string;
  thread: Thread;
  sender: Participant;
  /** This turn's messages, oldest first (several when the user sent a quick burst). */
  messages: Array<{ id: string; text: string; attachments: Attachment[]; timestamp: string }>;
  /** Earlier conversation, oldest first, not including this turn's messages. */
  history: Array<{ role: 'user' | 'agent'; text: string; senderId?: string; timestamp: string }>;
}

/** POSTed by your server to the agent's reply endpoint. */
export type TurnAction =
  /** Send a message. The turn ends unless `final` is false. */
  | { turn: string; action: 'reply'; text: string; final?: boolean }
  /** Show a typing indicator where the channel has one. */
  | { turn: string; action: 'typing' }
  /** End the turn without (further) replies. */
  | { turn: string; action: 'close' };

const MAX_REPLY_CHARS = 64 * 1024;

/** Validate an untrusted (though signed) action body. Returns an error message for anything malformed. */
export function parseAction(value: unknown): TurnAction | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Body must be a JSON object';
  const body = value as Record<string, unknown>; // narrowed to a non-null, non-array object above
  if (typeof body.turn !== 'string' || !body.turn) return '"turn" must be the turn id';

  switch (body.action) {
    case 'reply':
      if (typeof body.text !== 'string' || !body.text.trim()) return '"text" must be a non-empty string';
      if (body.text.length > MAX_REPLY_CHARS) return `"text" is over ${MAX_REPLY_CHARS} characters`;
      if (body.final !== undefined && typeof body.final !== 'boolean') return '"final" must be a boolean';
      return { turn: body.turn, action: 'reply', text: body.text, ...(body.final === false && { final: false }) };
    case 'typing':
    case 'close':
      return { turn: body.turn, action: body.action };
    default:
      return '"action" must be "reply", "typing" or "close"';
  }
}
