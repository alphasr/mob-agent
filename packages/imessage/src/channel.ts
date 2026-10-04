import { randomUUID } from 'node:crypto';
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  CheckResult,
  NewMessage,
  OutboundMessage,
  SentMessage,
  Thread,
} from '@textagent/core';
import { EchoGuard } from './echo-guard.ts';
import { ChatDbPoller } from './poller.ts';
import { ChatDbReader, DEFAULT_CHAT_DB } from './reader.ts';
import { appleScriptSender, probeAutomation } from './sender.ts';
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

  async check(): Promise<CheckResult[]> {
    if (process.platform !== 'darwin' && !this.#options.dbPath) {
      return [{ name: 'iMessage', ok: false, detail: 'iMessage only runs on macOS.' }];
    }
    const results: CheckResult[] = [];
    try {
      new ChatDbReader(this.#options.dbPath ?? DEFAULT_CHAT_DB).close();
      results.push({ name: 'iMessage: read Messages (Full Disk Access)', ok: true });
    } catch (error) {
      results.push({ name: 'iMessage: read Messages (Full Disk Access)', ok: false, detail: (error as Error).message });
    }
    // Only the default AppleScript sender needs Automation permission.
    if (!this.#options.sender) {
      const problem = await probeAutomation();
      results.push(
        problem
          ? { name: 'iMessage: send messages (Automation)', ok: false, detail: problem.message }
          : { name: 'iMessage: send messages (Automation)', ok: true },
      );
    }
    return results;
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

  /**
   * Text a phone number or Apple ID email over iMessage. AppleScript can't confirm delivery,
   * and newer macOS may file the person's reply under an "any;-;" chat id (a separate thread).
   */
  async sendNew({ to, text, template }: NewMessage): Promise<{ sent: SentMessage; thread: Thread }> {
    if (template) throw new Error('iMessage has no message templates; send text');
    if (!text) throw new Error('iMessage needs text to send');
    const thread: Thread = { id: `iMessage;-;${to}`, channel: this.name, isGroup: false };
    return { sent: await this.send({ thread, text }), thread };
  }

  /** Read and deliver new messages now instead of waiting for the next poll. */
  async pollNow(): Promise<void> {
    await this.#poller?.poll();
  }
}
