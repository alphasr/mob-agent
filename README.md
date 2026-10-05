# textagent

> **Alpha.** Not yet published to npm. APIs will change.

Build AI agents that people text, instead of apps they have to install.
Write your agent once; textagent runs it over **iMessage, WhatsApp, Telegram and email**.

```sh
npm create textagent
```

Pick Telegram and the Echo template, paste a bot token from @BotFather, run `npm run dev`, and text your bot.
`npm run doctor` checks credentials and permissions if anything is off.

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

## Templates

`npm create textagent` asks which one to start from (or pass `--template <name>`). Each generates a small
`agent.ts` plus files that are yours to edit.

| Template    | What it does                                                                   | Needs                                  |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `echo`      | Replies with what you sent                                                     | nothing                                |
| `claude`    | Answers with Claude, through a tool loop that traces every model and tool call | Anthropic API key                      |
| `support`   | Answers from `knowledge.md`; hands a conversation to a person when it can't    | API key, a channel and address for you |
| `booking`   | Books slots from `booking.config.json`; reminds people 24 hours before         | API key                                |
| `assistant` | Notes and reminders for you alone                                              | API key, `TIMEZONE`, your sender ID    |
| `webhook`   | Forwards each turn to your own server, in any language                         | your server's URL                      |

In the Claude templates, tools act only for the person texting: nobody can read or cancel someone else's
booking or notes, and handoffs and reminders go only where the code sends them.

## What the core handles for every channel

- **Dedupe**: webhook retries and restarts never produce a second reply.
- **Batching**: "hey" / "quick q" / "what's the weather" sent in a burst becomes one turn.
- **Ordering**: one turn at a time per conversation; different conversations run in parallel.
- **Splitting**: replies over a channel's length limit are split at paragraph, sentence, then word boundaries.
- **History**: per-thread conversation memory, stored in SQLite (built into Node, no native deps).
- **Filtering**: allowlist and group-chat controls.
- **Observability**: typed events for every receive, filter, handler run, send and error.

## Packages

| Package               | Status                                                             |
| --------------------- | ------------------------------------------------------------------ |
| `@textagent/core`     | Agent, channel interface, stores                                   |
| `@textagent/imessage` | Works, untested on a live Mac yet. macOS only                      |
| `@textagent/whatsapp` | Works (Cloud API webhooks, signature-verified)                     |
| `@textagent/telegram` | Works (Bot API, long polling)                                      |
| `@textagent/email`    | Works (IMAP + SMTP; Gmail helper)                                  |
| `@textagent/webhook`  | Works: turns POSTed to your server (any language), signed replies  |
| `textagent` CLI       | Works: `npm create textagent`, `textagent dev`, `textagent doctor` |
| `@textagent/cloud`    | Works: sends turn traces to the dashboard; ids hashed, no text     |

## Dashboard

`apps/dashboard` shows turns, timings, token usage and cost per project, with GitHub sign-in. Create a project
with `--dashboard` to send traces to it, or add `exporter()` from `@textagent/cloud` yourself. It runs on Vercel
with Postgres, or self-hosted with Docker Compose: see [SELF_HOSTING.md](apps/dashboard/SELF_HOSTING.md).

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT
