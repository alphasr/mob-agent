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
- `packages/cloud`: `exporter()` ships turn traces to the dashboard (`TEXTAGENT_INGEST_URL`, `TEXTAGENT_KEY`).
  Wire format, shared limits and the validator `parseBatch` in [protocol.ts](packages/cloud/src/protocol.ts);
  [redact.ts](packages/cloud/src/redact.ts) hashes person-naming ids with `TEXTAGENT_HASH_SECRET` (never sent).
- `packages/cli` (npm name `textagent`) and `packages/create-textagent`: `create`/`dev`/`doctor`.
  [catalog.ts](packages/cli/src/catalog.ts) is the single source of truth for each channel's and template's
  env vars, generated code and doctor checks, and for the optional dashboard exporter (`create --dashboard`).
  Files a template ships unchanged live in `packages/cli/templates/` (e.g. `claude.ts`, the Claude tool loop that
  traces every model and tool call; `time.ts`, local times via `Intl`, shared by `booking.ts` and `assistant.ts`);
  they are real, tested sources. `TEMPLATE_IMPORTS` and `HANDLERS` in scaffold.ts hold each template's `agent.ts` code.
- `apps/dashboard` (private, never published): Next.js dashboard. `POST /v1/ingest` is a framework-free
  `handleIngest(request, db)` ([handler.ts](apps/dashboard/src/ingest/handler.ts)) behind a thin route; a daily
  Vercel cron (`vercel.json`) calls `GET /v1/cron/prune`, which needs `Bearer $CRON_SECRET` and deletes data
  older than 30 days. GitHub sign-in via better-auth ([auth.ts](apps/dashboard/src/auth/auth.ts)) at `/api/auth/*`.
  Env: `DATABASE_URL`, `CRON_SECRET`, `AUTH_SECRET` (≥32 chars), `AUTH_URL`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `TRUSTED_IP_HEADER` (default `x-forwarded-for`). Off Vercel, `instrumentation.ts` runs
  migrations at startup (advisory lock) and a daily prune in-process; `GET /healthz` pings the database.
  Drizzle schema in [schema.ts](apps/dashboard/src/db/schema.ts), migrations in `drizzle/`; tests use in-memory
  PGlite (`test/db.ts`). Self-hosting: `docker-compose.yml` (Postgres + dashboard + Caddy), `Dockerfile` (built from
  the repo root; standalone output), guide in [SELF_HOSTING.md](apps/dashboard/SELF_HOSTING.md).
- `examples/`: runnable scripts (`node examples/<file>.ts`).

## Commands

```sh
npm install
npm run build   # tsc -b over all packages; run before tests (packages import each other's dist/)
npm test        # node --test in every workspace
```

One package: `cd packages/<name> && node --test test/*.test.ts`.

Dashboard (`cd apps/dashboard`): `npm run dev`, `npm run build`, `npm run typecheck`, `npm run db:generate` after
editing the schema (a test fails until you do), `npm run db:migrate` and `npm run create-key "<name>"` (prints a
project's ingestion key once) with `DATABASE_URL` set.

## How the code is written

- Node ≥ 24, ESM. No runtime dependencies in `packages/` except `packages/email` (MIME and IMAP are not worth
  hand-rolling). `apps/dashboard` is a private app and may use Next.js, Drizzle and `pg`.
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
- A package that imports another (even types only) must list it in its tsconfig `references`, or a fresh clone's
  `npm run build` fails (an existing `dist/` hides it). Check with `rm -rf packages/*/dist && npm run build`.
- The root package is `textagent-monorepo`; the CLI package owns the name `textagent`.
- Try the CLI against local packages: `node packages/cli/dist/bin.js create .tmp/x --link "$PWD" --no-install`
  (`.tmp/` is gitignored; inside the repo, imports resolve to the workspace).
- Node's `.env` parser has no escapes and treats unquoted `#` as a comment; `quoteEnv` in scaffold.ts handles it.
- Generated code uses `Number(process.env.PORT || default)`: `??` would turn a blank value into port 0.
- Traces never include message text; span attributes are capped at 2 KB (by bytes) and 50 spans per turn.
  Prices in `trace.ts` are dated list prices; update `DEFAULT_PRICES` when Anthropic's change.
- Adding a field to `TurnTrace`/`SpanRecord` breaks the `cloud` build until `redact.ts` decides whether it may be sent.
- `exporter()` buffers in memory on an unref'd timer: call `exporter.close()` after `agent.stop()`, or the last
  traces are lost. With `includeText`, inbound texts are held until `turn.completed`, since `message.received`
  fires before dedupe and filtering.
- `npm install` on Linux fails on the darwin-only `@textagent/imessage`; use `npm install --force` (CI runs on macOS).
- Dashboard: every query on `traces`, `messages` or `ingest_keys` must filter on `project_id`, and in pages and
  actions that id must come through `requireMember()` ([members.ts](apps/dashboard/src/auth/members.ts)); nothing
  else separates customers. Members are keyed by GitHub's numeric id (`auth_accounts.account_id`), not username.
  Project rules (roles, key limits, last owner) live in [manage.ts](apps/dashboard/src/projects/manage.ts), whose
  functions check membership themselves; server actions in `app/projects/actions.ts` only wrap them. Read-only
  views (`src/views/`) do the same; project pages start with `projectPage(id)` (sign-in redirect or 404).
  Agent-supplied text (errors, span names, attributes, messages) is rendered as escaped text only. Charts are
  server-rendered SVG from pure geometry in `src/views/scale.ts`; `app/projects/[id]/chart.tsx` adds hover/keys.
  SQL time buckets come back as epoch ms (a plain `timestamp` would be read in the server's timezone).
  Postgres can't store NUL or integers over 2³¹−1, so `parseBatch` strips and caps them.
- drizzle-kit prefixes `./` to absolute `--out` paths and fails; pass relative ones.
- better-auth's tables (`auth_*` in schema.ts) are written by hand; property names must match `@better-auth/core`'s
  schema (the auth tests run real better-auth on them). Its sign-in rate limit is per IP from `x-forwarded-for`.
- The `pg` pool needs an `'error'` listener (`createPool`): a dropped idle connection otherwise kills the server.
- Pages: call `headers()` before anything that touches the DB (`signedInUser` does), or `next build` prerenders
  the page and fails without `DATABASE_URL`.
- `ctx.typing()` never throws (failures are `channel.error` events), so handlers can await it first.
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
