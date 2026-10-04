# textagent

Open-source TypeScript SDK for AI agents that people text: one agent, many channels
(iMessage, Telegram, WhatsApp, email). Roadmap and decisions: [plan.md](plan.md).

## Layout

- `packages/core` (`@textagent/core`): `Agent`, the `Channel` contract ([types.ts](packages/core/src/types.ts)),
  `MemoryStore` / `SqliteStore`, `splitText`, typed events.
- `packages/imessage`: reads `~/Library/Messages/chat.db`, sends via `osascript`. macOS only.
- `packages/telegram`: Bot API over `fetch`, long polling.
- `packages/whatsapp`: Cloud API. `handleRequest(Request) → Response` is the webhook; `port` adds a built-in server.
- `packages/email`: IMAP in (`imapflow`), SMTP out (`nodemailer`), parsing (`mailparser`). `MailSource` is the
  seam for other inbound transports.
- `packages/webhook`: `webhook({ url, secret })` turns a developer's HTTP server into the message handler;
  wire format in [protocol.ts](packages/webhook/src/protocol.ts).
- `packages/cli` (npm name `textagent`) and `packages/create-textagent`: `create`/`dev`/`doctor`.
  [catalog.ts](packages/cli/src/catalog.ts) is the single source of truth for each channel's and template's
  env vars, generated code and doctor checks.
- `examples/`: runnable scripts (`node examples/<file>.ts`).

## Commands

```sh
npm install
npm run build   # tsc -b over all packages; run before tests (packages import each other's dist/)
npm test        # node --test in every workspace
```

One package: `cd packages/<name> && node --test test/*.test.ts`.

## How the code is written

- Node ≥ 24, ESM. No runtime dependencies except `packages/email` (MIME and IMAP are not worth hand-rolling).
  SQLite is `node:sqlite`; HTTP is global `fetch`.
- Tests run the `.ts` sources directly via Node type stripping, so source must be erasable:
  no `enum`, no constructor parameter properties, no namespaces (`erasableSyntaxOnly` enforces it).
- Relative imports use the `.ts` extension; `rewriteRelativeImportExtensions` turns them into `.js` on build.
- Formatting: `.prettierrc.json` (single quotes, 120 cols), applied by the `.claude` PostToolUse hook.
- A channel only talks to the agent through `ChannelContext` (`receive`, `reportError`, `state`).
  Dedupe, filtering, batching, ordering, splitting and history live in core, never in a channel.

## Gotchas

- iMessage needs **Full Disk Access** (read) and **Automation → Messages** (send) for the process running node.
- `chat.db` dates are nanoseconds and overflow JS numbers; convert in SQL (see `reader.ts`).
- Tests that start an `Agent` must `stop()` it in `afterEach`, or pending poll timers keep `node --test` alive forever.
- `receive()` returns once a message is queued, not handled; use `await agent.idle()` in tests.
- WhatsApp acknowledges webhooks before handling them; on serverless hosts call `waitUntil(channel.drain())`.
- WhatsApp webhooks: verify `X-Hub-Signature-256` on the raw bytes before parsing; never weaken this.
- `mailparser` merges all `List-*` headers into one `list` entry; check raw `headerLines` for header presence.
- Only the topmost `Authentication-Results` header is trustworthy; lower ones may be forged by the sender.
- An `ImapFlow` instance cannot reconnect; `ImapSource` creates a new client per connection.
- Shared HTTP plumbing (`serve`, `readBody`) and signing (`signBody`, `checkSignature`) live in core; channels and
  packages reuse them rather than writing their own.
- After editing `tsconfig.base.json`, build with `npx tsc -b packages/* --force`; incremental builds miss it.
- The root package is `textagent-monorepo`; the CLI package owns the name `textagent`.
- Try the CLI against local packages: `node packages/cli/dist/bin.js create .tmp/x --link "$PWD" --no-install`
  (`.tmp/` is gitignored; inside the repo, imports resolve to the workspace).
- Node's `.env` parser has no escapes and treats unquoted `#` as a comment; `quoteEnv` in scaffold.ts handles it.
- Generated code uses `Number(process.env.PORT || default)`: `??` would turn a blank value into port 0.
- Traces never include message text; span attributes are capped at 2 KB (by bytes) and 50 spans per turn.
  Prices in `trace.ts` are dated list prices; update `DEFAULT_PRICES` when Anthropic's change.
- `formatEvent` ends in `assertNever`: adding an event type without a log line is a compile error.
- Scheduling: the Agent owns policy (validation, limits, lateness, retries); a `Scheduler` only stores and
  times jobs. `StoreScheduler` claims due jobs with one `UPDATE … RETURNING`, so processes can share a DB.
- SqliteStore sets `busy_timeout` before `journal_mode = WAL`; reversed, concurrent opens fail with
  "database is locked" (regression test spawns 4 processes).
- `agent.send()` never decides who may be messaged: tools that send must fix the recipient in code
  (usually the conversation's own sender). Limit: 20 proactive messages/min/channel by default.
- WhatsApp keeps each person's last-message time in channel state (`window:<wa_id>`) to enforce the 24h rule.
- iMessage `sendNew` threads are `iMessage;-;<to>`; newer macOS may file the reply under `any;-;<to>`.
- `Channel.check()` must only read. The iMessage check runs `osascript`, which can show a macOS prompt.
- Git commands are blocked for Claude by `.claude/settings.json`; the user runs them.
- `.claude/rules` and `.claude/agents` were written for another project (ai-rent); follow their general
  guidance, ignore the ai-rent specifics (`apps/web`, `apps/api`, Jest, Zod, React conventions).
