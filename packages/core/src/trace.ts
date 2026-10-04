import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Claude list prices as of 2026-10-05 (cache writes at the 5-minute rate, 1.25× input).
 * Prices change: pass `prices` to the Agent to override or add models.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export interface SpanRecord {
  id: string;
  parent?: string;
  name: string;
  /** Milliseconds after the turn started. */
  startMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  usage?: TokenUsage[];
  error?: string;
  /** Still open when the turn ended; closed then. */
  unfinished?: true;
  /** Attributes were over the size limit and were cut. */
  truncated?: true;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One handled turn, from the first message in to the handler finishing. Never contains message text. */
export interface TurnTrace {
  id: string;
  conversation: string;
  channel: string;
  threadId: string;
  startedAt: Date;
  durationMs: number;
  messageIds: string[];
  /** Messages the agent sent during the turn (split parts counted separately). */
  sentCount: number;
  spans: SpanRecord[];
  usage: UsageTotals;
  /** Estimated from known model prices; excludes `unpricedModels`. */
  costUsd: number;
  unpricedModels?: string[];
  /** Spans beyond the per-turn limit, not recorded. */
  droppedSpans?: number;
  error?: string;
}

export interface Span {
  readonly id: string;
  setAttributes(attributes: Record<string, unknown>): void;
  /** Record token usage of a model call made in this span. */
  usage(usage: TokenUsage): void;
  end(error?: unknown): void;
}

/** `ctx.trace`: time model calls, tool calls and anything else worth seeing in a turn. */
export interface Tracer {
  /** Time `fn`. Spans started inside it become its children automatically. Errors are recorded and rethrown. */
  span<T>(name: string, attributes: Record<string, unknown>, fn: (span: Span) => T | Promise<T>): Promise<T>;
  /** Start a span to end yourself; ended automatically (marked unfinished) if the turn finishes first. */
  start(name: string, attributes?: Record<string, unknown>): Span;
  /** Record token usage outside any span. */
  usage(usage: TokenUsage): void;
}

const MAX_SPANS = 50;
const MAX_ATTRIBUTE_BYTES = 2048;

/** Collects one turn's spans. Created by the agent per turn; `finish()` produces the trace. */
export class TurnTracer implements Tracer {
  readonly #started = performance.now();
  readonly #startedAt = new Date();
  readonly #spans: SpanRecord[] = [];
  readonly #open = new Map<string, number>();
  readonly #looseUsage: TokenUsage[] = [];
  readonly #current = new AsyncLocalStorage<string>();
  #dropped = 0;

  async span<T>(name: string, attributes: Record<string, unknown>, fn: (span: Span) => T | Promise<T>): Promise<T> {
    const span = this.start(name, attributes);
    try {
      const result = await this.#current.run(span.id, () => fn(span));
      span.end();
      return result;
    } catch (error) {
      span.end(error);
      throw error;
    }
  }

  start(name: string, attributes: Record<string, unknown> = {}): Span {
    const id = randomUUID();
    const parent = this.#current.getStore();
    if (this.#spans.length >= MAX_SPANS) {
      this.#dropped++;
      return { id, setAttributes() {}, usage: (u) => this.#looseUsage.push(u), end() {} };
    }
    const record: SpanRecord = {
      id,
      ...(parent && { parent }),
      name,
      startMs: performance.now() - this.#started,
      durationMs: 0,
      attributes: {},
    };
    setAttributes(record, attributes);
    this.#spans.push(record);
    this.#open.set(id, performance.now());
    return {
      id,
      setAttributes: (more) => setAttributes(record, { ...record.attributes, ...more }),
      usage: (u) => (record.usage ??= []).push({ ...u }),
      end: (error) => {
        const began = this.#open.get(id);
        if (began === undefined) return; // already ended
        this.#open.delete(id);
        record.durationMs = performance.now() - began;
        if (error !== undefined) record.error = error instanceof Error ? error.message : String(error);
      },
    };
  }

  usage(usage: TokenUsage): void {
    this.#looseUsage.push({ ...usage });
  }

  finish(
    turn: Pick<TurnTrace, 'conversation' | 'channel' | 'threadId' | 'messageIds' | 'sentCount'>,
    prices: Record<string, ModelPrice>,
    error?: unknown,
  ): TurnTrace {
    const now = performance.now();
    for (const [id, began] of this.#open) {
      const record = this.#spans.find((s) => s.id === id)!;
      record.durationMs = now - began;
      record.unfinished = true;
    }
    this.#open.clear();

    const allUsage = [...this.#spans.flatMap((s) => s.usage ?? []), ...this.#looseUsage];
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let costUsd = 0;
    const unpriced = new Set<string>();
    for (const u of allUsage) {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.cacheReadTokens += u.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      const price = prices[u.model];
      if (!price) {
        unpriced.add(u.model);
        continue;
      }
      costUsd +=
        (u.inputTokens * price.input +
          u.outputTokens * price.output +
          (u.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input) +
          (u.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) /
        1_000_000;
    }

    return {
      id: randomUUID(),
      ...turn,
      startedAt: this.#startedAt,
      durationMs: now - this.#started,
      spans: this.#spans,
      usage,
      costUsd,
      ...(unpriced.size > 0 && { unpricedModels: [...unpriced] }),
      ...(this.#dropped > 0 && { droppedSpans: this.#dropped }),
      ...(error !== undefined && { error: error instanceof Error ? error.message : String(error) }),
    };
  }
}

/** Attributes are developer-supplied and may be huge (a whole tool result); cap them. */
function setAttributes(record: SpanRecord, attributes: Record<string, unknown>): void {
  let json: string;
  try {
    json = JSON.stringify(attributes) ?? '{}';
  } catch {
    json = '{"_unserializable":true}';
  }
  if (Buffer.byteLength(json) <= MAX_ATTRIBUTE_BYTES) {
    record.attributes = JSON.parse(json) as Record<string, unknown>;
    delete record.truncated;
    return;
  }
  // Cut by bytes, not characters, so multi-byte text can't slip past the limit.
  record.attributes = { _truncated: Buffer.from(json).subarray(0, MAX_ATTRIBUTE_BYTES - 64).toString() };
  record.truncated = true;
}
