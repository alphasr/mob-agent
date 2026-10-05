# Changelog

All notable changes are recorded here. This project follows [Semantic Versioning](https://semver.org);
while it is 0.x, minor versions may contain breaking changes.

## Unreleased

### Added

- `@textagent/core`: `Agent` with allowlist and group filtering, per-sender debounce, per-conversation
  ordering, reply splitting, dedupe, conversation history, typed events and `idle()`.
- `@textagent/core`: `MemoryStore` and `SqliteStore` (built on `node:sqlite`).
- `@textagent/imessage`: `chat.db` reader, AppleScript sender and echo guard.
- `@textagent/telegram`: Bot API channel with long polling, forum topics and rate-limit handling.
- `@textagent/whatsapp`: Cloud API channel with signature-verified webhooks, a standard `handleRequest`
  handler plus optional built-in server, typing indicators, media download and `drain()` for serverless.
- `@textagent/email`: IMAP + SMTP channel with reply threading, quote stripping, auto-reply/list/bounce
  filtering, DMARC-fail dropping, IDLE with reconnects, and a `gmail()` helper.
- `@textagent/webhook`: hand turns to a server in any language; it acknowledges and replies later through
  a signed, replay-protected endpoint. Includes `replyClient()` for Node receivers.
- `textagent` CLI and `create-textagent`: `npm create textagent` scaffolds a project (Echo, Claude or Webhook
  template), `textagent dev` runs it with live reload and a cloudflared/ngrok tunnel for WhatsApp,
  `textagent doctor` checks credentials and permissions without sending anything.
- `@textagent/core`: turn traces. `ctx.trace.span()` / `start()` / `usage()` record model calls, tool calls
  and steps (nested automatically); each turn emits `turn.completed` with timings, tokens and estimated cost
  (built-in Claude prices, overridable). Traces are kept in the store (7 days / 10,000 turns by default).
  `logEvents({ format: 'json' })` writes one JSON object per line. Webhook mode traces delivery and waiting.
- `@textagent/core`: `agent.schedule()` / `cancelScheduled()` / `listScheduled()` for messages sent later:
  durable with SqliteStore, at-most-once, dropped when more than an hour late, replace-by-key, 50 pending per
  conversation, retried on rate limits. Pluggable `Scheduler` interface; `StoreScheduler` is the default.
  `Store` gains five job methods (breaking for custom stores).
- `@textagent/core`: SqliteStore no longer fails with "database is locked" when processes open it together.
- `@textagent/core`: `agent.send()` for proactive messages (new conversations or existing threads), rate-limited
  per channel and recorded in history; optional `Channel.sendNew()` on iMessage, Telegram, email and WhatsApp
  (templates outside the 24-hour window). `ChannelCapabilities.canInitiate` removed.
- `@textagent/core`: optional `Channel.check()`, `logEvents()` readable event log, `text` on `message.sent`.
- `@textagent/core`: `serve()`/`readBody()` HTTP helpers and `signBody()`/`verifyWebhook()` request signing.
- `@textagent/cloud`: `exporter()` batches turn traces to a dashboard, hashing phone numbers and emails with a
  local secret and leaving message text out unless `includeText` is set; retries with backoff, `close()` flushes.
- Dashboard (`apps/dashboard`, not published): ingestion API, projects with GitHub sign-in, members and keys,
  overview charts, turn waterfalls and conversations; 30-day retention; self-hosting with Docker Compose.
- `textagent` CLI: `create --dashboard`; templates `support` (knowledge base + handoff to a person), `booking`
  (slots, bookings and reminders) and `assistant` (notes and reminders for one owner). Claude templates ship a
  `claude.ts` tool loop (`claude-opus-5-5`, strict tools, traced model and tool calls).
- `@textagent/core`: `ctx.typing()` no longer throws; a failed typing indicator is a `channel.error` event and the
  turn goes on to reply (before, a rate-limited or failed indicator cost the whole reply).
