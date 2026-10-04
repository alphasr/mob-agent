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
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ImapSource } from './imap.ts';
import type { ImapOptions, MailSource } from './imap.ts';
import { normalizeEmail } from './normalize.ts';
import type { EmailRaw } from './normalize.ts';
import { replyReferences, replySubject } from './threading.ts';

export interface SmtpOptions {
  host: string;
  /** Default: 465 */
  port?: number;
  /** Default: true for port 465, otherwise STARTTLS. */
  secure?: boolean;
  user: string;
  pass: string;
}

export interface EmailOptions {
  /** The agent's own address: replies come from it, and mail from it is ignored. */
  address: string;
  /** Display name on replies, e.g. "Acme Support". */
  name?: string;
  imap?: ImapOptions;
  smtp?: SmtpOptions;
  /** Replaces `imap`, e.g. with a provider-webhook source. */
  source?: MailSource;
  /** Replaces `smtp` with any nodemailer transport (SES, a test transport, ...). */
  transport?: Transporter;
}

export function email(options: EmailOptions): EmailChannel {
  return new EmailChannel(options);
}

/**
 * Gmail or Google Workspace. Needs an app password (Google Account → Security →
 * 2-Step Verification → App passwords), not your normal password.
 */
export function gmail(options: { address: string; appPassword: string; name?: string }): EmailChannel {
  const auth = { user: options.address, pass: options.appPassword };
  return new EmailChannel({
    address: options.address,
    ...(options.name && { name: options.name }),
    imap: { host: 'imap.gmail.com', ...auth },
    smtp: { host: 'smtp.gmail.com', ...auth },
  });
}

export class EmailChannel implements Channel {
  readonly name = 'email';
  readonly capabilities: ChannelCapabilities = {
    typingIndicator: false,
    groups: false,
  };

  readonly #options: EmailOptions;
  #source: MailSource | undefined;
  #transport: Transporter | undefined;

  constructor(options: EmailOptions) {
    if (!options.address.includes('@')) throw new Error(`email(): "${options.address}" is not an email address`);
    if (!options.source && !options.imap) throw new Error('email(): pass `imap` settings or a `source`');
    if (!options.transport && !options.smtp) throw new Error('email(): pass `smtp` settings or a `transport`');
    this.#options = options;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.#transport = this.#options.transport ?? createSmtpTransport(this.#options.smtp!);
    if (!this.#options.transport) {
      // Fail at startup on bad SMTP credentials, not on the first reply hours later.
      await this.#transport.verify().catch((error: unknown) => {
        throw new Error(`Could not log in to SMTP: ${(error as Error).message}`, { cause: error });
      });
    }

    this.#source = this.#options.source ?? new ImapSource(this.#options.imap!);
    await this.#source.start({
      state: ctx.state,
      reportError: (error) => ctx.reportError(error),
      deliver: async (source, key) => {
        const result = normalizeEmail(await simpleParser(source), {
          ownAddress: this.#options.address,
          fallbackId: `uid:${key}`,
        });
        if ('message' in result) return ctx.receive(result.message);
        if (result.skip === 'dmarc-fail') {
          // Worth surfacing: someone is sending mail that claims to be from this domain.
          ctx.reportError(new Error(`Dropped email claiming to be from ${result.from}: it failed DMARC`));
        }
      },
    });
  }

  async stop(): Promise<void> {
    await this.#source?.stop();
    this.#transport?.close();
    this.#source = undefined;
    this.#transport = undefined;
  }

  async check(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const loginFix = 'Check the host and password. Gmail needs an app password, not your normal one.';
    if (this.#options.smtp && !this.#options.transport) {
      const transport = createSmtpTransport(this.#options.smtp);
      try {
        await transport.verify();
        results.push({ name: 'Email sending (SMTP)', ok: true, detail: this.#options.smtp.host });
      } catch (error) {
        results.push({ name: 'Email sending (SMTP)', ok: false, detail: (error as Error).message, fix: loginFix });
      } finally {
        transport.close();
      }
    }
    if (this.#options.imap && !this.#options.source) {
      try {
        await new ImapSource(this.#options.imap).check();
        results.push({ name: 'Email receiving (IMAP)', ok: true, detail: this.#options.imap.host });
      } catch (error) {
        results.push({ name: 'Email receiving (IMAP)', ok: false, detail: (error as Error).message, fix: loginFix });
      }
    }
    return results;
  }

  async send({ thread, text, replyTo, to }: OutboundMessage): Promise<SentMessage> {
    if (!this.#transport) throw new Error('Email channel is not started');
    if (replyTo) {
      const raw = replyTo.raw as EmailRaw; // set by normalizeEmail for every email message
      const info = await this.#transport.sendMail({
        from: this.#from(),
        to: replyTo.sender.id,
        subject: replySubject(raw.subject),
        text,
        ...(raw.messageId && { inReplyTo: raw.messageId }),
        references: replyReferences(raw.references, raw.messageId),
        // RFC 3834: tells other autoresponders not to answer us.
        headers: { 'Auto-Submitted': 'auto-replied' },
      });
      return { id: String(info.messageId), channel: this.name, threadId: thread.id };
    }
    // Proactive message in an existing thread: the thread id is its root Message-ID.
    if (!to) throw new Error('Email needs a recipient: pass `to`, or reply to a received message');
    const info = await this.#transport.sendMail({
      from: this.#from(),
      to,
      subject: replySubject(thread.subject),
      text,
      inReplyTo: thread.id,
      references: [thread.id],
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { id: String(info.messageId), channel: this.name, threadId: thread.id };
  }

  /** Start a new email thread. Replies to it come back in the same thread. */
  async sendNew({ to, text, subject, template }: NewMessage): Promise<{ sent: SentMessage; thread: Thread }> {
    if (!this.#transport) throw new Error('Email channel is not started');
    if (template) throw new Error('Email has no message templates; send text');
    if (!text) throw new Error('Email needs text to send');
    if (!subject?.trim()) throw new Error('A new email needs a subject');
    const info = await this.#transport.sendMail({
      from: this.#from(),
      to,
      subject,
      text,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    const id = String(info.messageId);
    const thread: Thread = { id, channel: this.name, isGroup: false, subject };
    return { sent: { id, channel: this.name, threadId: id }, thread };
  }

  #from(): string | { name: string; address: string } {
    return this.#options.name ? { name: this.#options.name, address: this.#options.address } : this.#options.address;
  }
}

function createSmtpTransport(smtp: SmtpOptions): Transporter {
  const port = smtp.port ?? 465;
  return nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: smtp.secure ?? port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}
