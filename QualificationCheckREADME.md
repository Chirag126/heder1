# Heder1 — Qualification Check and End-to-End Testnet Acceptance

This is the step-by-step acceptance guide for the seven checks used to validate Heder1's x402 qualification flow and key safety controls. Run it on your own local development machine against **Hedera Testnet only**.

> **Safety:** the live payment test sends Testnet HBAR. Do not use mainnet keys. Keep the API on `127.0.0.1`; never enable payment execution on a public Render/production deployment. Do not share secrets, authorization tokens, wallet signatures, or payment proofs. A failed or timed-out settlement may have an uncertain outcome—verify the chain before retrying.

## What these seven checks establish

1. Verify payer/facilitator configuration.
2. Verify both services publish real HTTP 402 quotes.
3. Verify wallet authorization and policy setup.
4. Run one autonomous paid task.
5. Verify the settlement independently on HashScan/Mirror Node.
6. Verify the local audit event and HCS anchor (if HCS is enabled).
7. Verify spending controls, replay protection, and the kill switch.

Passing these checks is a Testnet demo acceptance result, not a penetration test or production certification. HCS verification is conditional on HCS being configured and enabled.

## A. One-time setup

### A1. Install and configure

From the repository root in PowerShell:

```powershell
pnpm install
Copy-Item services/api/.env.example services/api/.env
```

Edit `services/api/.env` with a dedicated, funded Testnet payer's account ID and ECDSA private key, your intended receiver account ID, and the trusted facilitator URL. Do not put real secrets in this file in Git. Keep:

```dotenv
HEDERA_NETWORK=testnet
HOST=127.0.0.1
HEDERA_X402_DEMO_ENABLED=false
HEDERA_AGENT_ENABLED=false
HEDERA_AGENT_V2_ENABLED=false
```

If you want to test HCS, configure a real Testnet topic and least-privilege operator credentials before setting `HEDERA_AUDIT_HCS_ENABLED=true`. HCS submissions incur Testnet fees. If you use PostgreSQL, confirm `DATABASE_URL` points to a test database and migrations can run.

### A2. Run tests/build before the live test

```powershell
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

Record the output. If any command fails, stop and fix that first. Unit/integration tests are not a substitute for the live payment below.

### A3. Start app and inspect status

In Terminal 1:

```powershell
pnpm dev
```

In Terminal 2:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/health
Invoke-RestMethod http://127.0.0.1:4000/api/x402/status
Invoke-RestMethod http://127.0.0.1:4000/api/agent/v2/status
Invoke-RestMethod http://127.0.0.1:4000/api/agent/v2/services
Invoke-RestMethod http://127.0.0.1:4000/api/agent/v2/policy
```

Check that the network is `hedera:testnet`, the configured payer and receiver are the ones you intend, the service registry has the two approved local services, and mainnet execution is not enabled. At this point, Agent V2 should still report disabled.

## Test 1 — Verify payer and facilitator configuration

**Purpose:** confirm that the app has the intended Testnet configuration before enabling execution.

1. Inspect `/api/x402/status` as shown above.
2. Confirm `sdkConfigured: true`, `network: "hedera:testnet"`, the expected payer/receiver IDs, and the intended facilitator URL.
3. Confirm the payer has enough Testnet HBAR to cover the planned 0.0005–0.001 HBAR transfer and any applicable payer/network charges. A facilitator may pay network fees for the x402 settlement, but do not assume every setup operation is free.
4. Open the configured facilitator's `/supported` endpoint in a browser or use:

```powershell
Invoke-RestMethod https://api.testnet.blocky402.com/supported
```

Confirm it advertises the `exact` scheme for `hedera:testnet` and a Hedera fee payer. If you configured another compatible facilitator, substitute its trusted HTTPS base URL.
5. Do not proceed if configuration is missing, the scheme is absent, or the account IDs are wrong.

**Pass evidence:** status output plus facilitator support output, with sensitive values redacted before saving screenshots/logs.

## Test 2 — Verify both HTTP 402 quotes

**Purpose:** prove the endpoints are payment protected and publish their actual terms without making a payment.

Run:

