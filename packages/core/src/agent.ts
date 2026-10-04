import type { AgentEvent, TimedAgentEvent } from './events.ts';
import { splitText } from './split.ts';
import { MemoryStore } from './store.ts';
import type { HistoryEntry, Store } from './store.ts';
import type { Channel, InboundMessage, Participant, SentMessage, Thread } from './types.ts';

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

    const ctx: MessageContext = {
      channel,
      thread: message.thread,
      sender: message.sender,
      messages,
      message,
      text: messages.map((m) => m.text).filter(Boolean).join('\n'),
      reply: (text) => this.#reply(channel, message, text),
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
    this.#emit({ type: 'handler.started', conversation, messageIds: messages.map((m) => m.id) });
    try {
      await this.#handler!(ctx);
      this.#emit({ type: 'handler.finished', conversation, durationMs: performance.now() - startedAt });
    } catch (error) {
      this.#emit({ type: 'handler.error', conversation, error, durationMs: performance.now() - startedAt });
    }
  }

  async #reply(channel: Channel, replyTo: InboundMessage, text: string): Promise<SentMessage[]> {
    const max = channel.capabilities.maxTextLength;
    const parts = max ? splitText(text, max) : [text.trim()].filter(Boolean);
    const sent: SentMessage[] = [];
    for (const [i, part] of parts.entries()) {
      const message = await channel.send({ thread: replyTo.thread, text: part, replyTo });
      sent.push(message);
      this.#emit({ type: 'message.sent', message, part: i + 1, parts: parts.length });
    }
    // History keeps the reply whole, as written, not as the channel chopped it up.
    const last = sent.at(-1);
    if (last) {
      await this.#storeOp('appendHistory', () =>
        this.#store.appendHistory({
          channel: channel.name,
          threadId: replyTo.thread.id,
          messageId: last.id,
          role: 'agent',
          text: text.trim(),
          timestamp: new Date(),
        }),
      );
    }
    return sent;
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
