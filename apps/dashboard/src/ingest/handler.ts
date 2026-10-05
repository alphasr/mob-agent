import { readBody } from '@textagent/core';
import { MAX_BATCH_BYTES, parseBatch } from '@textagent/cloud';
import type { IngestBatch } from '@textagent/cloud';
import type { Db } from '../db/db.ts';
import { messages, traces } from '../db/schema.ts';
import { findProject } from './keys.ts';

export interface IngestOptions {
  /** Database failures; the client only ever sees a bare 500. Default: console.error */
  onError?: (error: unknown) => void;
  now?: Date;
}

/**
 * `POST /v1/ingest`: a batch from `exporter()`, stored under the key's project.
 * The key is checked before the body is read, so anonymous callers can't make the server parse megabytes.
 * Status codes follow what the exporter expects: 401 stops it, other 4xx drop the batch, 5xx are retried.
 */
export async function handleIngest(request: Request, db: Db, options: IngestOptions = {}): Promise<Response> {
  if (request.method !== 'POST') return reply(405, 'use POST');
  try {
    const key = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const project = key ? await findProject(db, key) : undefined;
    if (!project) return reply(401, 'invalid or revoked ingestion key');

    const type = request.headers.get('content-type') ?? '';
    if (!/^application\/json(;|$)/i.test(type)) return reply(415, 'send application/json');
    const body = await readBody(request, MAX_BATCH_BYTES);
    if (!body) return reply(413, `body is over ${MAX_BATCH_BYTES} bytes`);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return reply(400, 'body is not valid JSON');
    }
    const batch = parseBatch(json, options.now);
    if (typeof batch === 'string') return reply(400, batch);

    // A project that opted out of message text never stores it; the exporter still gets a 200.
    const messageCount = project.storeText ? (batch.messages?.length ?? 0) : 0;
    await store(db, project.projectId, project.storeText ? batch : { ...batch, messages: [] });
    return Response.json({ accepted: { traces: batch.traces.length, messages: messageCount } });
  } catch (error) {
    (options.onError ?? console.error)(error);
    return reply(500, 'internal error');
  }
}

/** One transaction; retried batches insert nothing new. */
async function store(db: Db, projectId: string, batch: IngestBatch): Promise<void> {
  await db.transaction(async (tx) => {
    if (batch.traces.length > 0) {
      await tx
        .insert(traces)
        .values(
          batch.traces.map((t) => ({
            projectId,
            id: t.id,
            conversation: t.conversation,
            channel: t.channel,
            threadId: t.threadId,
            startedAt: new Date(t.startedAt),
            durationMs: t.durationMs,
            sentCount: t.sentCount,
            inputTokens: t.usage.inputTokens,
            outputTokens: t.usage.outputTokens,
            cacheReadTokens: t.usage.cacheReadTokens,
            cacheWriteTokens: t.usage.cacheWriteTokens,
            costUsd: t.costUsd,
            unpricedModels: t.unpricedModels ?? null,
            droppedSpans: t.droppedSpans ?? null,
            error: t.error ?? null,
            messageIds: t.messageIds,
            spans: t.spans,
          })),
        )
        .onConflictDoNothing();
    }
    if (batch.messages && batch.messages.length > 0) {
      await tx
        .insert(messages)
        .values(
          batch.messages.map((m) => ({
            projectId,
            id: m.id,
            direction: m.direction,
            channel: m.channel,
            threadId: m.threadId,
            senderId: m.senderId ?? null,
            text: m.text,
            attachments: m.attachments ?? null,
            at: new Date(m.at),
            proactive: m.proactive ?? false,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

/** Errors are short, fixed messages or `parseBatch`'s description of the client's own data; never internals. */
function reply(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
