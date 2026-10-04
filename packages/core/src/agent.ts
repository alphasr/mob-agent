import type { AgentEvent, ScheduledJobSummary, TimedAgentEvent } from './events.ts';
import { splitText } from './split.ts';
import { randomUUID } from 'node:crypto';
import { StoreScheduler } from './scheduler.ts';
import type { JobOutcome, Scheduler } from './scheduler.ts';
import { MemoryStore } from './store.ts';
import { DEFAULT_PRICES, TurnTracer } from './trace.ts';
import type { ModelPrice, Tracer } from './trace.ts';
import type { HistoryEntry, JobRecord, JobStatus, Store } from './store.ts';
import type { Channel, InboundMessage, MessageTemplate, Participant, SentMessage, Thread } from './types.ts';

export interface AgentOptions {
  channels: Channel[];
  /** Decide who the agent answers. Default: everyone. */
  allow?: (message: InboundMessage) => boolean | Promise<boolean>;
  /** Answer in group chats. Default: false. */
  groups?: boolean;
  /**
   * Wait this long after a message for more from the same sender before calling the
   * handler, so "hey" / "quick q" / "what's the weather" becomes one turn. Default: 2000. 0 disables.
   */
  debounceMs?: number;
  /**
   * Dedupe, channel cursors and conversation history. Default: an in-memory store,
   * which forgets everything on restart; use `new SqliteStore('agent.sqlite')` in production.
   */
  store?: Store;
  /** Proactive messages (`agent.send`) allowed per channel per minute. Default: 20. */
  proactivePerMinute?: number;
  /** Runs `agent.schedule` jobs. Default: a StoreScheduler on this agent's store. */
  scheduler?: Scheduler;
  /** A scheduled message more than this late (agent was down) is dropped, not sent. Default: 1 hour. */
  scheduleGraceMs?: number;
  /** Pending scheduled messages allowed per conversation. Default: 50. */
  maxScheduledPerConversation?: number;
  /** USD per million tokens, merged over the built-in Claude prices, for trace cost estimates. */
  prices?: Record<string, ModelPrice>;
  /** Keep turn traces in the store for the dashboard. Default: 7 days, 10,000 turns. `false` keeps none. */
  traceRetention?: { days?: number; maxTurns?: number } | false;
}

export type ScheduleRequest = SendRequest & {
  at: Date;
  /** Your name for it, e.g. "booking-42-reminder". Scheduling the same key again replaces it. */
  key?: string;
};

export interface ScheduledMessage {
  id: string;
  key?: string;
  conversation: string;
  at: Date;
  request: SendRequest;
  status: JobStatus;
  attempts: number;
  error?: string;
}

export type SendRequest =
  /** Start a conversation. */
  | { channel: string; to: string; text?: string; subject?: string; template?: MessageTemplate }
  /** Continue one. `to` defaults to whoever wrote last in the thread. */
  | { thread: Thread; text: string; to?: string };

export class ProactiveLimitError extends Error {
  constructor(channel: string, perMinute: number) {
    super(`Not sending: over ${perMinute} proactive messages per minute on ${channel}. Raise proactivePerMinute if this is intended.`);
    this.name = 'ProactiveLimitError';
  }
}

export interface MessageContext {
  channel: Channel;
  thread: Thread;
  sender: Participant;
  /** Every message in this turn, oldest first (more than one when debounced). */
  messages: InboundMessage[];
  /** The latest message in this turn. */
  message: InboundMessage;
  /** All texts in this turn joined by newlines. */
  text: string;
  /** Reply in the same thread. Text over the channel's limit is split into several messages. */
  reply(text: string): Promise<SentMessage[]>;
  /** Show a typing indicator where the channel supports one; a no-op elsewhere. */
  typing(): Promise<void>;
  /** The latest `limit` messages in this thread, oldest first, including this turn. Default limit: 20. */
  history(limit?: number): Promise<HistoryEntry[]>;
  /** Time model calls, tool calls and other steps; summarized in the turn's `turn.completed` trace. */
  trace: Tracer;
}

