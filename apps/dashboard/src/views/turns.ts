import { and, asc, between, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { requireMember } from '../auth/members.ts';
import type { Db } from '../db/db.ts';
import { messages, traces } from '../db/schema.ts';
import { RANGES } from './format.ts';
import type { Range } from './format.ts';

export const PAGE_SIZE = 50;

export interface TurnFilter {
  range: Range;
  channel?: string;
  errorsOnly?: boolean;
  /** From the previous page's `next`; untrusted, and ignored when malformed. */
  cursor?: string;
}

export interface TurnRow {
  id: string;
  startedAt: Date;
  channel: string;
  conversation: string;
  durationMs: number;
  tokens: number;
  costUsd: number;
  sentCount: number;
  spanCount: number;
  error: string | null;
}

/**
 * One page of a project's turns, newest first. Pages are cut by (started_at, id) rather than offset,
 * so turns arriving while someone reads don't shift or repeat rows.
 */
export async function listTurns(
  db: Db,
  userId: string,
  projectId: string,
  filter: TurnFilter,
  now: Date = new Date(),
): Promise<{ turns: TurnRow[]; next?: string }> {
  await requireMember(db, userId, projectId);
  const after = decodeCursor(filter.cursor);
  const rows = await db
    .select({
      id: traces.id,
      startedAt: traces.startedAt,
      channel: traces.channel,
      conversation: traces.conversation,
      durationMs: traces.durationMs,
      tokens: sql<number>`${traces.inputTokens} + ${traces.outputTokens}`.mapWith(Number),
      costUsd: traces.costUsd,
      sentCount: traces.sentCount,
      spanCount: sql<number>`jsonb_array_length(${traces.spans})`.mapWith(Number),
      error: traces.error,
    })
    .from(traces)
    .where(
      and(
        eq(traces.projectId, projectId),
        gte(traces.startedAt, new Date(now.getTime() - RANGES[filter.range])),
        filter.channel ? eq(traces.channel, filter.channel) : undefined,
        filter.errorsOnly ? isNotNull(traces.error) : undefined,
        after ? sql`(${traces.startedAt}, ${traces.id}) < (${after.at}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(traces.startedAt), desc(traces.id))
    .limit(PAGE_SIZE + 1);

  const turns = rows.slice(0, PAGE_SIZE);
  const last = turns.at(-1);
  return rows.length > PAGE_SIZE && last ? { turns, next: encodeCursor(last.startedAt, last.id) } : { turns };
}

/** Channels with turns in the range, for the filter. */
export async function listChannels(
  db: Db,
  userId: string,
  projectId: string,
  range: Range,
  now: Date = new Date(),
): Promise<string[]> {
  await requireMember(db, userId, projectId);
  const rows = await db
    .selectDistinct({ channel: traces.channel })
    .from(traces)
    .where(and(eq(traces.projectId, projectId), gte(traces.startedAt, new Date(now.getTime() - RANGES[range]))))
    .orderBy(traces.channel);
  return rows.map((r) => r.channel);
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [at, id] = value as unknown[];
    if (typeof at !== 'string' || typeof id !== 'string' || !Number.isFinite(Date.parse(at))) return undefined;
    return { at, id };
  } catch {
    return undefined;
  }
}

export type TurnDetail = typeof traces.$inferSelect;
export type TurnMessage = Pick<typeof messages.$inferSelect, 'direction' | 'text' | 'at' | 'attachments' | 'proactive'>;

/** Slack for outbound messages whose send was timed a moment after the turn's own clock stopped. */
const SENT_SLACK_MS = 1_000;

/**
 * One turn and, when the project stores text, its messages: the inbound ones it answered (by id) and
 * what the agent sent in that thread while the turn ran. Undefined when the turn isn't in this project.
 */
export async function getTurn(
  db: Db,
  userId: string,
  projectId: string,
  turnId: string,
): Promise<{ turn: TurnDetail; messages: TurnMessage[] } | undefined> {
  await requireMember(db, userId, projectId);
  const [turn] = await db
    .select()
    .from(traces)
    .where(and(eq(traces.projectId, projectId), eq(traces.id, turnId)));
  if (!turn) return undefined;

  const columns = {
    direction: messages.direction,
    text: messages.text,
    at: messages.at,
    attachments: messages.attachments,
    proactive: messages.proactive,
  };
  const scope = and(eq(messages.projectId, projectId), eq(messages.channel, turn.channel));
  const [inbound, outbound] = await Promise.all([
    turn.messageIds.length === 0
      ? []
      : db
          .select(columns)
          .from(messages)
          .where(and(scope, eq(messages.direction, 'in'), inArray(messages.id, turn.messageIds))),
    db
      .select(columns)
      .from(messages)
      .where(
        and(
          scope,
          eq(messages.direction, 'out'),
          eq(messages.threadId, turn.threadId),
          between(messages.at, turn.startedAt, new Date(turn.startedAt.getTime() + turn.durationMs + SENT_SLACK_MS)),
        ),
      )
      .orderBy(asc(messages.at)),
  ]);
  return { turn, messages: [...inbound, ...outbound].sort((a, b) => a.at.getTime() - b.at.getTime()) };
}
