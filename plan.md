# textagent plan

_Last updated: 2026-10-05_

Goal: an open-source SDK with a unified API, an extensible channel framework, a CLI and
observability for agents over iMessage, WhatsApp, Telegram and email. Hosted platform later.

## Roadmap

| #   | Piece                                                                                       | Status                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Core: types, `Channel` contract, `Agent` (filtering, debounce, ordering, splitting, events) | ✅                                                                                                                                                                     |
| 2   | Stores: dedupe, channel state, history (`MemoryStore`, `SqliteStore`)                       | ✅                                                                                                                                                                     |
| 3   | iMessage reader: `chat.db` polling, `attributedBody`, cursor                                | ✅                                                                                                                                                                     |
| 4   | iMessage sender + channel, echo guard                                                       | ✅ (not yet tried on a live Mac)                                                                                                                                       |
| 5   | Telegram channel                                                                            | ✅ (not yet tried with a real bot token)                                                                                                                               |
| 6   | WhatsApp Cloud API channel (webhook, signature check, 24h window)                           | ✅ (not yet tried with a real Meta app)                                                                                                                                |
| 7   | Email channel (IMAP in, SMTP out, threading, auto-reply loop guard)                         | ✅ (not yet tried with a real mailbox)                                                                                                                                 |
| 8   | Webhook mode: forward turns to a developer's URL                                            | ✅                                                                                                                                                                     |
| 9   | CLI: `create`, `dev`, `doctor`                                                              | ✅ (`publish` moved to piece 12)                                                                                                                                       |
| 10  | Example Claude agent + observability output                                                 | ✅ 10a proactive → 10b scheduling → 10c traces → 10d cloud dashboard (exporter, ingest+DB, auth+projects, UI, self-host) → 10e templates (support, booking, assistant) |
| 11  | Open-source release: push to GitHub, publish to npm                                         | ⏳ after MVP                                                                                                                                                           |
| 12  | Marketplace: browse and publish agents built on textagent                                   | 🔎 framing (see Open decisions)                                                                                                                                        |

## Decisions

- Open-source SDK first, hosted platform later.
- Developers write agents in-process (`agent.on('message')`) and, later, via webhook. Both.
- Monorepo, npm workspaces, one package per channel.
- In-process runtime with a pluggable `Store`; queues (Redis) wait for the hosted version.
- No AI model built in; developers bring their own. Examples use Claude.
- Name `textagent`, npm scope `@textagent`, MIT license.
- GitHub repo goes public once all four channels work end to end; npm publish after that.
- Defaults: groups off, 2s debounce, `MemoryStore` unless configured, replies as plain text.
- WhatsApp webhook: one verified `handleRequest` handler, built-in server as an optional wrapper (2026-10-04).
- Email (2026-10-04): IMAP + SMTP first via `imapflow`/`nodemailer`/`mailparser` (deps allowed in this package
  only); provider webhooks later as another `MailSource`. Mail failing DMARC is dropped and reported.
- Webhook mode (2026-10-04): async. Turns are POSTed, acknowledged with 2xx, answered later via a signed
  `reply`/`typing`/`close` endpoint; a turn holds its conversation until final reply, close or 5-min timeout.
- Marketplace trust (2026-10-04): **anyone can publish**; every submission is checked automatically:
  strict manifest schema (rendered as plain text only); NSFW/abuse screening of listing text, images and
  template prompts; malicious-code checks (no install scripts, OSV/malware dependency scan, obfuscation,
  secrets, `eval`/shell/unexpected network use, lockfile + npm provenance); prompt-injection checks
  (hidden instructions in prompts, lint for user text in system prompts); a sandboxed test run without
  secrets. Listings are labelled Community (automated) or Verified (human-reviewed); GitHub sign-in,
  report button, rate limits, takedowns. Installing a community template shows what it installs, asks,
  and never runs install scripts. Automated checks reduce risk; they cannot guarantee zero.
