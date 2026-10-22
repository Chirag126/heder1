# User spending policy, planning, and reservation operations

This document describes the Phase 11 user-defined policy and reservation APIs. Phase 12 adds PostgreSQL-backed storage and recovery behavior; see [the Phase 12 operations guide](PHASE-12.md). The project remains Hedera Testnet-only and is not production-ready until the deployment and operational acceptance steps are complete.

## Implemented

- Wallet-signed spending policy with bounded per-payment, task, and daily budgets.
- Approved service and native HBAR asset allowlists, short expiry, preview/autonomous/approval-required modes, and a server-side emergency kill switch.
- No-payment multi-service quote planning at `POST /api/agent/v2/plan`. It checks only the code-registered local service URLs, inspects HTTP 402 quotes, applies policy limits, and reports candidates/reasons. It never reserves or signs.
- Durable reservation records with unique IDs and task IDs.
- A version-2 JSON ledger with atomic file replacement and an exclusive lock directory, intended to serialize multiple processes sharing the same local filesystem.
- Conservative version-1 migration: old aggregate balances are retained as ambiguous legacy reservations, not silently released.
- Operator-only reservation listing and settlement reconciliation endpoints.
- Confirmed failure is the only reconciliation outcome that releases reserved budget. Ambiguous settlement retains its reservation. Settled outcomes require a transaction ID.
- Task ID, task budget, and paid-call count are included in reservation accounting. Autonomous mode can execute multiple eligible services sequentially, bounded by the signed policy and the persistent ledger; the dashboard defaults to two calls per task, with a hard maximum of three.

## API

### Preview a plan without payment

`POST /api/agent/v2/plan`

Example:

```json
{
  "goal": "Find the cheapest approved summary",
  "budgetTinybars": 500000,
  "policy": {
    "mode": "preview",
    "network": "hedera:testnet",
    "maxPaymentTinybars": 100000,
    "taskBudgetTinybars": 500000,
    "dailyBudgetTinybars": 1000000,
    "maxPaidCallsPerTask": 1,
    "maxPaidCallsPerDay": 10,
    "allowedServiceIds": ["heder1-short-summary", "heder1-full-report"],
    "allowedAssets": ["0.0.0"],
    "expiresAt": 1792622600000,
    "approvalThresholdTinybars": 50000
  }
}
```

The response contains discovered candidates, their quote eligibility/rejection reason, the cheapest eligible selection (if any), and `paymentAttempted: false`. A quote can change between preview and execution; the runner re-discovers it and applies the policy again. Preview output is not a reservation or guarantee of future price.

### Configure operator reconciliation

Set a high-entropy `HEDERA_RECONCILIATION_TOKEN` in the API environment. Keep it server-side only; never expose it to the web app or commit it. If it is absent, these endpoints remain disabled.

- `GET /api/agent/v2/reservations?limit=100` with header `x-heder1-reconciliation-token` lists reservation records.
- `POST /api/agent/v2/reservations/reconcile` with the same header and body:

```json
{
  "reservationId": "reservation UUID from the ledger",
  "outcome": "settled",
  "transactionId": "0.0.123@1234567890.000000001",
  "note": "Verified transaction and transfer on HashScan/Mirror Node"
}
```

Allowed outcomes are `settled`, `failed`, and `ambiguous`. For `settled`, provide a transaction ID. Always verify settlement independently against Hedera HashScan/Mirror Node before recording it. Mark `failed` only when there is reliable evidence that settlement did not occur. An ambiguous outcome does not release funds. Terminal settled/failed outcomes cannot be overwritten.

The reconciliation API records an operator's decision; it does not independently query Hedera or prove that the operator's claim is correct. Protect the token like an administrative credential and rotate it if exposed.

## Reservation storage and migration

Without DATABASE_URL in local development, the fallback ledger path is ./data/spending-firewall.json, configurable with HEDERA_FIREWALL_LEDGER_PATH. Version 2 records reservations and status and uses atomic replacement plus a local lock directory. This fallback is for local development only and is not safe for multi-instance payment execution.

When DATABASE_URL is configured, Phase 12 uses PostgreSQL transactions and advisory locks for wallet-scoped reservations. The first database-backed ledger operation conservatively imports the prior JSON ledger once; ambiguous balances remain held, and the source file is not deleted. In production, payment reservation and reconciliation operations fail closed if DATABASE_URL is absent. See PHASE-12.md for the schema, migration behavior, backups, and recovery sweep.

## Quote-specific wallet approval

The API now supports a backend wallet-signature approval path for an exact discovered quote:

1. Call `POST /api/agent/v2/plan` and inspect the selected service, amount, network, asset, and receiver.
2. Call `POST /api/agent/v2/approval/challenge` with the connected wallet address, the intended policy, and those exact quote fields. The server returns a human-readable message that binds the wallet, policy, quote, nonce, and expiry.
3. Ask the wallet to sign the returned message with `personal_sign` / EIP-191. This is a message signature, not a blockchain transaction signature.
4. Send the nonce and signature to `POST /api/agent/v2/approval/verify`. It returns a short-lived, single-use `approvalToken`.
5. Submit the normal `POST /api/agent/v2/run` body with `x-heder1-payment-approval: <approvalToken>`. The runner rediscovers the service quote and rejects execution unless service, network, asset, amount, receiver, and expiry exactly match the signed approval. The reservation firewall and kill switch are checked again before signing.

The challenge/verify approval token can authorize one exact quote only and is consumed once. A changed quote requires a new wallet approval. The existing dashboard does not yet expose all of these API steps as a guided UI; the backend endpoints are available for integration and tests.

Autonomous mode can execute multiple eligible services sequentially within the signed task budget and paid-call cap. Each payment receives its own reservation; uncertain outcomes remain reserved and the runner stops rather than retrying automatically.

## Validation

From the repository root:

```powershell
pnpm --filter @heder1/api test
pnpm --filter @heder1/api typecheck
pnpm --filter @heder1/api build
pnpm typecheck
pnpm build
```

Do not enable public Render payment execution. Use Hedera Testnet and dedicated test accounts. Passing automated checks is not a production security audit.


## Phase 12 durable storage

Production use requires an API-only DATABASE_URL. Wallet authorization challenges, one-time grants, quote-specific approvals, task IDs, reservation state, and sanitized audit metadata are stored in PostgreSQL. Bearer grants are stored as SHA-256 hashes and consumed atomically. Rate limits use shared database buckets when the database is configured.

The recovery sweep marks stale reserved/submitted states unknown. It does not infer that a timeout means failure and does not release funds. Verify HashScan/Mirror Node evidence before using the operator reconciliation API. See [docs/PHASE-12.md](PHASE-12.md) for the full operational guide and limitations.
