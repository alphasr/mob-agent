import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Agent, MemoryStore } from '@textagent/core';
import type { InboundMessage, TimedAgentEvent } from '@textagent/core';
import { WhatsAppChannel, isValidSignature, messagesFromPayload } from '../src/index.ts';

const SECRET = 'app-secret-123';
const PHONE_ID = '1098765';
const TOKEN = 'EAAG-secret-access-token';
const VERIFY = 'my-verify-token';

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function payload(messages: unknown[], opts: { phoneId?: string; statuses?: unknown[] } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000', phone_number_id: opts.phoneId ?? PHONE_ID },
              contacts: [{ wa_id: '447700900123', profile: { name: 'Ada' } }],
              messages,
              ...(opts.statuses && { statuses: opts.statuses }),
            },
          },
        ],
      },
    ],
  };
}

const text = (body: string, id = 'wamid.A1') => ({
  from: '447700900123',
  id,
  timestamp: '1790000000',
  type: 'text',
  text: { body },
});

function webhook(body: unknown, signature?: string | null): Request {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = signature === undefined ? sign(raw) : signature;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return new Request('https://example.com/webhook', { method: 'POST', headers, body: raw });
}

describe('isValidSignature', () => {
  const body = Buffer.from('{"hello":"world"}');
  it('accepts the right HMAC and rejects everything else', () => {
    assert.equal(isValidSignature(body, sign(body.toString()), SECRET), true);
    assert.equal(isValidSignature(body, sign(body.toString(), 'wrong-secret'), SECRET), false);
    assert.equal(isValidSignature(Buffer.from('{"hello":"world!"}'), sign(body.toString()), SECRET), false);
    assert.equal(isValidSignature(body, null, SECRET), false);
    assert.equal(isValidSignature(body, 'sha256=abcd', SECRET), false, 'short signature must not throw');
    assert.equal(isValidSignature(body, sign(body.toString()).replace('sha256=', 'sha1='), SECRET), false);
  });
});

describe('messagesFromPayload', () => {
  it('normalizes text with the contact name', () => {
    const [m] = messagesFromPayload(payload([text(' hi ')]), PHONE_ID);
    assert.equal(m?.id, 'wamid.A1');
    assert.equal(m?.text, 'hi');
    assert.deepEqual(m?.sender, { id: '447700900123', name: 'Ada' });
    assert.deepEqual(m?.thread, { id: '447700900123', channel: 'whatsapp', isGroup: false });
    assert.equal(m?.timestamp.getTime(), 1_790_000_000_000);
  });

  it('maps button/list replies and media; skips reactions, locations and unsupported', () => {
    const base = { from: '447700900123', timestamp: '1790000000' };
    const ms = messagesFromPayload(
      payload([
        {
          ...base,
          id: 'w1',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'y', title: 'Yes' } },
        },
        {
          ...base,
          id: 'w2',
          type: 'interactive',
          interactive: { type: 'list_reply', list_reply: { id: 's', title: 'Small' } },
        },
        { ...base, id: 'w3', type: 'button', button: { text: 'Confirm', payload: 'c' } },
        { ...base, id: 'w4', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'receipt' } },
        {
          ...base,
          id: 'w5',
          type: 'document',
          document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'bill.pdf' },
        },
        { ...base, id: 'w6', type: 'reaction', reaction: { message_id: 'w1', emoji: '👍' } },
        { ...base, id: 'w7', type: 'location', location: { latitude: 1, longitude: 2 } },
        { ...base, id: 'w8', type: 'unsupported', unsupported: {} },
      ]),
      PHONE_ID,
    );
    assert.deepEqual(
      ms.map((m) => [m.id, m.text]),
      [
        ['w1', 'Yes'],
        ['w2', 'Small'],
        ['w3', 'Confirm'],
        ['w4', 'receipt'],
        ['w5', ''],
      ],
    );
    assert.deepEqual(ms[3]?.attachments, [{ kind: 'image', uri: 'whatsapp-media:MEDIA1', mimeType: 'image/jpeg' }]);
    assert.equal(ms[4]?.attachments[0]?.filename, 'bill.pdf');
  });

  it('ignores statuses, other phone numbers and malformed input without throwing', () => {
    assert.deepEqual(messagesFromPayload(payload([], { statuses: [{ id: 'wamid.X', status: 'read' }] }), PHONE_ID), []);
    assert.deepEqual(messagesFromPayload(payload([text('hi')], { phoneId: 'other' }), PHONE_ID), []);
    for (const junk of [null, 'x', [], { object: 'page' }, { object: 'whatsapp_business_account', entry: 'nope' }]) {
      assert.deepEqual(messagesFromPayload(junk, PHONE_ID), []);
    }
    const missingFields = payload([
      { id: 'w', type: 'text', text: { body: 'no sender' } },
      { from: '1', id: 'w2', timestamp: 'soon', type: 'text', text: { body: 'bad time' } },
    ]);
    assert.deepEqual(messagesFromPayload(missingFields, PHONE_ID), []);
  });
});