- CLI (2026-10-04): one `textagent` package (`create`/`dev`/`doctor`) + `create-textagent` alias, using
  `@clack/prompts`. Templates: Echo (no key), Claude (`claude-opus-5-5`, effort low, server-side fallbacks),
  Webhook. Generated projects run with `node agent.ts`, no build step. `publish` deferred to piece 12.
- Proactive messages (2026-10-05): one `agent.send()` (new conversation or existing thread) over optional
  `Channel.sendNew()`; WhatsApp needs a template outside 24h; 20/min/channel default limit.
- Scheduling (2026-10-05): pluggable `Scheduler` (user's choice C), `StoreScheduler` default on the Store;
  at-most-once, 1h lateness window, replace-by-key, 50 pending/conversation, rate-limit retries ×3.
- Traces (2026-10-05): events plus storage in the Store (user's choice C), 7 days / 10,000 turns default;
  no message text in traces; OpenTelemetry export left for a separate package later.
- Dashboard (2026-10-05): hosted cloud dashboard (user's choice C), open source and self-hostable (MIT),
  Next.js on Vercel + Postgres; local/self-host with PGlite or Docker. Agents send via `exporter()`:
  traces only by default (no message text; sender IDs hashed per project), message text opt-in.
  GitHub sign-in, projects/members, hashed ingestion keys, every query scoped to the user's projects.
- Exporter (2026-10-05): new `@textagent/cloud` package holding `exporter()` and the ingest wire format, which
  10d2 reuses (user's choice B). Conversation, thread, message and sender ids are HMAC-SHA256-hashed with a local
  `TEXTAGENT_HASH_SECRET` that is never sent, so the server can't brute-force phone numbers (choice a).
  Batches every 5s or 50 traces (≤1 MB); retries 5xx/network errors with backoff, buffers ≤1,000 traces
  (oldest dropped), stops on 401/403; `includeText` opts into message text; `attributes: false` strips span
  attributes. Never throws into the agent. CLI: `create --dashboard` (or a prompt, default no) generates the
  hash secret and wires `exporter()`; `doctor` validates the settings offline.
- Ingest (2026-10-05, option C): Next.js app in private `apps/dashboard` (the no-runtime-deps rule covers
  the published `packages/` only). `POST /v1/ingest` wraps a framework-free `handleIngest(request, db)`; Drizzle ORM
  with drizzle-kit migrations (`pg` on Vercel, PGlite for tests and self-host). `parseBatch()` in
  `protocol.ts` validates strictly and strips unknown fields; hashed fields must look like hashes. Keys `ta_…`,
  stored as SHA-256, revocable. Idempotent inserts on (project, trace id) and (project, channel, message id, direction). Message text stored
  when the exporter sends it (per-project "never store" switch in d3). 30-day retention via `prune()` + cron.
  Rate limiting deferred to before the hosted launch.
- Dashboard auth (2026-10-05, defaults accepted): better-auth for GitHub sign-in only (DB sessions, Drizzle adapter;
  Auth.js v5 is still beta, hand-rolled sessions too risky). Projects and members are our own tables: members are
  keyed by GitHub's numeric user id (resolved from the username when added), roles owner/member, and every page and
  action goes through one `requireMember()`; non-members get 404. Keys created/revoked in the UI (≤10 active).
  Per-project "store message text" switch, on by default; turning it off drops new messages and deletes stored ones.
- Dashboard UI (2026-10-05, defaults accepted): server-rendered inline SVG charts from small tested scale/path
  functions, no chart library; client JS only for hover readouts and local times. Overview, turns (cursor-paginated,
  50/page, channel and errors filters), turn detail (span waterfall), conversation view; 24h/7d/30d ranges, UTC
  buckets in SQL. Agent-supplied text is rendered escaped only. One global stylesheet with light/dark variables.
- Self-hosting (2026-10-05, defaults accepted): Docker Compose with the dashboard (Next standalone, node:24-slim,
  non-root), Postgres 17 and Caddy (automatic HTTPS; sets `x-forwarded-for` itself). Migrations run at startup under
  a Postgres advisory lock; a daily prune runs in-process (skipped on Vercel, which keeps its cron);
  `TRUSTED_IP_HEADER` (default `x-forwarded-for`) feeds the sign-in rate limit; `/healthz` checks the database.
  A laptop mode (`textagent dashboard` with PGlite, no sign-in) is left as an open decision.
- Templates (2026-10-05, defaults accepted): support, booking and assistant join echo/claude/webhook. A small
  `claude.ts` tool loop is generated into each Claude project (not a package): `claude-opus-5-5`, effort low, refusal
  fallback, strict tools, every model and tool call a traced span with token usage. Tools touching personal data are
  fixed to the conversation's own sender. Support: `knowledge.md` + handoff to an operator from `.env`. Booking:
  `booking.config.json` slots, SQLite bookings (unique slot), reminders via `agent.schedule`. Assistant: one owner
  (`ALLOWED_SENDERS` required: `create` asks for it, `doctor` flags it, the agent won't start without it), notes +
  reminders, `TIMEZONE`. Local-time code is one shared `time.ts`, shipped with booking and assistant.
- Code of Conduct: Contributor Covenant 2.1, reports to the maintainer's email.
- Marketplace (2026-10-04): both a developer template gallery and an end-user agent store, **gallery first**;
  store waits for the hosted platform. Creation: both code + CLI publish now, no-code builder later.

## Open decisions

- Local dashboard mode (`textagent dashboard`: PGlite file, no sign-in, localhost only, auto-created key): the
  fastest way to see traces, but it adds an unauthenticated mode and means publishing the dashboard.

- Marketplace build order: depends on CLI `create` (piece 9). Proposed: a registry of manifests in this
  repo plus a static gallery site; `textagent publish` opens the submission. Confirm at piece 12's Plan step.
- History retention: unbounded today; needs a limit/TTL option before healthcare-style users.

## Launch & adoption

Goal: a developer goes from seeing a demo to texting their own agent in under 2 minutes.

- **30-second path is Telegram + Claude**: bot token in 30s, no public URL, no macOS permissions.
  `npx textagent create` (piece 9) must get there with one command; iMessage is the "wow" demo, not the first step.
- **README as landing page**: one-line pitch, a GIF of texting an agent from a phone, a 10-line example,
  then features. Badges: CI, npm version, downloads, license.
- **Integrations = discovery**: adapters for the Vercel AI SDK, LangChain, Mastra, plus an MCP server so any
  agent can text people through textagent. Each one is listed in another ecosystem.
- **Gallery templates double as tutorials** ("Build a WhatsApp booking agent in 10 minutes").
- **Launch** at v0.1 once all four channels work: Show HN + X/LinkedIn video of the iMessage demo,
  relevant Discords. Lead with the problem and the demo, never "please star".
- **First 10 users by hand**; answer issues fast; label `good first issue`; release weekly early on (changesets).
- Track npm weekly downloads and dependent repos, not just stars.

## Known gaps

- Exporter: traces are buffered in memory only, so a crash or a missing `close()` loses up to 5s of them
  (more while the dashboard is down); error strings and span names are sent as written by the developer;
  `Retry-After` is ignored (backoff is 1s doubling to 60s). Not yet tried against a real dashboard (10d2).
- Dashboard: tests use PGlite; real Postgres 17 is exercised by hand (migrations, concurrent starts, ingest,
  outage) and in a full `docker compose up` (Caddy, restarts), but not in CI. The image (417 MB) isn't published or
  built in CI yet; Caddy's Let's Encrypt path is untested (needs a public domain). `create-key` makes projects with no members, invisible in the UI until it gets an
  `--owner` option. Pruning is one `DELETE` per table (fine until tables are large; batch it then), and
  only Vercel calls the cron route: self-hosters need their own scheduler (10d5). The GitHub OAuth round trip is
  untested (needs a real OAuth app); without a proxy setting `x-forwarded-for`, all sign-ins share one rate-limit
  bucket (3 per 10s), so self-hosting (10d5) must set better-auth's IP header. Server actions are thin wrappers
  tested through `manage.ts` and a page smoke test, not by submitting the forms; GitHub username lookups are
  unauthenticated (60/hour per server IP); two simultaneous "create key" clicks can briefly exceed 10 active keys.
- Dashboard UI: the waterfall's hover is the browser's native SVG `<title>` (no keyboard-focus tooltip); every value
  is also in the spans table. Outbound messages are matched to a turn by thread and time window (sent ids aren't
  in traces), so overlapping turns in one thread can show each other's replies. Overview charts label axes in UTC
  (tooltips use local time); stat tiles have no comparison with the previous period yet.
  Conversation pages show the newest 200 turns and 500 messages; there is no search by text. Importing core loads `node:sqlite` (an "experimental" warning on Node 22).
- Templates: generated `agent.ts` handlers are typechecked, and their behaviour is tested through identical handlers
  in the CLI tests. On Node 24 (2026-10-05), all 24 template × channel projects (no iMessage on Linux) were
  created by the built CLI, checked with `doctor` and started up to channel startup; a generated booking agent took a
  signed WhatsApp webhook through to the Claude call. No successful Claude call has been made (no API key here).
  Support handoffs can't be ended early from a chat (delete the row in `support.sqlite` or wait 24h).
  Booking: one resource (a slot holds one booking; no staff or rooms); the business isn't notified of bookings
  (they are in `booking.sqlite`); bookings under 24h away get no reminder; at a DST fall-back the repeated hour
  offers only its second occurrence. A cancel that fails after its reminder is removed leaves a booking without one.
  Assistant: notes are per sender ID, so one owner texting from two channels has two notebooks; reminders are
  one-off (no "every Monday"); a reminder due while the agent was down for over an hour is dropped (core's grace).
- Email `check()` uses the libraries' default timeouts (SMTP 2 min, IMAP 90 s): on a network that drops port 993/465,
  `doctor` waits minutes before reporting.
- Trace cost uses hardcoded list prices (as of 2026-10-05); they go stale and need updating.

- iMessage can't confirm delivery of proactive texts; replies may land in a separate `any;-;` thread.

- CLI: interactive prompts and `textagent dev` (watch + tunnels) are exercised by hand only, not by tests.
- Generated projects depend on `^0.1.0` packages that aren't on npm yet; `--link` works until the first publish.

- Hosted platform: webhook URLs come from users there, so it must add the SSRF check (no private/loopback
  addresses) that self-hosted mode deliberately skips.
- Webhook reply API: two identical actions signed in the same second collide in replay protection (409).

- Email: quote stripping is English-only; attachments are metadata only; Gmail login via app password
  (OAuth2 later); proactive emails need the proactive-send API.

- iMessage edits/unsends are not delivered (edits update rows in place; the cursor only sees new rows).
- Telegram attachments are references (`telegram-file:<id>`); download via `TelegramChannel.fileUrl()`.
- WhatsApp's terms (from Jan 2026) ban general-purpose AI assistants; it suits business-specific agents only.
- Prettier formatting not yet applied to `core/src/agent.ts` and `core/src/store.ts`.

## Decided against

- 2026-10-04: runtime NSFW/injection screening of incoming messages; screening applies to marketplace
  submissions only. Agents rely on keeping user text out of system prompts and on tool-level permission checks.

- 2026-10-04: native SQLite dependency (better-sqlite3), since `node:sqlite` is built in.
- 2026-10-04: Telegram MarkdownV2 replies, because a single unescaped character fails the whole send.
- 2026-10-04: Vitest/Jest, because `node:test` needs no dependency.
