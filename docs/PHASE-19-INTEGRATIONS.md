# Phase 19 — Identity, A2A, HTS, recurring-payment safety, and agent tools

## Agent identity — HCS-14-style AID
The API exposes deterministic `uaid:aid:` identifiers for buyer/provider cards using normalized metadata, sorted skills, SHA-384, and Base58. This is local identity generation, not a published registry or proof of endpoint control. Verify against the current HCS-14 draft and official test vectors before claiming full conformance.

## Multi-agent negotiation — A2A JSON-RPC adapter
`POST /api/a2a` accepts bounded `message/send` JSON-RPC requests and routes the task through the existing live quote-discovery marketplace. Only text messages are supported; this is not a claim of full A2A task lifecycle conformance.

## HTS token payments
`GET /api/x402/hts-capabilities` reports configured candidate token IDs. HBAR remains the only executable asset. Token settlement is disabled until the installed x402 Hedera scheme and facilitator pass token-specific verification and settlement tests. Environment configuration cannot enable token execution.

## Recurring payments
`POST /api/recurring-payments/drafts` creates Testnet/HBAR intents with service allowlisting, per-execution caps, a maximum of 30 executions, and expiry within 90 days. `GET /api/recurring-payments/drafts` lists them; `POST /api/recurring-payments/drafts/:id/cancel` cancels a draft. These records are in-memory and draft-only: no Hedera Scheduled Transaction is submitted, no recurring transfer executes, and records do not survive restarts. On-chain schedule creation requires a separately reviewed wallet-consent and durable-storage implementation.

## Agent Kit / MCP-style tools
`GET /api/agent-tools` publishes one bounded read-only account tool; `POST /api/agent-tools/call` queries the existing public Mirror Node account handler. Arbitrary URLs, arbitrary tools, transaction signing, and transfers are not exposed. This is a restricted adapter, not a claim that the official Agent Kit/MCP SDK is installed.

## Validation
New unit tests cover identity determinism, reserved skill rejection, A2A request validation, recurring draft limits/cancellation, and read-only tool allowlisting. Run `pnpm --filter @heder1/api test`, `pnpm typecheck`, and `pnpm build` before merging.