/** Fake Graph API: records requests, answers /messages, optionally fails with a Graph error. */
class FakeGraph {
  readonly requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> | undefined }> = [];
  failWith: { status: number; code: number; message: string } | undefined;
  #n = 0;
  #server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    this.requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (this.failWith) {
      const { status, code, message } = this.failWith;
      res.writeHead(status).end(JSON.stringify({ error: { message, code, type: 'OAuthException' } }));
      return;
    }
    res.end(
      JSON.stringify(body?.status === 'read' ? { success: true } : { messages: [{ id: `wamid.OUT${++this.#n}` }] }),
    );
  });
  async listen() {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }
  close() {
    this.#server.closeAllConnections();
    return new Promise((r) => this.#server.close(r));
  }
  sends() {
    return this.requests.filter((r) => r.body?.type === 'text').map((r) => r.body);
  }
}

describe('WhatsAppChannel with Agent', () => {
  let graph: FakeGraph;
  let apiBase: string;
  let agent: Agent | undefined;

  beforeEach(async () => {
    graph = new FakeGraph();
    apiBase = await graph.listen();
  });
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await graph.close();
  });

  async function start(opts: { port?: number; reply?: (t: string) => string } = {}) {
    const channel = new WhatsAppChannel({
      accessToken: TOKEN,
      phoneNumberId: PHONE_ID,
      appSecret: SECRET,
      verifyToken: VERIFY,
      apiBase,
      ...(opts.port !== undefined && { port: opts.port }),
    });
    const a = new Agent({ channels: [channel], debounceMs: 0, store: new MemoryStore() });
    const events: TimedAgentEvent[] = [];
    const handled: InboundMessage[] = [];
    a.on('event', (e) => events.push(e));
    a.on('message', async (ctx) => {
      handled.push(ctx.message);
      await ctx.typing();
      await ctx.reply(opts.reply ? opts.reply(ctx.text) : `echo: ${ctx.text}`);
    });
    await a.start();
    agent = a;
    /** Wait until delivered webhooks reached the agent and it finished handling them. */
    const settle = async () => {
      await channel.drain();
      await a.idle();
    };
    return { channel, events, handled, settle };
  }

  it('answers the subscription check only with the right verify token', async () => {
    const { channel } = await start();
    const ok = await channel.handleRequest(
      new Request(`https://x/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`),
    );
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    const bad = await channel.handleRequest(
      new Request('https://x/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1'),
    );
    assert.equal(bad.status, 403);
  });

  it('rejects unsigned, forged and oversized webhooks before reading them', async () => {
    const { channel, handled, settle, events } = await start();
    assert.equal((await channel.handleRequest(webhook(payload([text('x')]), null))).status, 401);
    assert.equal((await channel.handleRequest(webhook(payload([text('x')]), sign('{}')))).status, 401);
    const forged = JSON.stringify(payload([text('x')]));
    assert.equal((await channel.handleRequest(webhook(forged, sign(forged, 'attacker-secret')))).status, 401);
    const huge = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal((await channel.handleRequest(webhook(huge))).status, 413);
    assert.equal((await channel.handleRequest(webhook('not json'))).status, 400);
    await settle();
    assert.equal(handled.length, 0);
    assert.equal(events.filter((e) => e.type === 'channel.error').length, 3, 'each bad signature is reported');
  });

  it('acknowledges, replies with typing first, and sends the token only in the header', async () => {
    const { channel, handled, settle } = await start();
    const res = await channel.handleRequest(webhook(payload([text('hello')])));
    assert.equal(res.status, 200);
    await settle();

    assert.equal(handled.length, 1);
    assert.deepEqual(
      graph.requests.map((r) => r.body?.status ?? r.body?.type),
      ['read', 'text'],
    );
    assert.deepEqual(graph.requests[0]?.body, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.A1',
      typing_indicator: { type: 'text' },
    });
    assert.deepEqual(graph.sends(), [
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '447700900123',
        type: 'text',
        text: { body: 'echo: hello', preview_url: false },
      },
    ]);
    assert.ok(graph.requests.every((r) => r.auth === `Bearer ${TOKEN}` && !r.path.includes(TOKEN)));
    assert.equal(graph.requests[1]?.path, `/v23.0/${PHONE_ID}/messages`);
  });

  it('answers a retried webhook only once', async () => {
    const { channel, handled, settle } = await start();
    const body = payload([text('pay my bill')]);
    await channel.handleRequest(webhook(body));
    await channel.handleRequest(webhook(body));
    await settle();
    assert.equal(handled.length, 1);
    assert.equal(graph.sends().length, 1);
  });

  it('splits long replies at 4096 characters', async () => {
    const { channel, settle } = await start({ reply: () => 'word '.repeat(2000) });
    await channel.handleRequest(webhook(payload([text('long')])));
    await settle();
    const bodies = graph.sends().map((b) => (b?.text as { body: string }).body);
    assert.equal(bodies.length, 3);
    assert.ok(bodies.every((b) => b.length <= 4096));
  });

  it('explains the 24-hour window and never leaks the token', async () => {
    graph.failWith = { status: 400, code: 131047, message: `Re-engagement message (token ${TOKEN})` };
    const { channel, events, settle } = await start();
    await channel.handleRequest(webhook(payload([text('late')])));
    await settle();
    const err = events.find((e) => e.type === 'handler.error');
    const message = String(err && 'error' in err && (err.error as Error).message);
    assert.match(message, /24 hours/);
    assert.ok(!message.includes(TOKEN), message);
  });

  it('returns 503 before start so Meta retries', async () => {
    const channel = new WhatsAppChannel({
      accessToken: TOKEN,
      phoneNumberId: PHONE_ID,
      appSecret: SECRET,
      verifyToken: VERIFY,
    });
    assert.equal((await channel.handleRequest(webhook(payload([text('early')])))).status, 503);
  });

  it('serves the same handler over its built-in HTTP server', async () => {
    const { channel, handled, settle } = await start({ port: 0 });
    const url = channel.url!;
    const raw = JSON.stringify(payload([text('over http')]));
    const res = await fetch(url, { method: 'POST', headers: { 'x-hub-signature-256': sign(raw) }, body: raw });
    assert.equal(res.status, 200);
    assert.equal((await fetch(url.replace('/webhook', '/other'))).status, 404);
    const verify = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc`);
    assert.equal(await verify.text(), 'abc');
    await settle();
    assert.deepEqual(
      handled.map((m) => m.text),
      ['over http'],
    );
  });

  it('check() looks up the phone number read-only, and explains a bad token', async () => {
    const channel = new WhatsAppChannel({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: SECRET, verifyToken: VERIFY, apiBase });
    assert.equal((await channel.check())[0]?.ok, true);
    assert.equal(graph.requests.at(-1)?.body, undefined, 'a GET, nothing sent');

    graph.failWith = { status: 401, code: 190, message: 'Error validating access token' };
    const [result] = await channel.check();
    assert.equal(result?.ok, false);
    assert.match(result?.detail ?? '', /invalid or expired/);
  });

  it('sendNew sends templates any time, text only inside the 24-hour window', async () => {
    const { channel, settle } = await start();
    await channel.sendNew({ to: '+447700900999', template: { name: 'appointment_reminder', language: 'en_US', params: ['Tue 3pm'] } });
    assert.deepEqual(graph.requests.at(-1)?.body, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '447700900999',
      type: 'template',
      template: {
        name: 'appointment_reminder',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Tue 3pm' }] }],
      },
    });

    const before = graph.requests.length;
    await assert.rejects(channel.sendNew({ to: '447700900999', text: 'free text' }), /24 hours.*template/);
    assert.equal(graph.requests.length, before, 'refused before calling Meta');

    // Once the person writes, free text is allowed, through agent.send too.
    const recent = { ...text('hi again', 'wamid.W1'), timestamp: String(Math.floor(Date.now() / 1000)) };
    await channel.handleRequest(webhook(payload([recent])));
    await settle();
    await agent!.send({ channel: 'whatsapp', to: '447700900123', text: 'Following up!' });
    assert.equal((graph.sends().at(-1)?.text as { body: string }).body, 'Following up!');
  });

  it('refuses proactive text to a thread whose window has closed', async () => {
    const { channel, settle } = await start();
    const old = { ...text('a while ago', 'wamid.OLD'), timestamp: String(Math.floor(Date.now() / 1000) - 25 * 3600) };
    await channel.handleRequest(webhook(payload([old])));
    await settle();
    const before = graph.sends().length;
    await assert.rejects(
      agent!.send({ thread: { id: '447700900123', channel: 'whatsapp', isGroup: false }, text: 'ping' }),
      /24 hours/,
    );
    assert.equal(graph.sends().length, before, 'no proactive send went out');
  });
});
