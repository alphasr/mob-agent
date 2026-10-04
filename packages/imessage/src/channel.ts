import { randomUUID } from 'node:crypto';
import type { Channel, ChannelCapabilities, ChannelContext, OutboundMessage, SentMessage } from '@textagent/core';
import { EchoGuard } from './echo-guard.ts';
import { ChatDbPoller } from './poller.ts';
import { ChatDbReader, DEFAULT_CHAT_DB } from './reader.ts';
import { appleScriptSender } from './sender.ts';
import type { IMessageSender } from './sender.ts';

export interface IMessageOptions {
  /** Default: ~/Library/Messages/chat.db */
  dbPath?: string;
  /** How often to check for new messages. Default: 1000. */
  pollIntervalMs?: number;
  /** How long a sent reply is remembered for echo detection. Default: 60000. */
  echoWindowMs?: number;
  /** Override how texts are sent. Default: AppleScript via osascript. */
  sender?: IMessageSender;
}

/** iMessage via the Messages app on this Mac. Needs Full Disk Access (to read) and Automation (to send). */
export function imessage(options: IMessageOptions = {}): Channel {
  return new IMessageChannel(options);
}

export class IMessageChannel implements Channel {
  readonly name = 'imessage';
  readonly capabilities: ChannelCapabilities = {
    // iMessage has no practical length limit, and AppleScript can't show a typing bubble.
    typingIndicator: false,
    groups: true,
    canInitiate: true,
  };

  readonly #options: IMessageOptions;
  readonly #send: IMessageSender;
  readonly #echoes: EchoGuard;
  #reader: ChatDbReader | undefined;
  #poller: ChatDbPoller | undefined;

  constructor(options: IMessageOptions = {}) {
    this.#options = options;
    this.#send = options.sender ?? appleScriptSender;
    this.#echoes = new EchoGuard(options.echoWindowMs);
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (process.platform !== 'darwin' && !this.#options.dbPath) {
      throw new Error('The iMessage channel only runs on macOS.');
    }
    this.#reader = new ChatDbReader(this.#options.dbPath ?? DEFAULT_CHAT_DB);
    this.#poller = new ChatDbPoller({
      reader: this.#reader,
      state: ctx.state,
      intervalMs: this.#options.pollIntervalMs ?? 1000,
      onMessage: async (message) => {
        if (this.#echoes.isEcho(message.thread.id, message.text)) return;
        await ctx.receive(message);
      },
      onError: (error) => ctx.reportError(error),
    });
    await this.#poller.start();
  }

  async stop(): Promise<void> {
    await this.#poller?.stop();
    this.#reader?.close();
    this.#poller = undefined;
    this.#reader = undefined;
  }

  async send({ thread, text }: OutboundMessage): Promise<SentMessage> {
    // Recorded before sending: the echo can hit chat.db before osascript returns.
    this.#echoes.record(thread.id, text);
    try {
      await this.#send(thread, text);
    } catch (error) {
      this.#echoes.forget(thread.id, text);
      throw error;
    }
    // AppleScript doesn't return the new message's guid.
    return { id: `imessage-local-${randomUUID()}`, channel: this.name, threadId: thread.id };
  }

  /** Read and deliver new messages now instead of waiting for the next poll. */
  async pollNow(): Promise<void> {
    await this.#poller?.poll();
  }
}
