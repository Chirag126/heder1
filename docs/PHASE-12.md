# Phase 12 — Durable payment infrastructure and security

Phase 12 replaces the production payment-state dependency on local JSON files and process memory with PostgreSQL-backed state. The project remains Hedera Testnet-only; this phase does not enable public payment execution or approve mainnet use.

## Implemented in this branch

- **Transactional PostgreSQL storage:** versioned SQL migration for wallet identities, policy versions, task runs, payment reservations, one-time authorization challenges/grants, idempotency keys, audit metadata, rate-limit buckets, and legacy-ledger holds.
- **Atomic spend reservations:** transaction-scoped PostgreSQL advisory locks serialize each wallet/day budget check across API processes. Reservation rows are inserted in the same transaction as the budget decision.
- **Wallet-scoped accounting:** reservations and task limits are scoped to the wallet recovered from the signed authorization, rather than one process-global daily total.
- **Durable replay protection:** authorization challenges and quote-specific approvals are stored in PostgreSQL; grants are stored by SHA-256 token hash and consumed atomically. x402 payment-proof hashes are atomically claimed before facilitator verification/settlement. A duplicate settled proof returns the recorded receipt; processing/unknown proofs are blocked instead of resubmitted. A wrong-scope request does not consume a valid grant.
- **Task idempotency:** task/run IDs and idempotency keys are unique in the database, so a process restart does not reset the duplicate-run check.
- **Payment state tracking:** reservations move through reserved, submitted, settled, failed, rejected, unknown, and ambiguous states. Invalid or missing receipts and timeouts retain the reservation as unknown; there is no automatic payment retry.
- **Recovery sweep:** on startup and every minute, stale reserved/submitted reservations and task runs, plus stale processing proof claims, become unknown and are logged for reconciliation. The sweep never releases a reservation and never resubmits a payment.
- **Conservative JSON cutover:** before the first DB-backed ledger operation, the prior local JSON ledger is imported once by source path. Version-1 aggregate balances become global spending holds; version-2 reservations without known wallet attribution are retained under a legacy account. The source file is not deleted. Any unmatched legacy balance/attempt count becomes a hold.
- **API hardening:** PostgreSQL-backed per-IP/per-route rate limits when configured, development-only in-memory fallback, 16 KiB request body limit, exact-origin CORS, redirects rejected for registered paid services, and logger redaction for authorization/payment/reconciliation headers.
- **Audit metadata:** sanitized metadata is also written to PostgreSQL. The existing local hash-chain file and optional HCS anchors remain separate systems; the database metadata table is not itself a replacement for hash-chain/HCS verification.
- **CI:** the workflow starts PostgreSQL 16 and runs concurrent-reservation, state-transition, restart/replay, unit, type-check, and build checks.

## Configuration

Set DATABASE_URL in the **API server environment only**. Do not expose it as a VITE_* variable, place it in frontend configuration, or commit it to Git. render.yaml declares it as a secret value that must be configured by the operator.

After pulling Phase 12, install the newly added API dependencies from the repository root before running database-backed tests or builds:

```powershell
pnpm install
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

Example local setup in WSL/Ubuntu:

```bash
export DATABASE_URL='postgresql://heder1:YOUR_PASSWORD@YOUR_DB_HOST:5432/YOUR_DATABASE?sslmode=require'
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

The migration runner applies files in services/api/migrations/ under a PostgreSQL advisory lock and records each filename in schema_migrations. Migrations run lazily before the first database-backed operation. Keep the database reachable and take a backup before deploying a new migration.

### Local development compatibility

When DATABASE_URL is absent and NODE_ENV is not production, the old JSON ledger and in-memory authorization state remain available for local tests and development. The PostgreSQL driver is loaded lazily, so JSON-mode tests do not require the database driver at module-import time. Database-backed operations still require the `pg` package, installed by `pnpm install`. This fallback is **not multi-instance safe**. In production, reservation, challenge, grant, and reconciliation operations fail closed without DATABASE_URL; they do not silently fall back to local JSON or process memory.

### Legacy ledger migration

The importer reads the configured HEDERA_FIREWALL_LEDGER_PATH or ./data/spending-firewall.json from the API working directory. It fingerprints the source and records a one-time import in legacy_ledger_imports.

- Version-1 aggregate balances are held globally because they cannot safely be attributed to a wallet.
- Version-2 reservations with unknown wallet attribution are retained under legacy-unassigned; active or uncertain reservations remain counted.
- Unmatched balances and attempt totals become legacy_spending_holds.
- The source JSON is never removed or rewritten.
- Legacy holds are intentionally conservative and may reduce available budgets for all wallets until an operator reviews them. Do not manually delete a hold merely to unblock payments.

## State transitions and recovery

A reservation is persisted before the payment-bearing call. Immediately before the x402 request, the runner records submitted. If the facilitator call throws, times out, returns an invalid receipt, or returns no settlement receipt, the runner records unknown and stops. A timeout is **not** proof that no transfer happened.

The recovery sweep marks stale reserved/submitted reservations and task runs, plus stale processing proof claims, unknown. It does not query a guessed transaction ID, release funds, or retry the payment. An operator must inspect the payer/receiver and transaction history on HashScan and/or the Hedera Mirror Node, then use the existing operator reconciliation API with a server-only HEDERA_RECONCILIATION_TOKEN. Only confirmed failure may release the reservation. A settled result requires a transaction ID.

## Backup, restore, and operational monitoring

Backups and alert delivery are operator-managed and must be configured with the selected PostgreSQL provider. Example commands from WSL/Ubuntu:

```bash
# Create a backup in your own secure, off-host backup location.
pg_dump --format=custom "$DATABASE_URL" --file "heder1-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Restore into a separate recovery database first; verify before switching DATABASE_URL.
pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" heder1-backup.dump
```

Do not place database backups in the public repository. Restrict access, encrypt backups at rest and in transit, test restores regularly, and define retention according to your provider and project requirements.

Configure host/database alerts for connection failures, repeated migration failures, HTTP 429/503 spikes, recovery sweeps that mark records unknown, reservations stuck in reserved/submitted/unknown/ambiguous, and PostgreSQL storage/connection exhaustion. The API emits structured logs for recovery outcomes; this commit does not provision an external alerting service or a scheduled provider-level backup plan.

## Validation

The CI workflow supplies HEDER1_TEST_DATABASE_URL for PostgreSQL integration tests. To run them locally, set the same variable to a disposable PostgreSQL database; the test file temporarily uses it as DATABASE_URL.

```bash
pnpm --filter @heder1/api test
pnpm --filter @heder1/api typecheck
pnpm --filter @heder1/api build
pnpm typecheck
pnpm build
```

The PostgreSQL tests exercise concurrent reservations, budget caps, ambiguous settlement handling, one-time grants, and duplicate task IDs after a pool restart. They do not make live Hedera payments.

## Boundaries still requiring operator acceptance

- Payment execution remains disabled on public Render and in production; only Hedera Testnet/native HBAR is supported.
- The existing local JSONL audit hash chain and HCS anchor index are not yet a distributed audit log. PostgreSQL stores additional sanitized audit metadata, not a replacement chain.
- Recovery is conservative state classification plus operator reconciliation; it does not automatically infer settlement when the facilitator response omitted a transaction ID.
- Provider-level backup schedules, restore drills, alert routing, and production security review must be completed before treating this as production-ready.
- Run the pull request CI and review its result before merging. A source-code commit is not proof that a live Testnet payment or production deployment works.