```powershell
try {
  Invoke-WebRequest http://127.0.0.1:4000/api/x402/paid-resource
} catch {
  Write-Host "Full report HTTP status:" $_.Exception.Response.StatusCode.value__
}
try {
  Invoke-WebRequest http://127.0.0.1:4000/api/x402/summary
} catch {
  Write-Host "Short summary HTTP status:" $_.Exception.Response.StatusCode.value__
}
```

Expected status for each request: **402**. Inspect the response body/headers in your browser dev tools or with a small local HTTP client to confirm the x402 v2 requirements include `scheme=exact`, `network=hedera:testnet`, native HBAR asset `0.0.0`, the configured receiver, and the service-specific amount:
- Full report: `100000` tinybars = **0.001 HBAR**.
- Short summary: `50000` tinybars = **0.0005 HBAR**.

The first unauthenticated request is quote discovery; it should not settle a payment.

**Pass evidence:** both 402 statuses and the two quote payloads.

## Test 3 — Verify wallet authorization and policy

**Purpose:** prove the agent requires a fresh wallet-signed authorization before executing a task.

1. In the dashboard, connect your EVM-compatible wallet configured for Hedera Testnet (chain ID 296).
2. Use the Agent Playground's wallet authorization flow to obtain and sign the one-time Agent V2 challenge. The challenge endpoint is `POST /api/authorization/challenge`; verification is `POST /api/authorization/verify`. Sign the challenge message with the wallet's message-signing feature; this is not a transaction signature.
3. Ensure the scope is the Agent V2 bounded-task scope. The API checks the signature and issues a short-lived, single-use authorization grant.
4. Before providing a valid grant, try the agent run only if you can safely send a request without a valid token; expect HTTP **401** and no payment. Do not use an already-used `runId` for the later live run.
5. Review `/api/agent/v2/policy` and the dashboard policy. Defaults/hard ceilings include 100,000 tinybars per payment, 500,000 tinybars per task, 1,000,000 tinybars per day, at most 3 paid calls per task, and at most 10 daily attempts. Your wallet-signed policy must satisfy the schema and service allowlist.

If the dashboard doesn't expose a working wallet-signing flow, do not fabricate a token or paste a private key into a script. Record Test 3 as blocked and fix the UI integration before claiming acceptance.

**Pass evidence:** wallet address, scope, expiry, policy limits, and an authorization-denied result without exposing the token or signature.

## Test 4 — Execute one autonomous paid task

**Purpose:** complete a paid resource request end to end with no human approving each individual payment.

1. Confirm Tests 1–3 passed and you intend to spend Testnet HBAR.
2. In `services/api/.env`, set `HEDERA_AGENT_V2_ENABLED=true`. Keep `HEDERA_NETWORK=testnet`, `HOST=127.0.0.1`, `HEDERA_X402_DEMO_ENABLED=false`, and `HEDERA_AGENT_ENABLED=false`.
3. Restart the API so it reloads the environment. Verify `GET /api/agent/v2/status` reports `enabled: true`.
4. In the Agent Playground, submit a goal like: “Find the cheapest approved source for a short report and return its receipt.” Use a task budget no greater than 500,000 tinybars (0.005 HBAR) and paid calls at or below 3. The current example should choose the cheapest eligible service and ordinarily make one paid call.
5. Generate a fresh UUID if the UI asks for a run ID. Do not reuse a run ID; the server rejects reused IDs.
6. Submit using the valid wallet authorization. No separate human approval should be needed for each payment when the selected policy is autonomous and does not require quote-specific approval. Approval-required mode intentionally requires a separate signed quote approval.
7. Save the sanitized result. Expect `status: completed`, a selected service, actual expenditure, a settled receipt with a non-empty transaction ID, and a HashScan Testnet URL. The short-summary endpoint is 0.0005 HBAR; the full report is 0.001 HBAR.
8. If the task fails or times out after submission, do not blindly retry. Check the facilitator response, reservation state if available, and HashScan/Mirror Node first.

**Pass evidence:** complete agent result and receipt; redact tokens, signatures, and secrets.

## Test 5 — Independently verify the transaction

**Purpose:** confirm the settlement is actually present on Hedera Testnet, rather than relying only on the app's success message.

