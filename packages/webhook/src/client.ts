import { SIGNATURE_HEADER, signBody } from '@textagent/core';
import type { TurnAction } from './protocol.ts';

export interface ReplyClientOptions {
  /** The agent's reply endpoint (`turn.replyUrl` from a payload). */
  url: string;
  secret: string;
}

/** For webhook receivers written in Node: signed calls to the agent's reply endpoint. */
export function replyClient({ url, secret }: ReplyClientOptions) {
  async function send(action: TurnAction): Promise<{ messageIds?: string[] }> {
    const body = JSON.stringify(action);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(secret, body) },
      body,
    });
    const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; messageIds?: string[] };
    if (!response.ok || !result.ok) {
      throw new Error(`textagent ${action.action} failed (${response.status}): ${result.error ?? response.statusText}`);
    }
    return result.messageIds ? { messageIds: result.messageIds } : {};
  }

  return {
    reply: (turn: string, text: string, options: { final?: boolean } = {}) =>
      send({ turn, action: 'reply', text, ...(options.final === false && { final: false }) }),
    typing: (turn: string) => send({ turn, action: 'typing' }),
    close: (turn: string) => send({ turn, action: 'close' }),
  };
}
