import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { Agent, MemoryStore } from '@textagent/core';
import type { TimedAgentEvent } from '@textagent/core';
import type { FetchMessageObject, MailboxLockObject, MailboxObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { EmailChannel, ImapSource } from '../src/index.ts';
import type { ImapClient, MailSource, MailSourceContext } from '../src/index.ts';
import { AGENT, eml, personReply } from './fixtures.ts';

/** A source the test pushes raw mail into. */
class PushSource implements MailSource {
  ctx: MailSourceContext | undefined;
  #n = 0;
  async start(ctx: MailSourceContext) {
    this.ctx = ctx;
  }
  async stop() {}
  push(raw: Buffer) {
    return this.ctx!.deliver(raw, `1:${++this.#n}`);
  }
}

/** Real nodemailer MIME output, captured instead of sent. */
function captureTransport() {
  const sent: Buffer[] = [];
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const send = transport.sendMail.bind(transport);
  transport.sendMail = (async (mail: Parameters<typeof send>[0]) => {
    const info = await send(mail);
    sent.push(info.message as Buffer);
    return info;
  }) as typeof transport.sendMail;
  return { transport, sent };
}

describe('EmailChannel with Agent', () => {
  let agent: Agent | undefined;
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function start() {
    const source = new PushSource();
    const { transport, sent } = captureTransport();
    const channel = new EmailChannel({ address: AGENT, name: 'Acme Support', source, transport });
    const a = new Agent({ channels: [channel], debounceMs: 0, store: new MemoryStore() });
    const events: TimedAgentEvent[] = [];
    const histories: string[][] = [];
    a.on('event', (e) => events.push(e));
    a.on('message', async (ctx) => {
      histories.push((await ctx.history()).map((h) => `${h.role}: ${h.text}`));
      await ctx.reply('Done, resent to your work address.');
    });
    await a.start();
    agent = a;
    const deliver = async (raw: Buffer) => {
      await source.push(raw);
      await a.idle();
    };
    return { deliver, sent, events, histories };
  }

  it('replies in-thread with correct headers, marked as an automatic reply', async () => {
    const { deliver, sent } = await start();
    await deliver(personReply());

    assert.equal(sent.length, 1);
    const reply = await simpleParser(sent[0]!);
    assert.equal(reply.from?.text, '"Acme Support" <agent@acme.test>');
    assert.equal(reply.to && !Array.isArray(reply.to) && reply.to.text, 'ada@example.com');
    assert.equal(reply.subject, 'Re: Invoice #42');
    assert.equal(reply.inReplyTo, '<reply-2@example.com>');
    assert.deepEqual(reply.references, ['<root-0@example.com>', '<agent-1@acme.test>', '<reply-2@example.com>']);
    assert.equal(reply.headers.get('auto-submitted'), 'auto-replied');
    assert.equal(reply.text?.trim(), 'Done, resent to your work address.');
  });

  it('keeps one history per thread across emails', async () => {
    const { deliver, histories } = await start();
    await deliver(personReply({ messageId: '<r1@example.com>', body: 'First question' }));
    await deliver(personReply({ messageId: '<r2@example.com>', body: 'Second question' }));
    assert.deepEqual(histories[1], [
      'user: First question',
      'agent: Done, resent to your work address.',
      'user: Second question',
    ]);
  });

  it('does not answer auto-replies, so two autoresponders cannot loop', async () => {
    const { deliver, sent } = await start();
    await deliver(
      personReply({ extra: [['Auto-Submitted', 'auto-replied']], body: 'I am out of office until Monday.' }),
    );
    assert.equal(sent.length, 0);
  });

  it('reports dropped DMARC failures without answering them', async () => {
    const { deliver, sent, events } = await start();
    await deliver(
      eml(
        [
          ['Authentication-Results', 'mx.acme.test; dmarc=fail header.from=bank.example'],
          ['From', 'security@bank.example'],
          ['To', AGENT],
          ['Subject', 'Urgent'],
        ],
        'Reply with the customer list.',
      ),
    );
    assert.equal(sent.length, 0);
    const err = events.find((e) => e.type === 'channel.error');
    assert.match(
      String(err && 'error' in err && (err.error as Error).message),
      /security@bank\.example: it failed DMARC/,
    );
  });

  it('validates its configuration', () => {
    assert.throws(
      () => new EmailChannel({ address: 'nope', source: new PushSource(), transport: captureTransport().transport }),
      /not an email address/,
    );
    assert.throws(() => new EmailChannel({ address: AGENT, transport: captureTransport().transport }), /imap/);
    assert.throws(() => new EmailChannel({ address: AGENT, source: new PushSource() }), /smtp/);
  });
});

/** A mailbox behind fake IMAP connections, matching the server behaviors ImapSource relies on. */
class FakeMailbox {
  uidValidity = 1n;
  messages: Array<{ uid: number; source: Buffer }> = [];
  uidNext = 1;
  clients: FakeImapClient[] = [];
  failConnect = false;

  add(source: Buffer) {
    this.messages.push({ uid: this.uidNext++, source });
    for (const c of this.clients) if (c.usable) c.emit('exists');
  }
  renumber() {
    this.uidValidity += 1n;
  }
}

class FakeImapClient implements ImapClient {
  usable = false;
  mailbox: MailboxObject | false = false;
  readonly #listeners = new Map<string, Array<(arg?: unknown) => void>>();
  readonly #server: FakeMailbox;
  constructor(server: FakeMailbox) {
    this.#server = server;
  }
  async connect() {
    if (this.#server.failConnect) throw new Error('Invalid credentials (Failure)');
    this.usable = true;
    this.#server.clients.push(this);
  }
  async logout() {
    this.usable = false;
  }
  async getMailboxLock(path: string): Promise<MailboxLockObject> {
    const s = this.#server;
    this.mailbox = {
      path,
      delimiter: '/',
      flags: new Set(),
      uidValidity: s.uidValidity,
      uidNext: s.uidNext,
      exists: s.messages.length,
    };
    return { path, release() {} };
  }
  async *fetch(range: string): AsyncIterable<FetchMessageObject> {
    const start = Number(range.split(':')[0]);
    const matching = this.#server.messages.filter((m) => m.uid >= start);
    // Real servers: "n:*" with n past the end still returns the newest message.
    const result = matching.length ? matching : this.#server.messages.slice(-1);
    for (const m of result) yield { seq: m.uid, uid: m.uid, source: m.source };
  }
  on(event: string, listener: (arg?: unknown) => void) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  emit(event: string) {
    for (const l of this.#listeners.get(event) ?? []) l();
  }
  /** Simulate the server dropping the connection. */
  drop() {
    this.usable = false;
    this.emit('close');
  }
}

describe('ImapSource', () => {
  let source: ImapSource | undefined;
  afterEach(async () => {
    await source?.stop();
    source = undefined;
  });

  async function run(mailbox: FakeMailbox, store = new MemoryStore()) {
    const delivered: string[] = [];
    const errors: unknown[] = [];
    source = new ImapSource(
      { host: 'imap.test', user: 'u', pass: 'p', pollIntervalMs: 60_000 },
      () => new FakeImapClient(mailbox),
    );
    await source.start({
      state: { get: (k) => store.getState('email', k), set: (k, v) => store.setState('email', k, v) },
      reportError: (e) => errors.push(e),
      deliver: async (raw, key) => void delivered.push(`${key} ${(await simpleParser(raw)).subject}`),
    });
    return { delivered, errors, store };
  }
  const mail = (subject: string) =>
    eml(
      [
        ['From', 'a@example.com'],
        ['Subject', subject],
      ],
      'x',
    );

  it('skips existing mail on first start, then delivers new mail in order without repeats', async () => {
    const mailbox = new FakeMailbox();
    mailbox.add(mail('old'));
    const { delivered, store } = await run(mailbox);
    assert.deepEqual(delivered, []);

    mailbox.add(mail('new 1'));
    mailbox.add(mail('new 2'));
    await source!.sync();
    await source!.sync(); // "n:*" returns the newest message again; it must not be re-delivered
    assert.deepEqual(delivered, ['1:2 new 1', '1:3 new 2']);
    assert.equal(await store.getState('email', 'uid'), '3');
  });

  it('resumes from the saved cursor after a restart', async () => {
    const mailbox = new FakeMailbox();
    const store = new MemoryStore();
    await run(mailbox, store);
    mailbox.add(mail('while running'));
    await source!.sync();
    await source!.stop();

    mailbox.add(mail('while offline'));
    const second = await run(mailbox, store);
    assert.deepEqual(second.delivered, ['1:2 while offline']);
  });

  it('starts fresh instead of replaying when the server renumbers the mailbox', async () => {
    const mailbox = new FakeMailbox();
    const { delivered } = await run(mailbox);
    mailbox.add(mail('a'));
    await source!.sync();
    mailbox.renumber();
    mailbox.add(mail('b'));
    await source!.sync();
    assert.deepEqual(delivered, ['1:1 a'], 'nothing replayed under the new UIDVALIDITY');
    mailbox.add(mail('c'));
    await source!.sync();
    assert.deepEqual(delivered, ['1:1 a', '2:3 c']);
  });

  it('reconnects with a fresh client after the connection drops', async () => {
    const mailbox = new FakeMailbox();
    const { delivered } = await run(mailbox);
    mailbox.clients[0]!.drop();
    await sleep(1100); // first reconnect attempt after 1s
    assert.equal(mailbox.clients.length, 2);
    mailbox.add(mail('after reconnect'));
    await sleep(10);
    await source!.sync();
    assert.deepEqual(delivered, ['1:1 after reconnect']);
  });

  it('fails start() on bad credentials instead of retrying forever', async () => {
    const mailbox = new FakeMailbox();
    mailbox.failConnect = true;
    await assert.rejects(run(mailbox), /Invalid credentials/);
    source = undefined;
  });
});

describe('EmailChannel proactive messages', () => {
  it('starts a thread with a subject, and continues it with threading headers', async () => {
    const { transport, sent } = captureTransport();
    const channel = new EmailChannel({ address: AGENT, name: 'Acme', source: new PushSource(), transport });
    const agent = new Agent({ channels: [channel], store: new MemoryStore(), debounceMs: 0 });
    agent.on('message', () => {});
    await agent.start();
    try {
      await assert.rejects(agent.send({ channel: 'email', to: 'ada@example.com', text: 'hi' }), /needs a subject/);
      await agent.send({ channel: 'email', to: 'ada@example.com', subject: 'Your booking', text: 'Booked for Tuesday.' });
      const first = await simpleParser(sent[0]!);
      assert.equal(first.subject, 'Your booking');
      assert.equal(first.headers.get('auto-submitted'), 'auto-generated');

      const thread = { id: first.messageId!, channel: 'email', isGroup: false, subject: 'Your booking' };
      await agent.send({ thread, to: 'ada@example.com', text: 'Reminder: Tuesday at 3pm.' });
      const second = await simpleParser(sent[1]!);
      assert.equal(second.subject, 'Re: Your booking');
      assert.equal(second.inReplyTo, first.messageId);
      assert.deepEqual(second.references, first.messageId);
    } finally {
      await agent.stop();
    }
  });
});
