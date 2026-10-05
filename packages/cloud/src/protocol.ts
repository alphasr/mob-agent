import type { TokenUsage, UsageTotals } from '@textagent/core';

/**
 * The ingest wire format, shared by `exporter()` and the dashboard's ingest endpoint.
 * Ids that can name a person (conversation, thread, message and sender ids) arrive as HMAC-SHA256
 * hashes under a secret only the agent holds: the server can group by them but can't reverse them.
 */

export const INGEST_PATH = '/v1/ingest';
export const PROTOCOL_VERSION = 1;

/** POSTed to `INGEST_PATH` as JSON with `Authorization: Bearer <ingestion key>`. */
export interface IngestBatch {
  version: typeof PROTOCOL_VERSION;
  traces: ExportedTrace[];
  /** Only when the agent opted into sending message text. */
  messages?: ExportedMessage[];
}

/** A `TurnTrace` with ids hashed and dates as ISO 8601 strings. */
export interface ExportedTrace {
  id: string;
  /** Hashed. */
  conversation: string;
  channel: string;
  /** Hashed; equals `ExportedMessage.threadId` for the same thread. */
  threadId: string;
  startedAt: string;
  durationMs: number;
  /** Hashed. */
  messageIds: string[];
  sentCount: number;
  spans: ExportedSpan[];
  usage: UsageTotals;
  costUsd: number;
  unpricedModels?: string[];
  droppedSpans?: number;
  error?: string;
}

export interface ExportedSpan {
  id: string;
  parent?: string;
  name: string;
  startMs: number;
  durationMs: number;
  /** Empty when the agent exports with `attributes: false`. */
  attributes: Record<string, unknown>;
  usage?: TokenUsage[];
  error?: string;
  unfinished?: true;
  truncated?: true;
}

/** One message in or out, sent only with `includeText`. */
export interface ExportedMessage {
  direction: 'in' | 'out';
  /** Hashed. */
  id: string;
  channel: string;
  /** Hashed. */
  threadId: string;
  /** Hashed; inbound only. */
  senderId?: string;
  text: string;
  /** Number of attachments (never their names or locations). */
  attachments?: number;
  at: string;
  /** Sent with `agent.send()` rather than as a reply. */
  proactive?: true;
}

/** Limits the exporter stays under and the ingest endpoint enforces. */
export const MAX_BATCH_BYTES = 1_000_000;
export const MAX_TRACES_PER_BATCH = 50;
export const MAX_MESSAGES_PER_BATCH = 1_000;
const MAX_SPANS = 50; // core records at most 50 per turn
const MAX_MESSAGE_IDS = 1_000;
const MAX_USAGE_ENTRIES = 200;
/** Core caps attributes at 2 KB, but its truncation marker is re-escaped as JSON and can grow. */
const MAX_ATTRIBUTE_BYTES = 8_192;
const MAX_TEXT_CHARS = 65_536;
const MAX_LABEL_CHARS = 2_000;
const MAX_FUTURE_MS = 5 * 60_000;
/** `hasher()` output: base64url HMAC-SHA256. Anything else could be a raw phone number or email. */
const HASH = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[\w.:-]{1,128}$/;
const CHANNEL = /^[\w.-]{1,64}$/;

class Invalid extends Error {}

/**
 * Validate an untrusted batch. Returns it rebuilt from known fields only (unknown ones are dropped,
 * so newer exporters keep working), with free text cut to size, or a message saying what is wrong.
 * Hashed fields must look like hashes, so a misconfigured client can't store raw phone numbers.
 */
export function parseBatch(value: unknown, now: Date = new Date()): IngestBatch | string {
  try {
    const body = record(value, 'body');
    if (body.version !== PROTOCOL_VERSION) {
      return `unsupported version ${JSON.stringify(body.version)}; this server accepts ${PROTOCOL_VERSION}`;
    }
    const traces = list(body.traces, 'traces', MAX_TRACES_PER_BATCH).map((t, i) => parseTrace(t, `traces[${i}]`, now));
    if (body.messages === undefined) return { version: PROTOCOL_VERSION, traces };
    const messages = list(body.messages, 'messages', MAX_MESSAGES_PER_BATCH).map((m, i) =>
      parseMessage(m, `messages[${i}]`, now),
    );
    return { version: PROTOCOL_VERSION, traces, messages };
  } catch (error) {
    if (error instanceof Invalid) return error.message;
    throw error;
  }
}

function parseTrace(value: unknown, path: string, now: Date): ExportedTrace {
  const t = record(value, path);
  const usage = record(t.usage, `${path}.usage`);
  return {
    id: id(t.id, `${path}.id`),
    conversation: hash(t.conversation, `${path}.conversation`),
    channel: channel(t.channel, `${path}.channel`),
    threadId: hash(t.threadId, `${path}.threadId`),
    startedAt: timestamp(t.startedAt, `${path}.startedAt`, now),
    durationMs: amount(t.durationMs, `${path}.durationMs`),
    messageIds: list(t.messageIds, `${path}.messageIds`, MAX_MESSAGE_IDS).map((m, i) =>
      hash(m, `${path}.messageIds[${i}]`),
    ),
    sentCount: count(t.sentCount, `${path}.sentCount`),
    spans: list(t.spans, `${path}.spans`, MAX_SPANS).map((s, i) => parseSpan(s, `${path}.spans[${i}]`)),
    usage: {
      inputTokens: count(usage.inputTokens, `${path}.usage.inputTokens`),
      outputTokens: count(usage.outputTokens, `${path}.usage.outputTokens`),
      cacheReadTokens: count(usage.cacheReadTokens, `${path}.usage.cacheReadTokens`),
      cacheWriteTokens: count(usage.cacheWriteTokens, `${path}.usage.cacheWriteTokens`),
    },
    costUsd: amount(t.costUsd, `${path}.costUsd`),
    ...(t.unpricedModels !== undefined && {
      unpricedModels: list(t.unpricedModels, `${path}.unpricedModels`, MAX_USAGE_ENTRIES).map((m, i) =>
        model(m, `${path}.unpricedModels[${i}]`),
      ),
    }),
    ...(t.droppedSpans !== undefined && { droppedSpans: count(t.droppedSpans, `${path}.droppedSpans`) }),
    ...(t.error !== undefined && { error: text(t.error, `${path}.error`, MAX_LABEL_CHARS) }),
  };
}

