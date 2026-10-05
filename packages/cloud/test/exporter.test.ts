import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Agent, serve } from '@textagent/core';
import type {
  AgentOptions,
  Channel,
  ChannelContext,
  InboundMessage,
  RunningServer,
  TimedAgentEvent,
  TurnTrace,
} from '@textagent/core';
import { exporter, hasher } from '../src/index.ts';
import type { Exporter, ExporterOptions, IngestBatch } from '../src/index.ts';

const SECRET = 'x'.repeat(32);
const KEY = 'ingest-key-1';
const PHONE = '+15551234567';
const hash = hasher(SECRET);

/** A dashboard that records batches and answers with `statuses` in turn (200 once they run out). */
class FakeDashboard {
  batches: IngestBatch[] = [];
  bodies: string[] = [];
  auth: Array<string | null> = [];
  statuses: number[] = [];
  #server: RunningServer | undefined;

  async start(path = '/v1/ingest'): Promise<string> {
    this.#server = await serve(
      async (request) => {
        const body = await request.text();
        this.bodies.push(body);
        this.batches.push(JSON.parse(body) as IngestBatch); // written by the exporter under test
        this.auth.push(request.headers.get('authorization'));
        return new Response(null, { status: this.statuses.shift() ?? 200 });
      },
      { port: 0, path },
    );
    return new URL(this.#server.url).origin;
  }

  traces() {
    return this.batches.flatMap((b) => b.traces);
  }

  messages() {
    return this.batches.flatMap((b) => b.messages ?? []);
  }

  async stop() {
    await this.#server?.close();
  }
}

class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  ctx: ChannelContext | undefined;
  #n = 0;
  async start(ctx: ChannelContext) {
    this.ctx = ctx;
  }
  async stop() {}
  async send(m: { thread: { id: string } }) {
    return { id: `out-${this.#n++}`, channel: this.name, threadId: m.thread.id };
  }
  deliver(text: string, sender = PHONE, id = `in-${this.#n++}`) {
    const message: InboundMessage = {
      id,
      channel: this.name,
      thread: { id: sender, channel: this.name, isGroup: false },
      sender: { id: sender, name: 'Ada' },
      text,
      attachments: [],
      timestamp: new Date(),
      raw: {},
    };
    return this.ctx!.receive(message);
  }
}

function turn(n: number): TimedAgentEvent {
  const trace: TurnTrace = {
    id: `turn-${n}`,
    conversation: `fake\u0000${PHONE}\u0000${PHONE}`,
    channel: 'fake',
    threadId: PHONE,
    startedAt: new Date(),
    durationMs: 1,
    messageIds: [`m${n}`],
    sentCount: 0,
    spans: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
  };
  return { type: 'turn.completed', trace, at: new Date() };
}

let dashboard: FakeDashboard;
let base: string;
let agent: Agent | undefined;
let exp: Exporter | undefined;
let errors: string[];

beforeEach(async () => {
  dashboard = new FakeDashboard();
  base = await dashboard.start();
  errors = [];
});

afterEach(async () => {
  await agent?.stop();
  await exp?.close();
  await dashboard.stop();
  agent = undefined;
  exp = undefined;
});

function makeExporter(options: ExporterOptions = {}): Exporter {
  exp = exporter({ url: base, key: KEY, hashSecret: SECRET, onError: (e) => errors.push(e.message), ...options });
  return exp;
}

async function startAgent(
  listener: Exporter,
  reply: string | undefined = 'hi back',
  options: AgentOptions = {},
): Promise<FakeChannel> {
  const channel = new FakeChannel();
  agent = new Agent({ channels: [channel], debounceMs: 0, ...options });
  agent.on('message', async (ctx) => {
    if (reply) await ctx.reply(reply);
  });
  agent.on('event', listener);
  await agent.start();
  return channel;
}

