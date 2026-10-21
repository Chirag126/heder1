# Phase 10 — Autonomous agent v2

## Implementation status

The multi-service deterministic runner is implemented and a local wallet-authorized Hedera Testnet run completed successfully according to the API response on 2026-10-21. The API reported a 0.0005 HBAR settlement to the selected short-summary service and returned a transaction ID. Final acceptance still requires independent HashScan verification, matching audit/HCS verification, and a fresh local test/typecheck/build pass.

The runner adds a code-reviewed service registry with two local testnet endpoints, reads each service's actual HTTP 402 requirements, chooses the cheapest eligible offer deterministically, reserves the chosen spend through the persistent firewall, executes one bounded x402 payment, validates the returned settlement receipt, and reports actual expenditure.

## Registry

The registry is in `services/api/src/agent-v2.ts` and currently contains:

| Service ID | Endpoint | Advertised hint | Resource |
|---|---|---:|---|
| `heder1-full-report` | `/api/x402/paid-resource` | 100,000 tinybars (0.001 HBAR) | `heder1-demo-report` |
| `heder1-short-summary` | `/api/x402/summary` | 50,000 tinybars (0.0005 HBAR) | `heder1-short-summary` |

These are two separate registered endpoints served by the local API for development/testing. Metadata prices are hints only. Selection uses each endpoint's actual x402 v2 `accepts` array, not registry hints. No user- or model-supplied URL is fetched. URLs are restricted to the exact local testnet host/port boundary.

Inspect the registry:

```cmd
curl http://127.0.0.1:4000/api/agent/v2/services
curl http://127.0.0.1:4000/api/agent/v2/status
```

## Deterministic limits

| Limit | Default and hard ceiling |
|---|---:|
| Total task budget | 500,000 tinybars (0.005 HBAR) |
| Single payment | 100,000 tinybars (0.001 HBAR) |
| Paid calls | 3 maximum; current planner executes at most one selected paid call |
| Steps / total HTTP calls | 8 maximum |
| Runtime | 45 seconds maximum |
| Per-service attempts | 1 |
| Extra task retries | At most 1; no retry loop is used |
| Discovery timeout | 8 seconds per registered service |
| Paid request timeout | 15 seconds, within the total runtime budget |
| Network / asset | `hedera:testnet` / native HBAR asset `0.0.0` |

The runner's current example task chooses one cheapest eligible source for a report, so it pays at most once even though the task policy can state a ceiling of up to three paid calls. The persistent spending firewall also enforces the existing daily budget and attempt limit.

## Wallet authorization

Phase 10 requires a distinct, single-use wallet grant. Request a challenge with the Phase 10 scope:

```cmd
curl -X POST http://127.0.0.1:4000/api/authorization/challenge ^
  -H "content-type: application/json" ^
  -d "{\"account\":\"YOUR_EVM_WALLET_ADDRESS\",\"chainId\":296,\"scope\":\"heder1:agent-v2:bounded-task\"}"
```

Sign the returned `message` with the wallet's `personal_sign` method and verify it through the existing `POST /api/authorization/verify` endpoint. The response's `authorizationToken` is sent as `x-heder1-authorization`. Never share or log the token or wallet signature. The Phase 10 grant is scoped separately and cannot be consumed by the Phase 9 endpoint.

The signed message states a 0.005 HBAR total task ceiling, a 0.001 HBAR per-payment ceiling, and the approved registry boundary. The existing API does not receive a private key from the wallet; the configured testnet payer key stays in the local API environment.

## Run a bounded task

For local testnet testing only:

1. Start the API locally on port 4000.
2. Configure a dedicated funded Hedera Testnet payer in `services/api/.env`.
3. Keep `HEDERA_X402_DEMO_ENABLED=false`.
4. Set `HEDERA_AGENT_V2_ENABLED=true` and `HEDERA_NETWORK=testnet` only in the local development environment.
5. Fetch the service registry and status. Obtain and verify a Phase 10 wallet grant as described above.
6. Generate a UUID in PowerShell (run in a separate terminal):

```powershell
[guid]::NewGuid().ToString()
```

Keep that UUID as `RUN_ID`. You must provide it in the run request so a second terminal can cancel the active task before the first request finishes.

Execute the example goal:

