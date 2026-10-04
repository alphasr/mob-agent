# Security policy

textagent handles private messages and API credentials, so we take reports seriously.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository.
Please don't open a public issue. We aim to acknowledge reports within 3 business days.

## Supported versions

textagent is pre-1.0. Only the latest release receives fixes.

## Scope notes

- Bot tokens and API keys must never appear in logs or error messages. A leak is a vulnerability.
- Inbound webhooks (e.g. WhatsApp) must verify the provider's signature before a message is trusted.
- Message text is untrusted input. Any path where it can execute (e.g. in the iMessage AppleScript
  sender) or reach an LLM as instructions rather than data is in scope.