export type MessageHandler = (ctx: MessageContext) => void | Promise<void>;
export type EventListener = (event: TimedAgentEvent) => void;

interface PendingTurn {
  messages: InboundMessage[];
  timer: NodeJS.Timeout;
}

export class Agent {
  readonly #channels = new Map<string, Channel>();
  readonly #allow: AgentOptions['allow'];
  readonly #groups: boolean;
  readonly #debounceMs: number;
  readonly #store: Store;
  /** Close the store on stop() only if we created it; a caller-supplied store is theirs to close. */
  readonly #ownsStore: boolean;
  readonly #proactivePerMinute: number;
  /** Send times of recent proactive messages, per channel. */
  readonly #proactiveLog = new Map<string, number[]>();
  readonly #scheduler: Scheduler;
  readonly #graceMs: number;
  readonly #maxScheduled: number;
  readonly #prices: Record<string, ModelPrice>;
  readonly #retention: { days: number; maxTurns: number } | false;
  #tracesSincePrune = 0;

  #handler: MessageHandler | undefined;
  readonly #listeners = new Set<EventListener>();
  /** Messages waiting out the debounce window, per conversation. */
  readonly #pending = new Map<string, PendingTurn>();
  /** Tail of each conversation's handler chain, so turns run one at a time and replies stay in order. */
  readonly #queues = new Map<string, Promise<void>>();
  #state: 'idle' | 'running' | 'stopping' = 'idle';

