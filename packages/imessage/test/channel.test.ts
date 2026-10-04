import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Agent, MemoryStore } from '@textagent/core';
import type { Thread, TimedAgentEvent } from '@textagent/core';
import { EchoGuard, IMessageChannel, dmRecipient, osascriptArgs } from '../src/index.ts';
import { FakeChatDb } from './fixture.ts';

const DM = 'iMessage;-;+15550001';
const dmThread: Thread = { id: DM, channel: 'imessage', isGroup: false };
const groupThread: Thread = { id: 'iMessage;+;chat99', channel: 'imessage', isGroup: true };

describe('AppleScript sending', { skip: process.platform !== 'darwin' && 'needs macOS' }, () => {
  it('the send script compiles against the real Messages dictionary', () => {
    const args = osascriptArgs(dmThread, 'x');
    const lines = args.slice(0, -3).filter((_, i) => i % 2 === 1);
    const out = join(tmpdir(), `textagent-send-${process.pid}.scpt`);
    try {
      execFileSync('osacompile', ['-o', out, ...lines.flatMap((l) => ['-e', l])], { stdio: 'pipe' });
    } finally {
      rmSync(out, { force: true });
    }
  });

  it('passes hostile text through argv untouched, never as script', () => {
    const nasty = 'He said "hi" \\ & do shell script "touch /tmp/pwned" & "\nline 2 ¬ 😀';
    const echoed = execFileSync(
      'osascript',
      ['-e', 'on run argv', '-e', 'return item 3 of argv', '-e', 'end run', DM, '+15550001', nasty],
      { encoding: 'utf8' },
    );
    assert.equal(echoed.replace(/\n$/, ''), nasty);
  });
});

describe('dmRecipient', () => {
  it('extracts the handle from a DM guid, nothing for groups', () => {
    assert.equal(dmRecipient(dmThread), '+15550001');
    assert.equal(dmRecipient({ ...dmThread, id: 'any;-;someone@icloud.com' }), 'someone@icloud.com');
    assert.equal(dmRecipient(groupThread), undefined);
  });

  it('puts ids and text last in argv', () => {
    assert.deepEqual(osascriptArgs(groupThread, 'yo').slice(-3), ['iMessage;+;chat99', '', 'yo']);
  });
});

describe('EchoGuard', () => {
  it('absorbs exactly one echo per send, per thread', () => {
    const g = new EchoGuard(60_000);
    g.record(DM, 'Sure, 3pm works.', 0);
    assert.equal(g.isEcho('other-thread', 'Sure, 3pm works.', 10), false);
    assert.equal(g.isEcho(DM, ' Sure, 3pm works.\r\n', 10), true);
    assert.equal(g.isEcho(DM, 'Sure, 3pm works.', 20), false, 'second identical text is a real message');
  });

  it('expires after the window and can forget failed sends', () => {
    const g = new EchoGuard(1000);
    g.record(DM, 'a', 0);
    assert.equal(g.isEcho(DM, 'a', 1001), false);
    g.record(DM, 'b', 0);
    g.forget(DM, 'b');
    assert.equal(g.isEcho(DM, 'b', 1), false);
  });
});

describe('IMessageChannel with Agent', () => {
  let fake: FakeChatDb;
  let running: Agent | undefined;
  beforeEach(() => {
    fake = new FakeChatDb();
    fake.chat(DM, 45);
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
    fake.cleanup();
  });

  async function run(sender: (t: Thread, text: string) => Promise<void>) {
    const store = new MemoryStore();
    await store.setState('imessage', 'cursor', '0');
    const channel = new IMessageChannel({ dbPath: fake.path, pollIntervalMs: 60_000, sender });
    const agent = new Agent({ channels: [channel], store, debounceMs: 0 });
    const events: TimedAgentEvent[] = [];
    const handled: string[] = [];
    agent.on('event', (e) => events.push(e));
    agent.on('message', async (ctx) => {
      handled.push(ctx.text);
      await ctx.reply(`You said: ${ctx.text}`);
    });
    await agent.start();
    running = agent;
    /** Poll chat.db and wait for the agent to finish whatever it picked up. */
    const tick = async () => {
      await channel.pollNow();
      await agent.idle();
    };
    return { tick, events, handled };
  }

  it('answers a text, and ignores its own reply echoing back', async () => {
    const sent: Array<[string, string]> = [];
    const { tick, handled } = await run(async (t, text) => {
      sent.push([t.id, text]);
    });

    fake.message({ text: 'hello', from: '+15550001', chat: DM });
    await tick();
    assert.deepEqual(sent, [[DM, 'You said: hello']]);

    // Texting yourself: Messages writes our reply back as an incoming row.
    fake.message({ text: 'You said: hello', from: '+15550001', chat: DM });
    fake.message({ text: 'You said: hello', fromMe: true, chat: DM });
    await tick();

    assert.deepEqual(handled, ['hello'], 'no reply loop');
    assert.equal(sent.length, 1);
  });

  it('reports a failed send and does not swallow a later identical message', async () => {
    let fail = true;
    const sent: string[] = [];
    const { tick, events } = await run(async (_t, text) => {
      if (fail) throw new Error('Messages is not signed in');
      sent.push(text);
    });

    fake.message({ text: 'one', from: '+15550001', chat: DM });
    await tick();
    assert.equal(events.filter((e) => e.type === 'handler.error').length, 1);

    // If the failed reply had stayed in the echo guard, this real message would be dropped.
    fail = false;
    fake.message({ text: 'You said: one', from: '+15550001', chat: DM });
    await tick();
    assert.deepEqual(sent, ['You said: You said: one']);
  });
});

describe('IMessageChannel proactive messages', () => {
  it('texts a number directly, and ignores the echo of that text', async () => {
    const fake = new FakeChatDb();
    fake.chat('iMessage;-;+15550009', 45);
    const sent: Array<[string, string]> = [];
    const channel = new IMessageChannel({ dbPath: fake.path, pollIntervalMs: 60_000, sender: async (t, text) => void sent.push([t.id, text]) });
    const store = new MemoryStore();
    await store.setState('imessage', 'cursor', '0');
    const agent = new Agent({ channels: [channel], store, debounceMs: 0 });
    const handled: string[] = [];
    agent.on('message', (ctx) => void handled.push(ctx.text));
    await agent.start();
    try {
      const [message] = await agent.send({ channel: 'imessage', to: '+15550009', text: 'Your table is ready' });
      assert.equal(message?.threadId, 'iMessage;-;+15550009');
      assert.deepEqual(sent, [['iMessage;-;+15550009', 'Your table is ready']]);
      assert.equal(dmRecipient({ id: message!.threadId, channel: 'imessage', isGroup: false }), '+15550009', 'AppleScript can fall back to the buddy');

      fake.message({ text: 'Your table is ready', from: '+15550009', chat: 'iMessage;-;+15550009' });
      await channel.pollNow();
      await agent.idle();
      assert.deepEqual(handled, [], 'echo of our own proactive text is not answered');
    } finally {
      await agent.stop();
      fake.cleanup();
    }
  });
});
