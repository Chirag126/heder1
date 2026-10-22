# Phase 14 — Product UI and normal-user experience

## Goal

Turn the technical dashboard into a guided, responsive product with separate pages while preserving the existing API and payment-safety model.

## Product routes

The web app uses hash-based routes so the existing Vite deployment can host all views without introducing a router dependency or requiring server rewrite rules.

- **Overview** (`#overview`): API and agent readiness, daily budget cap, local audit-chain status, current network, guided steps, recent task events, and the latest session receipt.
- **Agent Playground** (`#playground`): editable task prompt (maximum 2,000 characters), no-payment quote preview, eligible service comparison, rejection reasons, task execution, warnings, and returned receipts.
- **Spending & Permissions** (`#permissions`): EVM wallet connection, Hedera Testnet check (chain ID 296), preview/autonomous/approval-required mode, per-payment/task/daily limits, paid-call caps, service allowlist, one-time authorization, unused-grant revocation, cancellation request, and a browser-side pause for new task runs.
- **Payments & Receipts** (`#payments`): session receipts and sanitized audit events related to agent runs, payment, settlement, and reservation state. Transaction links are shown only when a transaction ID is present in returned receipt data or audit metadata.
- **Audit & HCS Evidence** (`#audit`): local hash-chain validity and head hash, indexed HCS anchors, Mirror Node hash verification, HashScan transaction links, and sanitized audit records.

## Guided workflow

1. Open Spending & Permissions and connect a compatible EVM wallet.
2. Verify the wallet is on Hedera Testnet; the UI never enables mainnet execution.
3. Set spending limits and choose at least one code-registered approved service.
4. Enter a task in Agent Playground and preview live service quotes. Preview uses `POST /api/agent/v2/plan` and reports that no payment was attempted.
5. For execution, explicitly consent and use the existing wallet-signed one-time authorization or quote-specific approval flow.
6. Observe the task response, warnings, and cancellation result. Cancellation is a request; a transaction already submitted may still settle.
7. Inspect Payments & Receipts and independently verify any transaction on HashScan. Use Audit & HCS Evidence to check local chain integrity and independently verify anchored hashes.

## Compatibility and migration risk

- No API route, request schema, database schema, or payment-runner behavior was changed for this phase.
- No new runtime or router dependency was added; the UI uses React already in the workspace and browser hash navigation.
- Existing API endpoints remain the source of truth for network, kill switch, policy validation, one-time grants, quote approvals, reservations, and settlement receipts.
- The service allowlist remains limited to the two already-registered service IDs. The UI cannot introduce arbitrary service URLs.
- The UI does not expose private keys, database credentials, facilitator secrets, or reconciliation tokens.
- Testnet remains the only enabled payment network. Mainnet payment execution is not implemented or enabled.
- The local task-run list is derived from sanitized audit records available through existing endpoints. It is not presented as a complete, independently indexed chain history.
- Wallet, grant, and browser-pause state remain in memory for the current browser session; this phase does not add persistence for wallet authorization. The pause control blocks new authorization/run requests from this browser only; it is not a server-wide kill switch and does not stop an already submitted task. The API-side `HEDERA_AGENT_KILL_SWITCH` remains the server-wide emergency control.
- HashScan links are not proof by themselves. A task response is not labeled as settlement success solely because the agent returned; the interface explains that the transaction ID should be verified independently. If the run request fails after submission, the UI warns that settlement is unknown and should be reconciled before retrying.

## Validation

Run these commands from the repository root:

```powershell
pnpm install
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

The API test command reports PostgreSQL integration tests as skipped when the test database is not configured. Run the project CI and perform a browser smoke test against a local API before merging. Verify wallet connect/switch, quote preview, both approval modes, a tiny testnet payment, receipt inspection, grant revocation, and HCS verification when anchoring is configured.

## References

- [x402 exact scheme for Hedera](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md) — network identifiers, HBAR/tinybar units, settlement response, and the distinction between verification and confirmed settlement.
- [Hedera smart-contracts workshop: setup](https://docs.hedera.com/hedera/tutorials/smart-contracts/hscs-workshop/setup) — Hedera EVM accounts and testnet setup.
- [Hedera Ethereum transaction documentation](https://docs.hedera.com/hedera/sdks-and-apis/sdks/smart-contracts/ethereum-transaction) — EVM transaction context and HBAR denomination notes.

