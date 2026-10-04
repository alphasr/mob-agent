/** A person (or bot) on the other end of a conversation. */
export interface Participant {
  /** Channel-native id: phone number, Telegram user id, email address, ... */
  id: string;
  name?: string;
}

/** A conversation on a channel. Replies always go to a thread. */
export interface Thread {
  /** Channel-native id: iMessage chat guid, WhatsApp wa_id, Telegram chat id, email thread root Message-ID. */
  id: string;
  channel: string;
  isGroup: boolean;
  /** Email subject; undefined on chat channels. */
  subject?: string;
}

export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  mimeType?: string;
  filename?: string;
  /** Local path or URL; how to fetch it is channel-specific. */
  uri?: string;
}

export interface InboundMessage {
  /** Channel-native message id. Unique within a channel; used for dedupe. */
  id: string;
  channel: string;
  thread: Thread;
  sender: Participant;
  /** Plain text. Empty string when the message is attachment-only. */
  text: string;
  attachments: Attachment[];
  timestamp: Date;
  /** The untouched payload from the channel, for anything the unified model doesn't cover. */
  raw: unknown;
}

export interface OutboundMessage {
  thread: Thread;
  text: string;
  /** The message being answered. Email uses it for In-Reply-To/References headers. */
  replyTo?: InboundMessage;
  /** Recipient when there is no `replyTo` (a proactive message); email needs it to address the mail. */
  to?: string;
}

/** A message that starts a new conversation. */
export interface NewMessage {
  /** Phone number, email address, Telegram chat id, WhatsApp number (digits only). */
  to: string;
  text?: string;
  /** Email only, required there. */
  subject?: string;
  /** WhatsApp only: a pre-approved template, required outside the 24-hour window. */
  template?: MessageTemplate;
}

export interface MessageTemplate {
  name: string;
  /** e.g. "en_US" */
  language: string;
  /** Values for the template body's {{1}}, {{2}}, ... */
  params?: string[];
}

export interface SentMessage {
  id: string;
  channel: string;
  threadId: string;
}

export interface ChannelCapabilities {
  /** Hard limit on one outgoing text; longer replies are split by the agent. */
  maxTextLength?: number;
  typingIndicator: boolean;
  groups: boolean;
}

/** What the agent hands a channel when starting it. */
export interface ChannelContext {
  /** Push a normalized inbound message into the agent. */
  receive(message: InboundMessage): Promise<void>;
  /** Report a non-fatal channel problem (poll failed, bad webhook signature, ...). */
  reportError(error: unknown): void;
  /** Durable key/value scoped to this channel, for cursors like iMessage's last ROWID. */
  state: ChannelState;
}

export interface ChannelState {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/**
 * A messaging channel adapter. Implement this to add a new channel;
 * the agent never talks to a messaging service any other way.
 */
export interface Channel {
  /** Stable, unique name: 'imessage', 'whatsapp', 'telegram', 'email', ... */
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SentMessage>;
  sendTyping?(thread: Thread): Promise<void>;
  /** Start a conversation. Channels that can't (or not yet) leave it out; `agent.send` explains. */
  sendNew?(message: NewMessage): Promise<{ sent: SentMessage; thread: Thread }>;
  /**
   * Verify credentials and permissions without sending anything; used by `textagent doctor`.
   * Must be callable without start() and must only read.
   */
  check?(): Promise<CheckResult[]>;
}

export interface CheckResult {
  /** What was checked, e.g. "Bot token". */
  name: string;
  ok: boolean;
  /** What was found, e.g. "@acme_bot" or the error. */
  detail?: string;
  /** What to do about a failure. */
  fix?: string;
}
