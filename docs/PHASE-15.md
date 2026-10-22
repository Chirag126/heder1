# Phase 15 — Optional Hedera integrations: read-only network tools

## Goal

Add useful Hedera network context without changing the existing x402 payment engine, deterministic spending firewall, wallet authorization, settlement validation, or HCS audit flow.

## Compatibility review and dependency decision

As of the Phase 15 implementation review (2026-10-22), the official Hedera Agent Kit JavaScript project documents the v4 modular package family, with `@hashgraph/hedera-agent-kit` 4.x core and separate adapters for LangChain, Vercel AI SDK, ElizaOS, and MCP. Built-in query plugins include account, token, consensus, EVM, miscellaneous Mirror Node, and transaction queries. In v4, plugins must be imported explicitly from `@hashgraph/hedera-agent-kit/plugins`; an empty plugin list provides no tools.

References:
- Agent Kit repository and package architecture: https://github.com/hashgraph/hedera-agent-kit-js
- Agent Kit v4 migration guide: https://github.com/hashgraph/hedera-agent-kit-js/blob/main/docs/MIGRATION-v4.md
- Agent Kit query plugin catalogue: https://github.com/hashgraph/hedera-agent-kit-js/blob/main/docs/HEDERAPLUGINS.md
- Official Hedera MCP overview and Testnet endpoint: https://hedera.com/mcp-servers/
- Hedera Mirror Node API: https://docs.hedera.com/hedera/sdks-and-apis/rest-api

Decision: do not add Agent Kit packages to the payment API in this phase. The current service already uses `@hiero-ledger/sdk` and a carefully bounded x402 v2 engine. Agent Kit v4 introduces a separate modular plugin/framework integration surface and peer dependency requirements; adding it before a specific plugin is needed would increase lockfile, bundle, and migration risk without improving the verified payment path. Instead, Phase 15 implements one small read-only tool against the official public Testnet Mirror Node REST API. Agent Kit and the hosted Network MCP remain optional future adapters, not dependencies of payment execution.

The hosted Hedera Network MCP advertises read queries and wallet-approved transactions. It is not wired into unattended x402 settlement: no MCP transaction tool is exposed by this phase.

## Implemented tool

Endpoint:

```http
GET /api/integrations/hedera/testnet/accounts/{accountId}
```

Example local request:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/integrations/hedera/testnet/accounts/0.0.12345
```

The route queries the fixed host `https://testnet.mirrornode.hedera.com/api/v1` and returns a sanitized account snapshot:
- network and account ID
- balance in tinybars
- EVM address when valid
- deleted status and expiry timestamp when valid
- fixed source marker and `readOnly: true`

It does not return memo, public-key material, private credentials, transaction-signing requests, arbitrary URLs, or transaction submission capabilities.

## Security boundaries

- **Fixed destination:** the caller supplies only a syntactically validated Hedera account ID; no URL, host, path, or query parameters are accepted.
- **Read-only transport:** the upstream request is GET to the fixed Testnet Mirror Node endpoint.
- **Timeout:** the outbound request has a five-second default timeout, with a hard-validated timeout range in the adapter.
- **Argument validation:** account ID is validated both at the Fastify route schema and in the tool module.
- **Sanitized result:** only a narrow allowlist of response fields is returned.
- **Audit events:** successful and failed queries emit sanitized audit events; no wallet signature or secret is logged.
- **No payment bypass:** this route never calls the x402 client, payment runner, authorization grant consumer, spending reservation ledger, or transaction-signing APIs. It cannot authorize, reserve, or submit a payment.
- **No unrestricted LLM tools:** the tool is a normal API capability with a single account-ID argument; no LLM execution framework is added.
- **Network separation:** Testnet only. No mainnet endpoint or signing capability exists in this integration.

## Tests

New unit tests in `services/api/src/hedera-readonly-tools.test.ts` cover:
- valid response parsing and sanitized output
- fixed Testnet Mirror Node URL and GET method
- malformed account IDs rejected before any network request
- not-found and upstream failure handling
- malformed Mirror Node response rejection
- invalid timeout configuration

Run:

```powershell
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

The API package test script includes `src/*.test.ts`, so the new tests run with the existing test suite. CI results should be checked on the pull request before merge.

## Migration risk

- No new package or dependency was added.
- No database migration, existing API request schema, x402 flow, spending limit, authorization scope, settlement validation, or HCS behavior was changed.
- New API surface is additive and read-only.
- The feature uses Node's existing global `fetch` and `AbortSignal.timeout`, compatible with the repository's Node >=24 engine.
- Mirror Node availability can affect the read-only endpoint; upstream failures return an error and never fall back to signing or payment execution.

## Completion criteria

The read-only account context tool is implemented and unit-tested. Agent Kit and Network MCP were evaluated and deliberately not installed because the minimal Mirror Node tool meets the immediate use case with lower migration risk. A future Agent Kit/MCP phase should select one specific query plugin or wallet-approved action, pin compatible versions, add explicit per-tool permissions, and demonstrate a separate end-to-end test before enabling it.
