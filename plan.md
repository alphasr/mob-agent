# textagent plan

_Last updated: 2026-10-05_

Goal: an open-source SDK with a unified API, an extensible channel framework, a CLI and
observability for agents over iMessage, WhatsApp, Telegram and email. Hosted platform later.

## Roadmap

| #   | Piece                                                                                       | Status                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Core: types, `Channel` contract, `Agent` (filtering, debounce, ordering, splitting, events) | ✅                                                                                                                                                                                           |
| 2   | Stores: dedupe, channel state, history (`MemoryStore`, `SqliteStore`)                       | ✅                                                                                                                                                                                           |
| 3   | iMessage reader: `chat.db` polling, `attributedBody`, cursor                                | ✅                                                                                                                                                                                           |
| 4   | iMessage sender + channel, echo guard                                                       | ✅ (not yet tried on a live Mac)                                                                                                                                                             |
| 5   | Telegram channel                                                                            | ✅ (not yet tried with a real bot token)                                                                                                                                                     |
| 6   | WhatsApp Cloud API channel (webhook, signature check, 24h window)                           | ✅ (not yet tried with a real Meta app)                                                                                                                                                      |
| 7   | Email channel (IMAP in, SMTP out, threading, auto-reply loop guard)                         | ✅ (not yet tried with a real mailbox)                                                                                                                                                       |
| 8   | Webhook mode: forward turns to a developer's URL                                            | ✅                                                                                                                                                                                           |
| 9   | CLI: `create`, `dev`, `doctor`                                                              | ✅ (`publish` moved to piece 12)                                                                                                                                                             |
| 10  | Example Claude agent + observability output                                                 | 🚧 10a proactive ✅ → 10b scheduling ✅ → 10c traces ✅ → 10d cloud dashboard (d1 exporter → d2 ingest+DB → d3 auth+projects → d4 UI → d5 local/self-host) → 10e support, booking, assistant |
| 11  | Open-source release: push to GitHub, publish to npm                                         | ⏳ after MVP                                                                                                                                                                                 |
| 12  | Marketplace: browse and publish agents built on textagent                                   | 🔎 framing (see Open decisions)                                                                                                                                                              |

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
- Code of Conduct: Contributor Covenant 2.1, reports to the maintainer's email.
- Marketplace (2026-10-04): both a developer template gallery and an end-user agent store, **gallery first**;
  store waits for the hosted platform. Creation: both code + CLI publish now, no-code builder later.

## Open decisions

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

- Trace cost uses hardcoded list prices (as of 2026-10-05); they go stale and need updating.
- CLI templates don't record Claude usage in traces yet (planned with the 10e templates).

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
