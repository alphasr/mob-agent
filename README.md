# textagent

> **Alpha.** Not yet published to npm. APIs will change.

Build AI agents that people text, instead of apps they have to install.
Write your agent once; textagent runs it over **iMessage, WhatsApp, Telegram and email**.

```ts
import { Agent, SqliteStore } from '@textagent/core';

const agent = new Agent({
  channels: [/* imessage(), whatsapp({...}), telegram({...}), email({...}) */],
  store: new SqliteStore('agent.sqlite'),
  allow: (msg) => msg.sender.id === '+15551234567',
});

agent.on('message', async (ctx) => {
  await ctx.typing();
  const history = await ctx.history(); // last 20 messages in this thread, oldest first
  await ctx.reply(await yourModel(history));
});

agent.on('event', (e) => console.log(e.at.toISOString(), e.type));

await agent.start();
```

## What the core handles for every channel

- **Dedupe**: webhook retries and restarts never produce a second reply.
- **Batching**: "hey" / "quick q" / "what's the weather" sent in a burst becomes one turn.
- **Ordering**: one turn at a time per conversation; different conversations run in parallel.
- **Splitting**: replies over a channel's length limit are split at paragraph, sentence, then word boundaries.
- **History**: per-thread conversation memory, stored in SQLite (built into Node, no native deps).
- **Filtering**: allowlist and group-chat controls.
- **Observability**: typed events for every receive, filter, handler run, send and error.

## Packages

| Package | Status |
| --- | --- |
| `@textagent/core` | Agent, channel interface, stores |
| `@textagent/imessage` | Reader done; sender in progress. macOS only |
| `@textagent/whatsapp` | Planned (WhatsApp Cloud API) |
| `@textagent/telegram` | Planned (Bot API) |
| `@textagent/email` | Planned (IMAP/SMTP) |
| `textagent` CLI | Planned: `create`, `dev`, `doctor` |

## Writing a channel

A channel implements one interface: `start`, `stop`, `send`, and optionally `sendTyping`, plus its
capabilities (max text length, typing indicator, groups, whether it can message first). See
[`packages/core/src/types.ts`](packages/core/src/types.ts).

## Development

Requires Node 24+.

```sh
npm install
npm run build
npm test
```

## License

MIT
