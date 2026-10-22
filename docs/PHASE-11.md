# Phase 11 — User-defined spending firewall and authorization

## Scope and safety boundary

Phase 11 extends the existing Phase 3 persistent spending firewall and Phase 4 wallet-signed authorization. It does not replace the x402 SDK or the Phase 10 approved-service registry.

This implementation is a conservative Testnet-only first slice. It binds a user policy into the wallet-signed challenge, validates a proposed quote without signing, enforces the signed policy before the payment signer is created, adds grant revocation, and adds an emergency environment kill switch. It does **not** enable mainnet.

## User policy

The signed policy includes:

- Mode: `preview`, `autonomous`, or `approval-required`.
- Network: currently fixed to `hedera:testnet`.
- Maximum payment: at most 100,000 tinybars (0.001 HBAR).
- Task budget: at most 500,000 tinybars (0.005 HBAR).
- Daily reserved budget: at most 1,000,000 tinybars (0.01 HBAR).
- Per-task paid-call count: at most 3; current executor deliberately executes at most one payment per task.
- Daily paid-call count: at most 10.
- Service allowlist: unique IDs from the code-reviewed Phase 10 registry only.
- Asset allowlist: native HBAR asset `0.0.0` only.
- Expiry: clamped to the short wallet authorization lifetime (two minutes).
- Approval threshold: a quote above the threshold requires approval.

The policy is serialized into the signed wallet message. The execution route uses the policy attached to the verified grant; caller-supplied run JSON cannot loosen it. The existing hard ceilings still apply even if a client asks for higher values.

## API endpoints

### Read policy defaults and hard ceilings

```http
GET /api/agent/v2/policy
```

### Simulate a quote without signing or spending

```http
POST /api/agent/v2/policy/simulate
Content-Type: application/json
```

Example body:

```json
{
  "policy": {
    "mode": "autonomous",
    "network": "hedera:testnet",
    "maxPaymentTinybars": 40000,
    "taskBudgetTinybars": 100000,
    "dailyBudgetTinybars": 200000,
    "maxPaidCallsPerTask": 1,
    "maxPaidCallsPerDay": 2,
    "allowedServiceIds": ["heder1-short-summary"],
    "allowedAssets": ["0.0.0"],
    "expiresAt": 1792622600000,
    "approvalThresholdTinybars": 20000
  },
  "quote": {
    "serviceId": "heder1-short-summary",
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amountTinybars": 50000
  }
}
```

The simulator returns `allowed`, `requiresApproval`, and a specific rejection reason. Simulation is advisory and does not reserve funds; the live runner repeats enforcement and reserves before signing.

### Sign the selected policy

Pass the policy object along with the existing wallet challenge fields to `POST /api/authorization/challenge`. Sign the returned message with the connected wallet, then verify it at `POST /api/authorization/verify`. The returned short-lived grant contains the signed policy. Never log or share authorization tokens or signatures.

### Revoke an unused grant

```http
POST /api/authorization/revoke
Content-Type: application/json

{"authorizationToken":"YOUR_SHORT_LIVED_TOKEN"}
```

This only revokes an unconsumed token. A consumed grant is single-use and no longer reusable. Cancel an active task with the existing `POST /api/agent/v2/cancel` endpoint and its run ID.

## Modes

- **Preview:** the simulator can inspect policy eligibility, but the execution runner refuses to sign or send a payment.
- **Autonomous:** eligible quotes can execute within the signed limits and the existing hard ceilings.
- **Approval-required:** the simulator pauses with `requiresApproval: true`; the runner fails closed rather than paying. A separate interactive approval/continuation workflow is still required before this mode can execute approved payments.

The approval threshold also pauses an autonomous-mode quote above the configured threshold. No current endpoint turns that pause into a payment automatically.

## Emergency kill switch

Set this environment variable on the API process:

```dotenv
HEDERA_AGENT_KILL_SWITCH=true
```

The Phase 10 runner checks the switch before discovery, before reservation/signing, and before payment delivery. Keep it set to `false` or unset for ordinary local testnet development. Restart/redeploy the API after changing environment configuration. This is a server-side emergency stop; it is not controlled by a public unauthenticated dashboard toggle.

## Reservations and ambiguous settlement

The persistent Phase 3 firewall reserves the quoted amount before signing. Phase 11 applies the lower of the user's signed per-payment/daily caps and the existing hard ceilings, and applies the signed daily call limit to the persistent attempt counter.

Reservations are deliberately conservative: the current ledger does not automatically release a reservation after a failed request or ambiguous timeout. If settlement may have occurred, retain the reservation and reconcile the transaction on HashScan/Mirror Node before deciding how to account for it. This avoids treating a possibly settled payment as safely unspent. The existing JSON ledger is serialized within one Node process only and is not multi-instance safe.

## Tests and validation

The Phase 11 tests cover:
- Per-payment cap, task budget, daily budget, task-call and daily-call rejection.
- Mainnet, unsupported asset, unapproved service, expired policy and kill-switch rejection.
- Preview and approval-required modes failing closed.
- Wallet signature binding to the exact policy and revocation of an unused grant.
- API policy simulation rejection cases.

Run from repository root:

```powershell
pnpm --filter @heder1/api test
pnpm --filter @heder1/api typecheck
pnpm --filter @heder1/api build
pnpm build
pnpm typecheck
```

## Explicit remaining work

This is not production-ready. The approval-required mode currently blocks payment safely but does not yet provide a complete approve-and-resume flow. Preview mode is available through the dashboard quote simulator; the current preview quote is a fixed sample offer rather than a full multi-service plan. The daily ledger is process-local, and ambiguous reservations require manual reconciliation. Mainnet, additional assets/decimals, multi-instance locking, and durable task-level multi-payment accounting remain disabled/out of scope.