```cmd
curl -X POST http://127.0.0.1:4000/api/agent/v2/run ^
  -H "content-type: application/json" ^
  -H "x-heder1-authorization: YOUR_SHORT_LIVED_PHASE_10_TOKEN" ^
  -d "{\"runId\":\"RUN_ID_FROM_POWERSHELL\",\"goal\":\"Find the cheapest approved source for a short report and return its receipt\",\"budgetTinybars\":500000,\"maxPaidCalls\":3}"
```

A successful response includes the selected service, actual amount, result, total reserved expenditure, and a HashScan transaction receipt. Verify the transaction independently on HashScan Testnet.

**This run may spend up to 0.001 HBAR in the current one-payment implementation.** Discovery requests are unpaid. Do not run it unless you intend to pay. Never enable `HEDERA_AGENT_V2_ENABLED` or payment execution on public Render/production.

## Cancellation

While the run request is still active in the first terminal, request cancellation from a second terminal using the same client-generated `runId`:

```cmd
curl -X POST http://127.0.0.1:4000/api/agent/v2/cancel ^
  -H "content-type: application/json" ^
  -d "{\"runId\":\"RUN_ID_FROM_POWERSHELL\"}"
```

Cancellation aborts in-flight HTTP requests and prevents later steps from proceeding. Cancellation cannot reverse a blockchain settlement that has already been submitted; check the final receipt and transaction status. Run IDs and cancellation state are process-local, so restarting the API stops all in-flight runs.

## Safe-stop behavior and audit

- A candidate must be registered, approved, allowlisted, local, on Hedera Testnet, native HBAR, and have a real 402 requirement within the task budget and per-payment cap.
- No eligible candidate results in HTTP 422 with `paymentAttempted: false`; the API integration test mocks two over-budget 402 quotes and asserts only the two unpaid discovery requests occur.
- A reservation is written before the payment signer is constructed.
- The SDK policy filters payment requirements to the selected exact network, asset, receiver, scheme, and amount.
- A paid response is accepted only if its resource ID, amount, settled status, and non-empty transaction ID match the selected service.
- Agent start/finish outcomes and payment settlement/rejection events use the existing audit trail.
- The LLM is not connected to the payment execution path. Planning and selection are deterministic.

## Test and build commands

Run from the repository root:

```cmd
pnpm --filter @heder1/api test
pnpm --filter @heder1/api typecheck
pnpm --filter @heder1/api build
pnpm build
pnpm typecheck
```

The automated suite tests registry policy, per-service prices, firewall reservations, authorization-scope separation, cancellation handling, and a no-eligible-service API run. It does not prove that a live testnet payment succeeded. A live local run on 2026-10-21 returned `status: completed`, selected `heder1-short-summary`, reported `payment.status: settled`, and returned transaction ID `0.0.7162784@1792621688.152704457` for 50,000 tinybars (0.0005 HBAR). See the README's Phase 10 live-run evidence section. The operator confirmed HashScan success, and the public Mirror Node returned `SUCCESS` for transaction `0.0.7162784-1792621688-152704457`. Its transfers show `0.0.11044318` sending 50,000 tinybars and `0.0.11044329` receiving 50,000 tinybars (0.0005 HBAR); a separate 234,000-tinybar network fee is charged to `0.0.7162784`. Payment verification is therefore complete. The local audit status returned `valid: true` for 153 records. The API's HCS verification endpoint returned `valid: true` and exact expected/anchored hash equality for `payment.settled` (audit sequence 152, topic `0.0.11115485`, message 24; hash `cd6e1cbd721d8b68ef882af992a9948c3cfc2b678ca785473ae7dc4b037ff2b4`) and `agent.run_finished` (audit sequence 153, same topic, message 25; hash `6508b4d231d14b70155d125ac837c531ef82690253a9cd4a97e12cf255e8f2f6`). The public Mirror Node message links are [message 24](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/24) and [message 25](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/25). The recorded run's payment and audit-anchor checks are complete; this remains Testnet evidence and does not establish production readiness or protection against host-level rewriting before anchoring.

## Remaining limitation

This is a testnet prototype with in-memory cancellation and a local JSON spending ledger. The daily ledger is serialized only within one Node process and is not multi-instance safe. The current executor performs one paid call per task, has no LLM integration, and uses two local endpoints rather than a public third-party discovery network. These limits are intentional for a first bounded version; do not describe it as production-ready.