1. Copy the transaction ID from the returned receipt. Do not copy a transaction ID from an old run.
2. Open the receipt's HashScan URL, which should use the Testnet explorer.
3. Confirm the transaction exists and has successful status.
4. Inspect the transfer list. Verify the expected receiver account received the expected amount: 50,000 tinybars (0.0005 HBAR) for the short summary or 100,000 tinybars (0.001 HBAR) for the full report.
5. Note that a separate network fee may appear. The facilitator's fee-payer model means the paying agent does not necessarily pay gas directly; inspect the actual transaction instead of assuming fee behavior.
6. If HashScan is delayed, use the public Testnet Mirror Node transaction endpoint with the transaction ID normalized as required by the explorer/API. Do not mark the test passed until the public chain data agrees.

**Pass evidence:** transaction URL/ID, SUCCESS status, payer/receiver transfers, and amount. Redact unrelated account information if sharing screenshots.

## Test 6 — Verify the audit trail and HCS anchor

**Purpose:** link the agent/payment outcome to a tamper-evident audit record and, when configured, a public HCS hash anchor.

Run:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/audit/status
Invoke-RestMethod "http://127.0.0.1:4000/api/audit/records?limit=25"
Invoke-RestMethod http://127.0.0.1:4000/api/audit/anchors
```

1. Confirm `/api/audit/status` reports `valid: true` and a record count.
2. Find the records associated with the fresh run/payment, especially `agent.run_started`, `payment.settled`, and `agent.run_finished`.
3. If HCS is disabled, record the HCS part as **not run**, not passed. A valid local hash chain alone is not an HCS anchor.
4. If HCS is enabled, find the anchor associated with the audit sequence/hash. Open the returned Mirror Node URL and confirm the topic/message exists.
5. Call the app's verifier using the topic ID, sequence number, and exact expected audit hash:

```powershell
$topicId = "0.0.YOUR_TOPIC_ID"
$sequenceNumber = 1
$auditHash = "64_CHARACTER_LOWERCASE_SHA256_HASH"
Invoke-RestMethod "http://127.0.0.1:4000/api/audit/verify-hcs?topicId=$topicId&sequenceNumber=$sequenceNumber&auditHash=$auditHash"
```

Replace all three placeholders with the values from your actual anchor. Expect `valid: true` and matching hash values. Do not copy the example sequence number as evidence.

**Pass evidence:** valid local audit status and, if enabled, a successful public Mirror Node/HCS hash comparison.

## Test 7 — Verify spending limits, duplicate protection, and emergency stop

**Purpose:** confirm the safety boundary remains active around the live payment feature.

### 7A. Preview/no-payment path

Use the Agent Playground preview or call the plan endpoint with a goal. Example:

```powershell
$body = @{
  goal = "Find the cheapest approved source for a short report"
  budgetTinybars = 500000
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/agent/v2/plan -ContentType "application/json" -Body $body
```

Expected: `mode=preview`, `paymentAttempted=false`, candidate quotes/rejection reasons, and no payment receipt. Verify no new settlement transaction was created by this preview.

### 7B. Policy rejection

Use the Spending & Permissions UI or `POST /api/agent/v2/policy/simulate` to test a quote outside the service allowlist, wrong network/asset, above the per-payment cap, or over the task/daily budget. Expected: `allowed=false` with a rejection reason. This simulation does not send a payment.

Example request:

```powershell
$body = @{
  policy = @{
    mode = "autonomous"; network = "hedera:testnet"
    maxPaymentTinybars = 100000; taskBudgetTinybars = 500000
    dailyBudgetTinybars = 1000000; maxPaidCallsPerTask = 3
    maxPaidCallsPerDay = 10
    allowedServiceIds = @("heder1-short-summary")
    allowedAssets = @("0.0.0")
    expiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 120000
    approvalThresholdTinybars = 100000
  }
  quote = @{
    serviceId = "heder1-full-report"; network = "hedera:testnet"
    asset = "0.0.0"; amountTinybars = 100000
    taskSpentTinybars = 0; paidCallsThisTask = 0
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/agent/v2/policy/simulate -ContentType "application/json" -Body $body
```

Expected: rejection because `heder1-full-report` is not in this policy's allowlist. The quote is a policy simulation, not a payment.

### 7C. Duplicate run/payment protection

- Reusing a completed `runId` should return HTTP 409; the API also claims task IDs idempotently in persistent storage when configured.
- The paid-resource handler tracks a payment proof and, with PostgreSQL configured, uses durable atomic proof claims to prevent replay. A proof whose outcome is unknown is not automatically resubmitted.
- Do not deliberately replay a valid payment proof against a live endpoint merely to test this. Use the automated test suite for malformed/duplicate-proof cases; use a fresh UUID for each live run.

### 7D. Kill switch

1. Set `HEDERA_AGENT_KILL_SWITCH=true` in `services/api/.env` and restart the API.
2. Check `GET /api/agent/v2/status` and `GET /api/agent/v2/policy` for the stop state.
3. Attempt a harmless preview, then verify that actual execution is blocked. Do not use a paid request as a kill-switch test.
4. Restore the setting to `false` or remove it, restart the API, and confirm the normal status. Leave the kill switch enabled if you are finished testing.

**Pass evidence:** preview has no payment, an out-of-policy quote is rejected, duplicate run ID is rejected, and the kill switch blocks execution.

## Acceptance record

Use this table to record results. “Not run” is not a pass.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Payer/facilitator configuration | Not run | Redacted status + `/supported` output |
| 2 | Both HTTP 402 quotes | Not run | Status + actual quote terms |
| 3 | Wallet authorization/policy | Not run | Scope/expiry/policy + denied-without-grant result |
| 4 | Autonomous paid task | Not run | Fresh run result + receipt |
| 5 | Independent chain verification | Not run | HashScan Testnet URL + successful transfer |
| 6 | Audit/HCS verification | Not run | Local audit status + HCS verification if enabled |
| 7 | Spending controls/replay/kill switch | Not run | Preview, policy rejection, duplicate ID, stop-state outputs |

## What counts as a successful qualification demonstration?

- **Required criterion 1:** one x402-protected endpoint settles on Hedera Testnet through a compatible facilitator. Tests 1, 2, 4, and 5 establish this when they pass together.
- **Required criterion 2:** an agent/client discovers a quote and completes a paid request without human approval for that individual payment. Tests 3–5 establish this when the chosen policy is autonomous.
- **Extra point — spending controls:** Test 7 demonstrates bounded budgets, allowlists, preview behavior, duplicate protections, and the emergency stop.
- **Extra point — HCS audit:** Test 6 establishes this only if HCS is enabled and the public anchor verifies.

The app currently uses native HBAR on Testnet. It does not yet implement HTS/USDC settlement, HCS-14/ERC-8004 reputation, A2A/ACP negotiation, Scheduled Transactions recurring payments, or runtime Hedera Agent Kit/MCP integration. Do not claim those extras in a submission unless you implement and test them separately.

## Troubleshooting

- **Agent status says disabled:** check `HEDERA_AGENT_V2_ENABLED=true`, `HEDERA_NETWORK=testnet`, `NODE_ENV` is not production, and restart the API.
- **x402 status says not configured:** check the payer account ID, ECDSA key format, receiver ID, and Testnet network.
- **Facilitator fails:** inspect the sanitized error and `/supported`; do not switch to an unknown facilitator.
- **HTTP 401 on run:** authorization may be missing, expired, consumed, or scoped to a different operation. Request a fresh wallet-signed grant.
- **HTTP 409 on run:** the UUID/run ID or idempotency key was already used. Generate a new UUID.
- **HTTP 422/no eligible service:** inspect actual 402 quote requirements and policy constraints; no payment should have been attempted.
- **HTTP 503 or database failure:** if shared storage is configured, fix database availability instead of switching to local storage for production.
- **Settlement timeout/unknown:** do not retry blindly. Check HashScan/Mirror Node and the durable reservation/proof state first.
- **HCS verification fails:** confirm topic ID, message sequence, and the exact audit hash. Ensure HCS was enabled at the time the event was written.

## References

- [Heder1 how-to-use guide](./HowToUseREADME.md)
- [Heder1 Phase 10 implementation/evidence](./docs/PHASE-10.md)
- [Heder1 Phase 17 hardening](./docs/PHASE-17.md)
- [Hedera x402 documentation](https://docs.hedera.com/solutions/ai/x402)
- [Exact Hedera x402 scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [Hedera Mirror Node REST API](https://docs.hedera.com/hedera/sdks-and-apis/rest-api)
