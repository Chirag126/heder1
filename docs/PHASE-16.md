# Phase 16 — Cost, pricing and sustainable service operation

## Goal

Make Heder1's costs visible and bound task usage without adding a subscription system before actual hosting costs are understood.

## Implemented in this first release

- **Free preview and policy simulation:** reuses the existing `POST /api/agent/v2/plan` and `POST /api/agent/v2/policy/simulate` routes. These are quote/policy operations, not payment execution.
- **Public pricing disclosure:** `GET /api/pricing` describes free preview, free self-hosted software, free read-only dashboard access (subject to API rate limits), and that a paid hosted-agent tier is not offered yet.
- **Cost estimate:** `POST /api/costs/estimate` accepts an approved `serviceId` and `maxPaidCalls` (1–3), uses the registry's informational price hint, and returns an upper estimate for the resource-transfer amount. It explicitly marks the estimate non-authoritative; the agent's actual HTTP 402 quote must govern any execution.
- **Per-wallet task quota:** the authorized `POST /api/agent/v2/run` path consumes a configurable daily quota after wallet authorization and before task execution. Default: 10 attempts per wallet per rolling 24-hour window; configurable with `HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY` from 1 to 100. The existing API request rate limiter remains active.
- **Quota visibility:** execution responses include limit and remaining count headers plus a usage summary. Exceeded quotas return HTTP 429 before payment execution.
- **Actual cost report:** completed tasks return a breakdown calculated from settlement receipts, with per-resource amounts and the aggregate HBAR amount. The report is included in the durable task result and task audit event.
- **No model inference for deterministic checks:** the current runner does not call an LLM, so its model inference cost is zero for this execution path. No model key is collected by the browser.
- **No new subscription or fee:** Heder1 service fee is explicitly zero in this release. Hosted infrastructure cost is marked unallocated/unknown rather than incorrectly reported as free.
- **Local self-hosting:** the existing API can run locally with user-managed testnet credentials in the ignored server-side `.env` file. No private key or provider API key is added to frontend configuration.

## Cost categories (kept separate)

1. **Provider resource payment:** actual HBAR transfer described by the service's HTTP 402 quote and confirmed by a settlement receipt.
2. **Heder1 service fee:** zero; not implemented in this release.
3. **Hedera network fee:** the Hedera x402 `exact` flow specifies that the facilitator pays/sponsors the settlement network fee. This applies only to supported x402 settlement; it does not pay the resource price, API hosting, database, monitoring, or model-provider bills.
4. **Model inference:** zero for the current deterministic runner because it makes no LLM calls.
5. **Hosting/infrastructure:** not allocated per task; costs are unknown until measured in the chosen deployment. The response explicitly reports this as unallocated, not $0.

HBAR amounts are reported in tinybars and HBAR. This release does not invent a USD conversion or a hosting-cost allocation. Registry hints are estimates only; live quotes and actual receipts take precedence.

## API examples

Pricing:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/pricing
```

Estimate three calls to an approved full-report service:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4000/api/costs/estimate -ContentType 'application/json' -Body '{"serviceId":"heder1-full-report","maxPaidCalls":3}'
```

The estimate uses the informational 0.001 HBAR-per-call registry hint and reports 0.003 HBAR as the estimated resource-payment ceiling for three calls. It is not a guarantee of live price; the actual quotes and the signed spending policy still control execution.

Quota is enforced only on the authorized task-run route. A quota rejection occurs before the payment runner is invoked. The existing cancellation endpoint remains a cancellation request; a transaction already submitted for settlement can still complete, so the final receipt must be checked.

## BYO model/API key and hosted plan decision

No LLM/model provider is currently used by the deterministic payment runner. Therefore this release does not ask for, accept, persist, or expose a model API key; adding a key-entry UI without a real model invocation path would create secret-handling risk without providing functionality. When a model provider is selected in a future phase, BYOK should be server-side only, use environment/secret-manager storage, provider/model allowlists, per-task token limits and cost ceilings, and never send secrets to the browser. Deterministic checks must stay outside the model path.

A usage-priced hosted-agent tier is deliberately deferred until deployment metrics establish actual costs. This release does not pretend hosting is free or add subscription/billing infrastructure.

## Compatibility and migration risk

- No dependency or lockfile changes.
- No database schema migration. Daily quotas use the existing shared `api_rate_limits` table when `DATABASE_URL` is configured; local development uses the existing in-process fallback. Production must use PostgreSQL for shared quotas/rate limits.
- Existing quote preview, policy simulation, wallet authorization, spending firewall, task idempotency, reservation ledger, x402 settlement, cancellation, and HCS audit flow remain in place.
- The quota key is derived from the verified wallet account, not a client-supplied wallet field.
- Cost reports use settlement receipts and integer tinybar arithmetic; no floating-point arithmetic is used for payment amounts.
- The first-release service fee remains zero; there is no new charge to users.

## Tests

The new cost-report tests cover pricing disclosure, bounded estimates, unknown services, exact receipt totals, invalid receipt amounts, and quota configuration. Run:

```powershell
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

## Official references

- Hedera's x402 overview: https://hedera.com/blog/hedera-and-the-x402-payment-standard/
- Hedera x402 exact payment scheme: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md
- Hedera x402 ecosystem examples and facilitator-sponsored fees: https://hedera.com/blog/x402-bounty-on-hedera-winners-announced/
- Hedera Agent Kit query-plugin catalogue (context for avoiding unnecessary model/tool calls): https://github.com/hashgraph/hedera-agent-kit-js/blob/main/docs/HEDERAPLUGINS.md

## Completion status and boundaries

This phase adds cost disclosure, quote-hint estimates, per-wallet daily task quotas, and receipt-based actual cost reporting. It does **not** add a hosted subscription plan, a model provider, API-key entry/storage, USD/FX conversion, or per-task infrastructure accounting. Those remain intentionally deferred until an actual model and deployment cost baseline exist. This is a testnet-focused prototype, not a production billing system.
