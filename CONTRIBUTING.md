# Contributing to textagent

Thanks for helping. Bug reports, fixes and new channels are all welcome.

## Setup

Requires Node 24+. The iMessage package only runs (and only fully tests) on macOS.

```sh
npm install
npm run build
npm test
```

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep pull requests focused on one change, with tests. Tests use `node:test` and run the
   TypeScript sources directly; see [CLAUDE.md](CLAUDE.md) for the conventions this requires.
3. Run `npm run build && npm test` before pushing. CI runs the same on macOS.
4. Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Adding a channel

A channel is its own package under `packages/` implementing the `Channel` interface from
[`packages/core/src/types.ts`](packages/core/src/types.ts). It normalizes inbound messages,
calls `ctx.receive()`, and sends text. Everything else (dedupe, filtering, batching, ordering,
splitting, history) is handled by the core; please don't reimplement it in a channel.
Use `packages/telegram` as the reference implementation, including its fake-server tests.

## Security issues

Please don't open public issues for vulnerabilities; see [SECURITY.md](SECURITY.md).
