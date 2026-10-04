import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, describe, it } from 'node:test';
import { Agent, MemoryStore, SqliteStore, StoreScheduler } from '../src/index.ts';
import type {
  AgentOptions,
  Channel,
  ChannelContext,
  JobRecord,
  NewMessage,
  OutboundMessage,
  Scheduler,
  SentMessage,
  Store,
  Thread,
  TimedAgentEvent,
} from '../src/index.ts';

class RecordingChannel implements Channel {
  readonly name = 'fake';
  readonly capabilities = { typingIndicator: false, groups: false };
  readonly sent: string[] = [];
  #n = 0;
  async start(_ctx: ChannelContext) {}
  async stop() {}
  async send(m: OutboundMessage): Promise<SentMessage> {
    this.sent.push(`${m.thread.id}: ${m.text}`);
    return { id: `out-${this.#n++}`, channel: this.name, threadId: m.thread.id };
  }
  async sendNew(m: NewMessage) {
    const thread: Thread = { id: `t-${m.to}`, channel: this.name, isGroup: false };
    this.sent.push(`${thread.id}: ${m.text}`);
    return { sent: { id: `new-${this.#n++}`, channel: this.name, threadId: thread.id }, thread };
  }
}

const thread: Thread = { id: 'th1', channel: 'fake', isGroup: false };
const soon = (ms = 40) => new Date(Date.now() + ms);