function parseSpan(value: unknown, path: string): ExportedSpan {
  const s = record(value, path);
  return {
    id: id(s.id, `${path}.id`),
    ...(s.parent !== undefined && { parent: id(s.parent, `${path}.parent`) }),
    name: text(s.name, `${path}.name`, MAX_LABEL_CHARS),
    startMs: amount(s.startMs, `${path}.startMs`),
    durationMs: amount(s.durationMs, `${path}.durationMs`),
    attributes: attributes(s.attributes, `${path}.attributes`),
    ...(s.usage !== undefined && {
      usage: list(s.usage, `${path}.usage`, MAX_USAGE_ENTRIES).map((u, i) => {
        const at = `${path}.usage[${i}]`;
        const r = record(u, at);
        return {
          model: model(r.model, `${at}.model`),
          inputTokens: count(r.inputTokens, `${at}.inputTokens`),
          outputTokens: count(r.outputTokens, `${at}.outputTokens`),
          ...(r.cacheReadTokens !== undefined && {
            cacheReadTokens: count(r.cacheReadTokens, `${at}.cacheReadTokens`),
          }),
          ...(r.cacheWriteTokens !== undefined && {
            cacheWriteTokens: count(r.cacheWriteTokens, `${at}.cacheWriteTokens`),
          }),
        };
      }),
    }),
    ...(s.error !== undefined && { error: text(s.error, `${path}.error`, MAX_LABEL_CHARS) }),
    ...(s.unfinished !== undefined && { unfinished: flag(s.unfinished, `${path}.unfinished`) }),
    ...(s.truncated !== undefined && { truncated: flag(s.truncated, `${path}.truncated`) }),
  };
}

function parseMessage(value: unknown, path: string, now: Date): ExportedMessage {
  const m = record(value, path);
  if (m.direction !== 'in' && m.direction !== 'out') fail(`${path}.direction must be "in" or "out"`);
  return {
    direction: m.direction,
    id: hash(m.id, `${path}.id`),
    channel: channel(m.channel, `${path}.channel`),
    threadId: hash(m.threadId, `${path}.threadId`),
    ...(m.senderId !== undefined && { senderId: hash(m.senderId, `${path}.senderId`) }),
    text: text(m.text, `${path}.text`, MAX_TEXT_CHARS),
    ...(m.attachments !== undefined && { attachments: count(m.attachments, `${path}.attachments`) }),
    at: timestamp(m.at, `${path}.at`, now),
    ...(m.proactive !== undefined && { proactive: flag(m.proactive, `${path}.proactive`) }),
  };
}

function fail(message: string): never {
  throw new Invalid(message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>; // narrowed to a non-null, non-array object above
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (value.length > max) fail(`${path} has ${value.length} entries; the limit is ${max}`);
  return value;
}

function matching(pattern: RegExp, what: string): (value: unknown, path: string) => string {
  return (value, path) => (typeof value === 'string' && pattern.test(value) ? value : fail(`${path} must be ${what}`));
}

const hash = matching(HASH, 'a hashed id (43 base64url characters)');
const id = matching(ID, 'an id of up to 128 letters, digits and ._:-');
const channel = matching(CHANNEL, 'a channel name of up to 64 letters, digits and ._-');

function model(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail(`${path} must be a model name`);
  return value;
}

/** Free text: cut to `max` (without splitting a surrogate pair) and NUL-free, which Postgres can't store. */
function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  let result = value.replaceAll('\u0000', '');
  if (result.length > max) {
    result = result.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  }
  return result;
}

/** Counts are stored as Postgres `integer`; anything larger would fail every retry of the insert. */
const MAX_COUNT = 2_147_483_647;

function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
    fail(`${path} must be a whole number from 0 to ${MAX_COUNT}`);
  }
  return value as number; // an integer in range, checked above
}

function amount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${path} must be a number ≥ 0`);
  return value;
}

function flag(value: unknown, path: string): true {
  if (value !== true) fail(`${path} must be true when present`);
  return true;
}

function timestamp(value: unknown, path: string, now: Date): string {
  const ms = typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) fail(`${path} must be an ISO 8601 timestamp`);
  if (ms > now.getTime() + MAX_FUTURE_MS) fail(`${path} is in the future; check the agent's clock`);
  return new Date(ms).toISOString();
}

function attributes(value: unknown, path: string): Record<string, unknown> {
  const result = record(stripNul(record(value, path)), path);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_ATTRIBUTE_BYTES) {
    fail(`${path} is over ${MAX_ATTRIBUTE_BYTES} bytes`);
  }
  return result;
}

/** Postgres jsonb rejects NUL in strings and keys. */
function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(stripNul);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replaceAll('\u0000', ''), stripNul(v)]));
  }
  return value;
}
