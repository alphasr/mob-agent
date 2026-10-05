import { createHash, timingSafeEqual } from 'node:crypto';
import { lt } from 'drizzle-orm';
import type { Db } from './db/db.ts';
import { messages, traces } from './db/schema.ts';

export const RETENTION_DAYS = 30;

/** Delete traces and messages older than the retention window, in every project. */
export async function prune(db: Db, now: Date = new Date()): Promise<{ traces: number; messages: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const deletedTraces = await db.delete(traces).where(lt(traces.startedAt, cutoff)).returning({ id: traces.id });
  const deletedMessages = await db.delete(messages).where(lt(messages.at, cutoff)).returning({ id: messages.id });
  return { traces: deletedTraces.length, messages: deletedMessages.length };
}

export interface PruneOptions {
  /** `CRON_SECRET`; Vercel cron sends it as a Bearer token. Unset means the endpoint stays closed. */
  secret: string | undefined;
  now?: Date;
  onError?: (error: unknown) => void;
}

/** `GET /v1/cron/prune`, called daily by Vercel cron (see vercel.json). */
export async function handlePrune(request: Request, db: Db, options: PruneOptions): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!options.secret || !token || !sameSecret(token, options.secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    return Response.json({ deleted: await prune(db, options.now) });
  } catch (error) {
    (options.onError ?? console.error)(error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}

/** Constant-time; hashing first makes the lengths equal, as timingSafeEqual requires. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const DAY_MS = 86_400_000;

/**
 * Prune once shortly after start, then daily, inside the server process: self-hosted servers have no
 * Vercel cron. Several replicas pruning is harmless (deletes are idempotent). Returns a stop function.
 */
export function startRetention(
  run: () => Promise<unknown>,
  { firstRunMs = 60_000, everyMs = DAY_MS, onError = console.error as (error: unknown) => void } = {},
): () => void {
  const tick = () => void run().catch(onError);
  // unref: retention must never be what keeps a process alive.
  const first = setTimeout(tick, firstRunMs).unref();
  const daily = setInterval(tick, everyMs).unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