describe('exporter', () => {
  it('sends completed turns with ids hashed and the key as a bearer token', async () => {
    const channel = await startAgent(makeExporter());
    await channel.deliver('secret plans', PHONE, 'msg-1');
    await agent!.idle();
    await exp!.flush();

    assert.equal(dashboard.batches.length, 1);
    assert.equal(dashboard.auth[0], `Bearer ${KEY}`);
    const [trace] = dashboard.traces();
    assert.equal(trace!.threadId, hash(PHONE));
    assert.deepEqual(trace!.messageIds, [hash('msg-1')]);
    assert.equal(trace!.sentCount, 1);
    assert.equal(dashboard.batches[0]!.version, 1);
    assert.equal(dashboard.batches[0]!.messages, undefined);
    for (const leak of [PHONE, 'secret plans', 'hi back', 'Ada', SECRET]) {
      assert.ok(!dashboard.bodies[0]!.includes(leak), leak);
    }
  });

  it('with includeText, sends the texts of accepted messages alongside their turn', async () => {
    const channel = await startAgent(makeExporter({ includeText: true }));
    await channel.deliver('hello', PHONE, 'msg-1');
    await agent!.idle();
    await exp!.flush();

    const messages = dashboard.messages();
    assert.deepEqual(
      messages.map((m) => [m.direction, m.text, m.threadId]),
      [
        ['out', 'hi back', hash(PHONE)],
        ['in', 'hello', hash(PHONE)],
      ],
    );
    assert.equal(messages[1]!.senderId, hash(PHONE));
    assert.ok(!dashboard.bodies[0]!.includes(PHONE));
  });

  it('never sends the text of filtered senders, even with includeText', async () => {
    const channel = await startAgent(makeExporter({ includeText: true }), 'ok', {
      allow: (m) => m.sender.id === PHONE,
    });
    await channel.deliver('from a stranger', '+15550000000');
    await channel.deliver('from the owner');
    await agent!.idle();
    await exp!.flush();

    assert.ok(!dashboard.bodies.join('').includes('stranger'));
    assert.deepEqual(
      dashboard.messages().map((m) => m.text),
      ['ok', 'from the owner'],
    );
  });

  it('keeps a pending text when a duplicate of it is delivered', async () => {
    const listener = makeExporter({ includeText: true });
    const original = inbound('m1');
    const redelivery = inbound('m1');
    const at = new Date();
    listener({ type: 'message.received', message: original, at });
    listener({ type: 'message.received', message: redelivery, at });
    listener({ type: 'message.duplicate', message: redelivery, at });
    listener(turn(1));
    await exp!.flush();
    assert.deepEqual(
      dashboard.messages().map((m) => m.id),
      [hash('m1')],
    );
  });

  it('sends at most 50 traces per request', async () => {
    const listener = makeExporter();
    for (let n = 0; n < 120; n++) listener(turn(n));
    await exp!.flush();
    assert.deepEqual(
      dashboard.batches.map((b) => b.traces.length),
      [50, 50, 20],
    );
    assert.equal(new Set(dashboard.traces().map((t) => t.id)).size, 120);
  });

  it('keeps traces while the dashboard is down, drops the oldest beyond 1,000, and reports once', async () => {
    dashboard.statuses = [503, 503];
    const listener = makeExporter();
    for (let n = 0; n < 1_005; n++) listener(turn(n));
    await exp!.flush(); // the size-triggered attempt and this one: both 503, each carrying the oldest 50
    assert.equal(dashboard.traces().length, 100);

    await exp!.flush();
    const accepted = dashboard.batches.slice(2).flatMap((b) => b.traces);
    assert.equal(accepted.length, 1_000);
    assert.equal(accepted[0]!.id, 'turn-5');
    assert.deepEqual(errors, [
      "can't reach the dashboard (HTTP 503); will retry",
      'dropped 5 trace(s)/message(s): buffer full while the dashboard was unreachable, or over 1 MB',
    ]);
  });

  it('stops for good when the key is rejected', async () => {
    dashboard.statuses = [401];
    const listener = makeExporter();
    listener(turn(1));
    await exp!.flush();
    listener(turn(2));
    await exp!.flush();
    assert.equal(dashboard.batches.length, 1);
    assert.match(errors[0]!, /rejected the ingestion key \(HTTP 401\)/);
    assert.equal(errors.length, 1);
  });

  it('drops a batch the dashboard refuses as malformed and carries on', async () => {
    dashboard.statuses = [400];
    const listener = makeExporter();
    listener(turn(1));
    await exp!.flush();
    listener(turn(2));
    await exp!.flush();
    assert.deepEqual(
      dashboard.batches.map((b) => b.traces[0]!.id),
      ['turn-1', 'turn-2'],
    );
    assert.match(errors[0]!, /refused a batch \(HTTP 400\); dropped 1/);
  });

  it('reports an unreachable dashboard without throwing', async () => {
    await dashboard.stop();
    const listener = makeExporter();
    listener(turn(1));
    await exp!.flush();
    assert.match(errors[0]!, /can't reach the dashboard/);
  });

  it('close() sends what is buffered and ignores later events', async () => {
    const listener = makeExporter();
    listener(turn(1));
    await exp!.close();
    listener(turn(2));
    await exp!.flush();
    assert.deepEqual(
      dashboard.traces().map((t) => t.id),
      ['turn-1'],
    );
  });

  it('keeps a path prefix on the dashboard URL', async () => {
    await dashboard.stop();
    base = `${await dashboard.start('/dash/v1/ingest')}/dash`;
    const listener = makeExporter();
    listener(turn(1));
    await exp!.flush();
    assert.equal(dashboard.batches.length, 1);
  });
});

describe('exporter configuration', () => {
  it('reads settings from the environment and requires all three', () => {
    const saved = { ...process.env };
    try {
      process.env.TEXTAGENT_INGEST_URL = 'https://dash.example.com';
      process.env.TEXTAGENT_KEY = KEY;
      process.env.TEXTAGENT_HASH_SECRET = SECRET;
      void exporter().close();
      process.env.TEXTAGENT_HASH_SECRET = '';
      assert.throws(() => exporter(), /set TEXTAGENT_HASH_SECRET/);
      process.env.TEXTAGENT_HASH_SECRET = 'short';
      assert.throws(() => exporter(), /at least 32 characters/);
      delete process.env.TEXTAGENT_KEY;
      assert.throws(() => exporter({ hashSecret: SECRET }), /set TEXTAGENT_KEY/);
    } finally {
      process.env = saved;
    }
  });

  it('refuses plain http except on localhost', () => {
    const options = { key: KEY, hashSecret: SECRET };
    assert.throws(() => exporter({ ...options, url: 'http://dash.example.com' }), /must be https/);
    assert.throws(() => exporter({ ...options, url: 'not a url' }), /invalid dashboard URL/);
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      void exporter({ ...options, url }).close();
    }
  });
});

function inbound(id: string): InboundMessage {
  return {
    id,
    channel: 'fake',
    thread: { id: PHONE, channel: 'fake', isGroup: false },
    sender: { id: PHONE },
    text: 'pending text',
    attachments: [],
    timestamp: new Date(),
    raw: {},
  };
}
