import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { requireMember } from '../auth/members.ts';
import type { Db } from '../db/db.ts';
import { messages, traces } from '../db/schema.ts';
import type { TurnMessage, TurnRow } from './turns.ts';

export const MAX_TURNS = 200;
export const MAX_MESSAGES = 500;
const HASH = /^[A-Za-z0-9_-]{43}$/;

export interface Conversation {
  channel: string;
  totals: { turns: number; failed: number; tokens: number; costUsd: number; first: Date; last: Date };
  /** Newest first, at most MAX_TURNS. */
  turns: TurnRow[];
  /** The thread's messages, oldest first: the newest MAX_MESSAGES, when the project stores text. */
  messages: TurnMessage[];
}

/**
 * One conversation (a hashed sender in a hashed thread) within a project. The same hash can exist in
 * another project that shares a hash secret, so every query is scoped to this project.
 */
export async function getConversation(
  db: Db,
  userId: string,
  projectId: string,
  conversation: string,
): Promise<Conversation | undefined> {
  await requireMember(db, userId, projectId);
  if (!HASH.test(conversation)) return undefined;
  const scope = and(eq(traces.projectId, projectId), eq(traces.conversation, conversation));

  const [[totals], turns] = await Promise.all([
    db
      .select({
        turns: sql<number>`count(*)`.mapWith(Number),
        failed: sql<number>`count(${traces.error})`.mapWith(Number),
        tokens: sql<number>`coalesce(sum(${traces.inputTokens} + ${traces.outputTokens}), 0)`.mapWith(Number),
        costUsd: sql<number>`coalesce(sum(${traces.costUsd}), 0)`.mapWith(Number),
        first: sql<Date>`min(${traces.startedAt})`.mapWith(traces.startedAt),
        last: sql<Date>`max(${traces.startedAt})`.mapWith(traces.startedAt),
      })
      .from(traces)
      .where(scope),
    db
      .select({
        id: traces.id,
        startedAt: traces.startedAt,
        channel: traces.channel,
        conversation: traces.conversation,
        threadId: traces.threadId,
        durationMs: traces.durationMs,
        tokens: sql<number>`${traces.inputTokens} + ${traces.outputTokens}`.mapWith(Number),
        costUsd: traces.costUsd,
        sentCount: traces.sentCount,
        spanCount: sql<number>`jsonb_array_length(${traces.spans})`.mapWith(Number),
        error: traces.error,
      })
      .from(traces)
      .where(scope)
      .orderBy(desc(traces.startedAt), desc(traces.id))
      .limit(MAX_TURNS),
  ]);
  const newest = turns[0];
  if (!totals || !newest) return undefined;

  const thread = await db
    .select({
      direction: messages.direction,
      text: messages.text,
      at: messages.at,
      attachments: messages.attachments,
      proactive: messages.proactive,
    })
    .from(messages)
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.channel, newest.channel),
        eq(messages.threadId, newest.threadId),
      ),
    )
    .orderBy(desc(messages.at))
    .limit(MAX_MESSAGES);

  return {
    channel: newest.channel,
    totals,
    turns: turns.map(({ threadId: _, ...turn }) => turn),
    messages: thread.reverse(),
  };
}