  constructor(options: AgentOptions) {
    if (options.channels.length === 0) throw new Error('Agent needs at least one channel');
    for (const channel of options.channels) {
      if (this.#channels.has(channel.name)) throw new Error(`Duplicate channel name: ${channel.name}`);
      this.#channels.set(channel.name, channel);
    }
    this.#allow = options.allow;
    this.#groups = options.groups ?? false;
    this.#debounceMs = options.debounceMs ?? 2000;
    if (!(this.#debounceMs >= 0)) throw new RangeError('debounceMs must be >= 0');
    this.#store = options.store ?? new MemoryStore();
    this.#ownsStore = !options.store;
    this.#proactivePerMinute = options.proactivePerMinute ?? 20;
    this.#scheduler = options.scheduler ?? new StoreScheduler(this.#store);
    this.#graceMs = options.scheduleGraceMs ?? 60 * 60_000;
    this.#maxScheduled = options.maxScheduledPerConversation ?? 50;
    this.#prices = { ...DEFAULT_PRICES, ...options.prices };
    this.#retention =
      options.traceRetention === false
        ? false
        : { days: options.traceRetention?.days ?? 7, maxTurns: options.traceRetention?.maxTurns ?? 10_000 };
  }

  on(event: 'message', handler: MessageHandler): this;
  on(event: 'event', listener: EventListener): this;
  on(event: 'message' | 'event', fn: MessageHandler | EventListener): this {
    if (event === 'message') {
      if (this.#handler) throw new Error('A message handler is already registered');
      this.#handler = fn as MessageHandler;
    } else {
      this.#listeners.add(fn as EventListener);
    }
    return this;
  }

  off(event: 'event', listener: EventListener): this {
    this.#listeners.delete(listener);
    return this;
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle') throw new Error(`Agent is already ${this.#state}`);
    if (!this.#handler) throw new Error("Register a handler with agent.on('message', ...) before start()");
    this.#state = 'running';

    const started: Channel[] = [];
    try {
      for (const channel of this.#channels.values()) {
        await channel.start({
          receive: (message) => this.#receive(message),
          reportError: (error) => this.#emit({ type: 'channel.error', channel: channel.name, error }),
          state: {
            get: (key) => this.#store.getState(channel.name, key),
            set: (key, value) => this.#store.setState(channel.name, key, value),
          },
        });
        started.push(channel);
        this.#emit({ type: 'channel.started', channel: channel.name });
      }
      // After channels, so a job that's already due has somewhere to go.
      await this.#scheduler.start((job) => this.#runJob(job));
      await this.#pruneTraces();
    } catch (error) {
      // Don't leave half the channels running if one fails to start.
      await Promise.allSettled(started.map((c) => c.stop()));
      this.#state = 'idle';
      throw error;
    }
  }

  /** Stop accepting messages, finish in-flight turns (including debounced ones), then stop channels. */
  async stop(): Promise<void> {
    if (this.#state !== 'running') return;
    this.#state = 'stopping';
    await this.#scheduler.stop();

    for (const [key, turn] of this.#pending) {
      clearTimeout(turn.timer);
      this.#pending.delete(key);
      this.#enqueue(key, turn.messages);
    }
    await Promise.allSettled(this.#queues.values());

    await Promise.allSettled(
      [...this.#channels.values()].map(async (channel) => {
        await channel.stop();
        this.#emit({ type: 'channel.stopped', channel: channel.name });
      }),
    );
    if (this.#ownsStore) await this.#store.close();
    this.#state = 'idle';
  }

  /**
   * Resolves once every queued turn has finished. Messages still inside the debounce
   * window are not waited for; use `debounceMs: 0` in tests.
   */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) {
      await Promise.allSettled([...this.#queues.values()]);
    }
  }

  async #receive(message: InboundMessage): Promise<void> {
    if (this.#state !== 'running') return;
    this.#emit({ type: 'message.received', message });

    // Webhooks retry and pollers overlap; never answer the same message twice.
    const isNew = await this.#storeOp('markSeen', () => this.#store.markSeen(message.channel, message.id), true);
    if (!isNew) {
      this.#emit({ type: 'message.duplicate', message });
      return;
    }

    if (message.thread.isGroup && !this.#groups) {
      this.#emit({ type: 'message.filtered', message, reason: 'group' });
      return;
    }
    if (this.#allow) {
      let allowed: boolean;
      try {
        allowed = await this.#allow(message);
      } catch (error) {
        this.#emit({ type: 'message.filtered', message, reason: 'allow-error' });
        this.#emit({ type: 'channel.error', channel: message.channel, error });
        return;
      }
      if (!allowed) {
        this.#emit({ type: 'message.filtered', message, reason: 'not-allowed' });
        return;
      }
    }

    // One turn per sender per thread, so in a group two people's messages never merge.
    const key = `${message.channel}\u0000${message.thread.id}\u0000${message.sender.id}`;

    if (this.#debounceMs === 0) {
      this.#enqueue(key, [message]);
      return;
    }
    const pending = this.#pending.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      pending.messages.push(message);
    }
    const messages = pending?.messages ?? [message];
    const timer = setTimeout(() => {
      this.#pending.delete(key);
      this.#enqueue(key, messages);
    }, this.#debounceMs);
    this.#pending.set(key, { messages, timer });
  }

  #enqueue(key: string, messages: InboundMessage[]): void {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(key, messages));
    this.#queues.set(key, next);
    void next.finally(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
  }

  async #runTurn(conversation: string, messages: InboundMessage[]): Promise<void> {
    const message = messages.at(-1)!;
    const channel = this.#channels.get(message.channel);
    if (!channel) {
      this.#emit({
        type: 'channel.error',
        channel: message.channel,
        error: new Error(`Message from unknown channel "${message.channel}"`),
      });
      return;
    }

    const tracer = new TurnTracer();
    let sentCount = 0;
    const ctx: MessageContext = {
      trace: tracer,
      channel,
      thread: message.thread,
      sender: message.sender,
      messages,
      message,
      text: messages.map((m) => m.text).filter(Boolean).join('\n'),
      reply: async (text) => {
        const sent = await this.#reply(channel, message, text);
        sentCount += sent.length;
        return sent;
      },
      typing: async () => {
        if (channel.capabilities.typingIndicator && channel.sendTyping) {
          await channel.sendTyping(message.thread);
        }
      },
      history: (limit = 20) => this.#store.getHistory(channel.name, message.thread.id, limit),
    };

    // Recorded when the turn starts, not on arrival: a message that arrives while the previous
    // reply is still being written must land after that reply, or history reads out of order.
    for (const m of messages) {
      await this.#storeOp('appendHistory', () =>
        this.#store.appendHistory({
          channel: m.channel,
          threadId: m.thread.id,
          messageId: m.id,
          role: 'user',
          senderId: m.sender.id,
          text: m.text,
          timestamp: m.timestamp,
        }),
      );
    }

    const startedAt = performance.now();
    const messageIds = messages.map((m) => m.id);
    this.#emit({ type: 'handler.started', conversation, messageIds });
    let failure: unknown;
    try {
      await this.#handler!(ctx);
      this.#emit({ type: 'handler.finished', conversation, durationMs: performance.now() - startedAt });
    } catch (error) {
      failure = error;
      this.#emit({ type: 'handler.error', conversation, error, durationMs: performance.now() - startedAt });
    }

    const trace = tracer.finish(
      { conversation, channel: channel.name, threadId: message.thread.id, messageIds, sentCount },
      this.#prices,
      failure,
    );
    this.#emit({ type: 'turn.completed', trace });
    if (this.#retention) {
      await this.#storeOp('addTrace', () => this.#store.addTrace(trace));
      if (++this.#tracesSincePrune >= 100) await this.#pruneTraces();
    }
  }

  async #pruneTraces(): Promise<void> {
    if (!this.#retention) return;
    const { days, maxTurns } = this.#retention;
    this.#tracesSincePrune = 0;
    await this.#storeOp('pruneTraces', () => this.#store.pruneTraces(new Date(Date.now() - days * 86_400_000), maxTurns));
  }

  async #reply(channel: Channel, replyTo: InboundMessage, text: string): Promise<SentMessage[]> {
    const parts = this.#split(channel, text);
    const sent = await this.#sendParts(channel, replyTo.thread, parts, { replyTo });
    await this.#recordAgentMessage(channel, replyTo.thread, sent, text);
    return sent;
  }

  /**
   * Send a message nobody is waiting for: start a conversation (`channel` + `to`) or continue
   * one (`thread`). Rate-limited per channel, split like replies, and recorded in history.
   * Never let a model choose `to` freely: decide recipients in code.
   */
  async send(request: SendRequest): Promise<SentMessage[]> {
    if (this.#state !== 'running') throw new Error('Start the agent before sending');

    if ('thread' in request) {
      const channel = this.#channelNamed(request.thread.channel);
      const parts = this.#split(channel, request.text);
      if (parts.length === 0) throw new Error('send(): text is empty');
      this.#takeProactiveSlots(channel.name, parts.length);
      const to = request.to ?? (await this.#lastSender(channel.name, request.thread.id));
      const sent = await this.#sendParts(channel, request.thread, parts, { ...(to && { to }), proactive: true });
      await this.#recordAgentMessage(channel, request.thread, sent, request.text);
      return sent;
    }

    const channel = this.#channelNamed(request.channel);
    if (!channel.sendNew) throw new Error(`The ${channel.name} channel can't start conversations`);
    const parts = request.text ? this.#split(channel, request.text) : [];
    if (parts.length === 0 && !request.template) throw new Error('send(): pass text or a template');
    this.#takeProactiveSlots(channel.name, Math.max(parts.length, 1));

    const [firstText, ...rest] = parts;
    const { sent: first, thread } = await channel.sendNew({
      to: request.to,
      ...(firstText !== undefined && { text: firstText }),
      ...(request.subject !== undefined && { subject: request.subject }),
      ...(request.template && { template: request.template }),
    });
    const total = Math.max(parts.length, 1);
    this.#emit({ type: 'message.sent', message: first, text: firstText ?? templateText(request.template!), part: 1, parts: total, proactive: true });
    const sent = [first, ...(await this.#sendParts(channel, thread, rest, { to: request.to, proactive: true }, 2, total))];
    await this.#recordAgentMessage(channel, thread, sent, request.text ?? templateText(request.template!));
    return sent;
  }

  #split(channel: Channel, text: string): string[] {
    const max = channel.capabilities.maxTextLength;
    return max ? splitText(text, max) : [text.trim()].filter(Boolean);
  }

  async #sendParts(
    channel: Channel,
    thread: Thread,
    parts: string[],
    options: { replyTo?: InboundMessage; to?: string; proactive?: true },
    firstPart = 1,
    total = parts.length,
  ): Promise<SentMessage[]> {
    const sent: SentMessage[] = [];
    for (const [i, part] of parts.entries()) {
      const message = await channel.send({
        thread,
        text: part,
        ...(options.replyTo && { replyTo: options.replyTo }),
        ...(options.to && { to: options.to }),
      });
      sent.push(message);
      this.#emit({
        type: 'message.sent',
        message,
        text: part,
        part: firstPart + i,
        parts: total,
        ...(options.proactive && { proactive: true }),
      });
    }
    return sent;
  }

  /** History keeps a message whole, as written, not as the channel chopped it up. */
  async #recordAgentMessage(channel: Channel, thread: Thread, sent: SentMessage[], text: string): Promise<void> {
    const last = sent.at(-1);
    if (!last) return;
    await this.#storeOp('appendHistory', () =>
      this.#store.appendHistory({
        channel: channel.name,
        threadId: thread.id,
        messageId: last.id,
        role: 'agent',
        text: text.trim(),
        timestamp: new Date(),
      }),
    );
  }

  /** Who to address when continuing a thread without `to`: whoever wrote last. */
  async #lastSender(channel: string, threadId: string): Promise<string | undefined> {
    const history = (await this.#storeOp('getHistory', () => this.#store.getHistory(channel, threadId, 50))) ?? [];
    return history.findLast((e) => e.role === 'user' && e.senderId)?.senderId;
  }

  /**
   * Send later. Survives restarts with SqliteStore. Validated now, so mistakes surface
   * to the caller instead of failing silently at the due time.
   */
  async schedule(request: ScheduleRequest): Promise<ScheduledMessage> {
    const { at, key, ...send } = request;
    const now = Date.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('schedule(): `at` must be a valid Date');
    if (at.getTime() < now - 60_000) throw new Error('schedule(): `at` is in the past');
    if (at.getTime() > now + 365 * 24 * 60 * 60_000) throw new Error('schedule(): `at` is more than a year away');
    this.#validateSend(send);

    const conversation = conversationOf(send);
    const pending = await this.#scheduler.list({ conversation, status: 'pending' });
    const replacing = key !== undefined && pending.some((j) => j.key === key);
    if (!replacing && pending.length >= this.#maxScheduled) {
      throw new Error(`schedule(): this conversation already has ${pending.length} scheduled messages (limit ${this.#maxScheduled})`);
    }

    const job: JobRecord = {
      id: randomUUID(),
      ...(key !== undefined && { key }),
      conversation,
      at,
      request: JSON.stringify(send),
      status: 'pending',
      attempts: 0,
      createdAt: new Date(now),
    };
    await this.#scheduler.add(job);
    this.#emit({ type: 'schedule.created', job: summarize(job) });
    return toScheduledMessage(job);
  }

  async cancelScheduled(by: { id: string } | { key: string }): Promise<boolean> {
    const canceled = await this.#scheduler.cancel(by);
    if (canceled) this.#emit({ type: 'schedule.canceled', by });
    return canceled;
  }

  /** Scheduled messages, soonest first; pass a thread to see one conversation's. */
  async listScheduled(filter: { thread?: Thread; status?: JobStatus } = {}): Promise<ScheduledMessage[]> {
    const jobs = await this.#scheduler.list({
      ...(filter.thread && { conversation: conversationOf({ thread: filter.thread, text: '' }) }),
      ...(filter.status && { status: filter.status }),
    });
    return jobs.map(toScheduledMessage);
  }

  async #runJob(job: JobRecord): Promise<JobOutcome> {
    const lateMs = Date.now() - job.at.getTime();
    if (lateMs > this.#graceMs) {
      const error = `Not sent: ${Math.round(lateMs / 60_000)} minutes late, past the ${Math.round(this.#graceMs / 60_000)}-minute limit`;
      this.#emit({ type: 'schedule.expired', job: summarize(job), error });
      return { status: 'expired', error };
    }
    try {
      await this.send(JSON.parse(job.request) as SendRequest); // written by schedule() from a validated SendRequest
      this.#emit({ type: 'schedule.sent', job: summarize(job) });
      return { status: 'sent' };
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof ProactiveLimitError && job.attempts < 3) {
        this.#emit({ type: 'schedule.retrying', job: summarize(job), error: message });
        return { status: 'retry', at: new Date(Date.now() + 60_000), error: message };
      }
      this.#emit({ type: 'schedule.failed', job: summarize(job), error: message });
      return { status: 'failed', error: message };
    }
  }

  #validateSend(request: SendRequest): void {
    if ('thread' in request) {
      this.#channelNamed(request.thread.channel);
      if (!request.text?.trim()) throw new Error('A message to a thread needs text');
      return;
    }
    const channel = this.#channelNamed(request.channel);
    if (!channel.sendNew) throw new Error(`The ${channel.name} channel can't start conversations`);
    if (!request.to) throw new Error('A new conversation needs `to`');
    if (!request.text?.trim() && !request.template) throw new Error('Pass text or a template');
  }

  #channelNamed(name: string): Channel {
    const channel = this.#channels.get(name);
    if (!channel) throw new Error(`No channel named "${name}" on this agent`);
    return channel;
  }

  /** Bulk sending gets accounts flagged as spam; refuse before the platform does. */
  #takeProactiveSlots(channel: string, count: number): void {
    const now = Date.now();
    const recent = (this.#proactiveLog.get(channel) ?? []).filter((t) => now - t < 60_000);
    if (recent.length + count > this.#proactivePerMinute) {
      throw new ProactiveLimitError(channel, this.#proactivePerMinute);
    }
    for (let i = 0; i < count; i++) recent.push(now);
    this.#proactiveLog.set(channel, recent);
  }


  /** Store failures are reported but never block messaging; `fallback` is used in their place. */
  async #storeOp<T>(operation: string, fn: () => Promise<T>, fallback?: T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.#emit({ type: 'store.error', operation, error });
      return fallback;
    }
  }

  #emit(event: AgentEvent): void {
    const timed = { ...event, at: new Date() } as TimedAgentEvent;
    for (const listener of this.#listeners) {
      try {
        listener(timed);
      } catch {
        // A broken logger must never take down message handling.
      }
    }
  }
}

function templateText(template: MessageTemplate): string {
  return `[template ${template.name}${template.params?.length ? `: ${template.params.join(', ')}` : ''}]`;
}

/** Groups scheduled messages by who they go to, for listing and per-conversation limits. */
function conversationOf(request: SendRequest): string {
  return 'thread' in request ? `${request.thread.channel}:${request.thread.id}` : `${request.channel}:to:${request.to}`;
}

function summarize(job: JobRecord): ScheduledJobSummary {
  return { id: job.id, ...(job.key !== undefined && { key: job.key }), conversation: job.conversation, at: job.at };
}

function toScheduledMessage(job: JobRecord): ScheduledMessage {
  return {
    id: job.id,
    ...(job.key !== undefined && { key: job.key }),
    conversation: job.conversation,
    at: job.at,
    request: JSON.parse(job.request) as SendRequest, // written by schedule() from a validated SendRequest
    status: job.status,
    attempts: job.attempts,
    ...(job.error !== undefined && { error: job.error }),
  };
}