describe('agent.schedule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'textagent-schedule-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let running: Agent[] = [];
  afterEach(async () => {
    for (const a of running) await a.stop();
    running = [];
  });

  async function start(store: Store, options: Partial<AgentOptions> = {}) {
    const channel = new RecordingChannel();
    const agent = new Agent({
      channels: [channel],
      store,
      debounceMs: 0,
      scheduler: new StoreScheduler(store, { pollIntervalMs: 20 }),
      ...options,
    });
    const events: TimedAgentEvent[] = [];
    agent.on('event', (e) => events.push(e));
    agent.on('message', () => {});
    await agent.start();
    running.push(agent);
    return { agent, channel, events };
  }

  it('sends at the due time, records history, and reports events', async () => {
    const store = new MemoryStore();
    const { agent, channel, events } = await start(store);
    const job = await agent.schedule({ at: soon(), thread, text: 'Reminder: dentist at 3pm' });
    assert.equal(job.status, 'pending');
    assert.deepEqual(channel.sent, []);

    await sleep(120);
    assert.deepEqual(channel.sent, ['th1: Reminder: dentist at 3pm']);
    assert.equal((await agent.listScheduled({ thread }))[0]?.status, 'sent');
    assert.deepEqual(
      (await store.getHistory('fake', 'th1', 5)).map((h) => h.text),
      ['Reminder: dentist at 3pm'],
    );
    assert.deepEqual(
      events.filter((e) => e.type.startsWith('schedule.')).map((e) => e.type),
      ['schedule.created', 'schedule.sent'],
    );
  });

  it('survives a restart with SqliteStore', async () => {
    const path = join(dir, 'restart.sqlite');
    const first = await start(new SqliteStore(path));
    await first.agent.schedule({ at: soon(150), channel: 'fake', to: '+1555', text: 'Your table is ready' });
    await first.agent.stop();
    running = [];

    const second = await start(new SqliteStore(path));
    await sleep(250);
    assert.deepEqual(second.channel.sent, ['t-+1555: Your table is ready']);
  });

  it('drops a message that is too late because the agent was down', async () => {
    const path = join(dir, 'late.sqlite');
    const first = await start(new SqliteStore(path));
    await first.agent.schedule({ at: soon(20), thread, text: '3pm reminder' });
    await first.agent.stop();
    running = [];
    await sleep(80);

    const second = await start(new SqliteStore(path), { scheduleGraceMs: 30 });
    await sleep(60);
    assert.deepEqual(second.channel.sent, [], 'not sent hours late');
    const [job] = await second.agent.listScheduled();
    assert.equal(job?.status, 'expired');
    assert.ok(second.events.some((e) => e.type === 'schedule.expired'));
  });

  it('never resends a message that was mid-send during a crash', async () => {
    const store = new MemoryStore();
    const crashed: JobRecord = {
      id: 'crashed',
      conversation: 'fake:th1',
      at: new Date(Date.now() - 10 * 60_000),
      request: JSON.stringify({ thread, text: 'maybe sent already' }),
      status: 'sending',
      attempts: 0,
      createdAt: new Date(Date.now() - 20 * 60_000),
      claimedAt: new Date(Date.now() - 10 * 60_000),
    };
    await store.addJob(crashed);
    const { agent, channel } = await start(store);
    await sleep(60);
    assert.deepEqual(channel.sent, []);
    assert.equal((await agent.listScheduled())[0]?.status, 'unknown');
  });

  it('replaces by key, cancels by key or id', async () => {
    const { agent, channel } = await start(new MemoryStore());
    await agent.schedule({ at: soon(5_000), key: 'booking-42', thread, text: 'Tuesday 3pm' });
    await agent.schedule({ at: soon(80), key: 'booking-42', thread, text: 'Moved: Wednesday 3pm' });
    const pending = await agent.listScheduled({ status: 'pending' });
    assert.deepEqual(
      pending.map((j) => j.request),
      [{ thread, text: 'Moved: Wednesday 3pm' }],
    );

    const other = await agent.schedule({ at: soon(5_000), thread, text: 'other' });
    assert.equal(await agent.cancelScheduled({ id: other.id }), true);
    assert.equal(await agent.cancelScheduled({ id: other.id }), false, 'already canceled');

    await sleep(160);
    assert.deepEqual(channel.sent, ['th1: Moved: Wednesday 3pm']);
    assert.equal(await agent.cancelScheduled({ key: 'booking-42' }), false, 'already sent');
  });

  it('validates requests and limits pending messages per conversation', async () => {
    const { agent } = await start(new MemoryStore(), { maxScheduledPerConversation: 2 });
    await assert.rejects(agent.schedule({ at: new Date(Date.now() - 120_000), thread, text: 'x' }), /in the past/);
    await assert.rejects(agent.schedule({ at: new Date(Date.now() + 400 * 86_400_000), thread, text: 'x' }), /a year/);
    await assert.rejects(
      agent.schedule({ at: soon(), thread: { ...thread, channel: 'nope' }, text: 'x' }),
      /No channel/,
    );
    await assert.rejects(agent.schedule({ at: soon(), thread, text: '  ' }), /needs text/);
    await assert.rejects(agent.schedule({ at: soon(), channel: 'fake', to: '', text: 'x' }), /needs `to`/);

    await agent.schedule({ at: soon(5_000), key: 'a', thread, text: '1' });
    await agent.schedule({ at: soon(5_000), thread, text: '2' });
    await assert.rejects(agent.schedule({ at: soon(5_000), thread, text: '3' }), /limit 2/);
    await agent.schedule({ at: soon(6_000), key: 'a', thread, text: '1 moved' }); // replacing doesn't add
  });

  it('retries a send blocked by the proactive rate limit', async () => {
    const { agent, channel, events } = await start(new MemoryStore(), { proactivePerMinute: 1 });
    await agent.schedule({ at: soon(30), channel: 'fake', to: 'a', text: 'first' });
    await agent.schedule({ at: soon(30), channel: 'fake', to: 'b', text: 'second' });
    await sleep(120);
    assert.deepEqual(channel.sent, ['t-a: first']);
    const retried = (await agent.listScheduled({ status: 'pending' }))[0];
    assert.equal(retried?.attempts, 1);
    assert.ok(retried!.at.getTime() > Date.now() + 50_000, 'retry about a minute later');
    assert.ok(events.some((e) => e.type === 'schedule.retrying'));
  });

  it('lets two processes share a database without double-sending', async () => {
    const path = join(dir, 'shared.sqlite');
    const a = new SqliteStore(path);
    const b = new SqliteStore(path);
    for (let i = 0; i < 10; i++) {
      await a.addJob({
        id: `j${i}`,
        conversation: 'c',
        at: new Date(Date.now() - 1000),
        request: '{}',
        status: 'pending',
        attempts: 0,
        createdAt: new Date(),
      });
    }
    const [fromA, fromB] = await Promise.all([a.claimDueJobs(new Date(), 6), b.claimDueJobs(new Date(), 6)]);
    const ids = [...fromA, ...fromB].map((j) => j.id).sort();
    assert.deepEqual(ids, [...new Set(ids)], 'no job claimed twice');
    assert.equal(ids.length, 10);
    await a.close();
    await b.close();
  });

  it('accepts a custom Scheduler', async () => {
    const added: JobRecord[] = [];
    const custom: Scheduler = {
      start: async () => {},
      stop: async () => {},
      add: async (job) => void added.push(job),
      cancel: async () => false,
      list: async () => [],
    };
    const { agent } = await start(new MemoryStore(), { scheduler: custom });
    await agent.schedule({ at: soon(5_000), thread, text: 'via queue' });
    assert.equal(added.length, 1);
    assert.deepEqual(JSON.parse(added[0]!.request), { thread, text: 'via queue' });
  });
});
