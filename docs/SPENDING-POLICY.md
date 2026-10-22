# User spending policy, planning, and reservation operations

This document describes the user-defined policy and reservation work currently implemented on top of the existing x402 runner. It is a Testnet-only prototype, not production payment infrastructure.

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

The default ledger path is `./data/spending-firewall.json`, configurable with `HEDERA_FIREWALL_LEDGER_PATH`. Version 2 records reservations, status, timestamps, transaction ID (when reconciled), and optional task ID. Writes use a unique temporary file plus rename while holding an exclusive lock directory. Lock acquisition times out and fails closed rather than permitting a payment. If a process crashes while holding a lock, the stale `.lock` directory may require operator inspection and removal after confirming no process is using it; never remove an active lock.

Version-1 aggregate balances are migrated conservatively. Existing reserved balances become ambiguous legacy records, and are retained in the daily totals. They cannot be attributed to an individual payment, so review the ledger and reconcile carefully before any release.

This design is suitable for a single host where all processes share the same filesystem and lock semantics. It is **not** a distributed database or safe for separate machines, ephemeral deployment filesystems, or serverless instances with independent disks. For that, replace the file ledger with a transactional shared database and row-level/serializable locking before enabling concurrent payment workers.

## Quote-specific wallet approval

The API now supports a backend wallet-signature approval path for an exact discovered quote:

1. Call `POST /api/agent/v2/plan` and inspect the selected service, amount, network, asset, and receiver.
2. Call `POST /api/agent/v2/approval/challenge` with the connected wallet address, the intended policy, and those exact quote fields. The server returns a human-readable message that binds the wallet, policy, quote, nonce, and expiry.
3. Ask the wallet to sign the returned message with `personal_sign` / EIP-191. This is a message signature, not a blockchain transaction signature.
4. Send the nonce and signature to `POST /api/agent/v2/approval/verify`. It returns a short-lived, single-use `approvalToken`.
5. Submit the normal `POST /api/agent/v2/run` body with `x-heder1-payment-approval: <approvalToken>`. The runner rediscovers the service quote and rejects execution unless service, network, asset, amount, receiver, and expiry exactly match the signed approval. The reservation firewall and kill switch are checked again before signing.

The challenge/verify approval token can authorize one exact quote only and is consumed once. A changed quote requires a new wallet approval. The existing dashboard does not yet expose all of these API steps as a guided UI; the backend endpoints are available for integration and tests.

The runner still executes at most one paid call per task. Durable task-level reservation accounting rejects repeated reservations beyond the signed task budget/call limit, but multi-service payment execution is not enabled yet.

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
