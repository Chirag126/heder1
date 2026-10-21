# Phase 10 — Autonomous agent v2

## Status

**Implementation foundation in progress; not accepted as complete.** This change adds deterministic task-limit validation, parsing of actual x402 v2 `accepts` requirements, and a policy function that selects the cheapest eligible candidate without letting an LLM authorize spending. It does not yet implement live multi-service discovery or a paid multi-service execution route.

## Compatibility with Phases 0–9

- Keeps the existing Phase 9 agent and paid-resource route unchanged.
- Uses Hedera Testnet, native HBAR asset ID `0.0.0`, and the existing 100,000-tinybar per-payment firewall ceiling.
- Preserves the existing wallet authorization requirement for payment execution.
- Does not change Render environment flags; public payment execution must remain disabled.
- Keeps the v2 planner side-effect-free: it cannot fetch URLs, create a signer, or initiate payments.

## Policy defaults

| Limit | Default |
|---|---:|
| Total budget | 500,000 tinybars (0.005 HBAR) |
| Paid calls | 3 |
| Planning/execution steps | 8 |
| Runtime | 45 seconds |
| Retries | 1 |
| Attempts per service | 1 |
| Network | `hedera:testnet` |
| Asset | `0.0.0` (native HBAR) |

Limits are validated against hard ceilings. The registry URL check currently restricts candidates to local HTTP services on port 4000 and rejects credentials, query strings, fragments, remote hosts, and HTTPS URLs. This is a local testnet development boundary, not a general-purpose remote service registry.

## Deterministic planning contract

1. The registry supplies explicitly approved service metadata; discovery must not accept a model-supplied arbitrary URL.
2. A service's advertised metadata price is informational only. The executor must inspect that endpoint's actual HTTP 402 challenge and pass its `accepts` array to `parseX402Requirements`.
3. `selectCheapestEligibleService` filters by trust/allowlist, network, native HBAR asset, receiver allowlist, and actual amount against the task budget, then deterministically sorts by amount and service ID.
4. The selected amount must be reserved through the spending firewall before the x402 client can sign or pay.
5. A future executor must enforce call/step/runtime/retry limits, cancellation, response validation, and a settlement receipt for every paid result.
6. An optional LLM may interpret the goal or suggest ranking, but it cannot fetch, sign, reserve, or authorize a payment.

## Current acceptance gap

The existing merchant in `services/api/src/paid-resource.ts` currently advertises a fixed 100,000-tinybar requirement and returns one demo report. The current agent is hard-coded to that resource. Therefore the following Phase 10 completion criteria are **not yet met by this foundation PR**:

- Two or more distinct registered test services with independently inspected 402 requirements.
- A real payment to the deterministically selected cheapest service from a multi-service run.
- An end-to-end no-eligible-service test through the execution API, proving that no payment is attempted.
- End-to-end cancellation, timeouts, call accounting, and receipts for the v2 runner.

Do not describe Phase 10 as complete until these have been implemented and tested locally on Hedera Testnet. Never turn on public Render payment execution to test this flow.

## Tests

Run from the repository root:

```cmd
pnpm --filter @heder1/api test
pnpm --filter @heder1/api typecheck
pnpm --filter @heder1/api build
```

The `agent-v2.test.ts` tests exercise deterministic selection, actual challenge parsing, budget/receiver/network rejection, URL boundary checks, and hard limits. They do not make network requests or payments.
