# Heder1 — How to Use the App

This guide explains how to set up, run, explore, and safely use Heder1 locally. Heder1 is a security-first x402 demo: an autonomous, budget-constrained client discovers a price quote from a registered HTTP service, pays through a Hedera Testnet facilitator, and receives a settlement receipt.

> **Testnet prototype, not production software.** Payment calls can transfer real Testnet HBAR. Never use mainnet credentials. Never publish your payer private key or expose the local payment API to the internet.

## 1. What the app does

- Exposes two x402-protected resources: a full report for **0.001 HBAR** and a short summary for **0.0005 HBAR**.
- Returns HTTP 402 and actual payment requirements when a resource is requested without payment.
- Lets the deterministic Agent V2 inspect approved service quotes and choose the cheapest eligible service.
- Enforces wallet authorization, service/network/asset allowlists, payment and task budgets, daily limits, durable reservations when PostgreSQL is configured, and an emergency kill switch.
- Returns a receipt with the facilitator transaction ID and a HashScan Testnet URL after settlement is confirmed.
- Can hash-chain audit events locally and optionally anchor audit hashes to Hedera Consensus Service (HCS).

The current agent is **deterministic, not LLM-powered**. The two services are local demo endpoints, not a public agent marketplace.

## 2. Prerequisites

- Windows 10/11, VS Code, Git.
- Node.js 24+ and pnpm 10.
- A dedicated, funded Hedera **Testnet** payer account with an ECDSA private key.
- An EVM-compatible wallet that can sign messages for Hedera Testnet (chain ID **296**) if using wallet authorization through the UI/API.
- Internet access to the configured facilitator and Hedera Testnet/Mirror Node.
- PostgreSQL for shared durable authorization, task state, replay protection, rate limits, and production-mode readiness. Local development can use the development-only local state where supported.

## 3. Clone and install

Open a VS Code terminal (PowerShell) and run:

```powershell
git clone https://github.com/Chirag126/heder1.git
cd heder1
corepack enable
corepack prepare pnpm@10.18.0 --activate
pnpm install
```

If you already cloned the repository, open that folder in VS Code and run `pnpm install` from the repository root.

Check your runtime:

```powershell
node --version
pnpm --version
```

Node should be v24 or newer and pnpm should be 10.x.

## 4. Configure the API environment

Create the local environment file:

```powershell
Copy-Item services/api/.env.example services/api/.env
```

Edit `services/api/.env` in VS Code. Set the following using your own Testnet values:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_CLIENT_ACCOUNT_ID=0.0.YOUR_TESTNET_PAYER_ACCOUNT
HEDERA_CLIENT_PRIVATE_KEY=YOUR_TESTNET_ECDSA_PRIVATE_KEY
HEDERA_RECEIVER_ACCOUNT_ID=0.0.YOUR_TESTNET_RECEIVER_ACCOUNT
HEDERA_X402_FACILITATOR_URL=https://api.testnet.blocky402.com
HEDERA_X402_DEMO_ENABLED=false
HEDERA_AGENT_ENABLED=false
HEDERA_AGENT_V2_ENABLED=false
HEDERA_X402_PAID_RESOURCE_URL=http://127.0.0.1:4000/api/x402/paid-resource
HEDERA_AUDIT_HCS_ENABLED=false
HEDERA_AUDIT_HCS_TOPIC_ID=
HEDERA_AUDIT_HCS_OPERATOR_ACCOUNT_ID=
HEDERA_AUDIT_HCS_OPERATOR_PRIVATE_KEY=
PORT=4000
HOST=127.0.0.1
```

Important:
- Replace the placeholders locally. Do not send keys in chat, commit them, or paste them into frontend variables.
- Keep `HEDERA_NETWORK=testnet`, `HOST=127.0.0.1`, and the API local.
- Leave the direct demo-payment endpoint disabled. The Agent V2 route is the intended bounded workflow.
- To use HCS anchoring, first create a Testnet topic, then set `HEDERA_AUDIT_HCS_ENABLED=true`, its `0.0.x` topic ID, and a funded least-privilege Testnet operator. HCS submits paid network transactions; only enable it when you understand those costs.
- If you configure `DATABASE_URL`, database-backed operations and migrations are used. Do not point a demo at a production database.

Fund a Testnet account using the official [Hedera Portal](https://portal.hedera.com/). Verify account IDs and balances before any payment.

## 5. Start the app

From the repository root:

```powershell
pnpm dev
```

This starts the API (normally `http://127.0.0.1:4000`) and web dashboard (normally `http://localhost:5173`). Keep the terminal open. If either service fails to start, read the terminal output before proceeding.

Open the dashboard at `http://localhost:5173`.

## 6. Explore the dashboard without paying

Start with the Overview, Agent Playground, Spending & Permissions, Payments & Receipts, and Audit & HCS Evidence areas.

You can inspect these read-only API endpoints in a browser or PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/health
Invoke-RestMethod http://127.0.0.1:4000/api/health/ready
Invoke-RestMethod http://127.0.0.1:4000/api
Invoke-RestMethod http://127.0.0.1:4000/api/x402/status
Invoke-RestMethod http://127.0.0.1:4000/api/agent/v2/status
Invoke-RestMethod http://127.0.0.1:4000/api/agent/v2/services
Invoke-RestMethod http://127.0.0.1:4000/api/agent/v2/policy
Invoke-RestMethod http://127.0.0.1:4000/api/pricing
Invoke-RestMethod http://127.0.0.1:4000/api/audit/status
```

A healthy process does not by itself prove the facilitator is available or that a payment will settle. `/api/health/ready` checks shared database readiness in production; it is not an external payment dependency health check.

## 7. Understand the two paid services

| Service ID | Endpoint | Fixed quote |
|---|---|---:|
| `heder1-full-report` | `/api/x402/paid-resource` | 0.001 HBAR |
| `heder1-short-summary` | `/api/x402/summary` | 0.0005 HBAR |

A request without a payment proof should return HTTP **402 Payment Required** and an x402 v2 quote. This first request is a quote discovery request, not a payment.

PowerShell example:

```powershell
try {
  Invoke-WebRequest http://127.0.0.1:4000/api/x402/paid-resource
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected: 402. The endpoint withholds the resource until the facilitator confirms settlement.

## 8. Run an autonomous paid task (Testnet only)

**This step can transfer up to 0.001 HBAR for the current one-payment task. Continue only when you intend to make a Testnet payment.**

1. Confirm the API is bound to localhost, the payer is a dedicated Testnet account, the receiver is correct, and the facilitator URL is trusted.
2. Confirm `HEDERA_NETWORK=testnet` and `HEDERA_AGENT_KILL_SWITCH` is not set to `true`.
3. Set `HEDERA_AGENT_V2_ENABLED=true` in `services/api/.env`. Keep `HEDERA_X402_DEMO_ENABLED=false` and `HEDERA_AGENT_ENABLED=false`.
4. Restart the API so it loads the updated environment.
5. Connect the Testnet wallet in the dashboard and complete the wallet-signed, short-lived Agent V2 authorization flow. Do not use a wallet private key in an API request. The API verifies a message signature; it does not ask the wallet to sign a payment transaction.
6. Check the approved services and their actual quotes. The agent inspects HTTP 402 responses rather than trusting the informational price hints.
7. Submit a task in the Agent Playground using a goal such as “Find the cheapest approved source for a short report and return its receipt.” Keep the budget at or below 500,000 tinybars (0.005 HBAR) and paid calls at or below 3. The current planner ordinarily pays for only one selected service.
8. Inspect the task result. A successful result should include the selected service, amount, result, expenditure, a non-empty transaction ID, and a HashScan Testnet receipt URL.
9. Open the transaction URL and independently confirm the transaction status and receiver transfer on HashScan Testnet.
10. Inspect Payments & Receipts and Audit & HCS Evidence. If HCS is enabled, verify the corresponding audit hash against the public Mirror Node.

If the task is rejected, do not repeatedly retry blindly. Read the response and API logs, confirm the wallet authorization is valid and unexpired, confirm the service quotes and account balance, and inspect any existing reservation/receipt before retrying. An uncertain settlement should be reconciled using independent chain evidence rather than replayed.

## 9. Preview and spending controls

- Use preview/planning mode to inspect eligible quotes and rejection reasons without payment.
- Review service allowlists, network, asset, per-payment cap, task budget, daily budget, paid-call limit, policy expiry, and approval threshold.
- The quote-specific approval flow binds approval to the service, network, asset, amount, and receiver. Use it when you want explicit wallet approval for a particular quote.
- To stop future agent work, set `HEDERA_AGENT_KILL_SWITCH=true` and restart the API. Verify the status endpoint reports the stop state. This cannot reverse a transaction already submitted.
- Do not increase limits simply to make a failed test pass.

## 10. Audit and HCS evidence

Inspect local audit-chain integrity:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/audit/status
Invoke-RestMethod http://127.0.0.1:4000/api/audit/records?limit=25
Invoke-RestMethod http://127.0.0.1:4000/api/audit/anchors
```

The local hash chain detects certain changes to retained records but is not protection against host-level deletion or rewriting. HCS anchors provide public, independently inspectable hash evidence when configured; they do not prove every other field in a record is truthful.

## 11. Stop the app

Press `Ctrl+C` in the terminal running `pnpm dev`. Return `HEDERA_AGENT_V2_ENABLED=false` in the local env file after testing, then restart the API. Keep secrets out of Git.

## 12. Validate code changes

From the repository root:

```powershell
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

All three commands should pass before you treat a code change as validated. A passing test suite is not the same as a live Testnet payment; use [QualificationCheckREADME.md](./QualificationCheckREADME.md) for the separate seven-step acceptance procedure.

## Official references

- [Hedera x402](https://docs.hedera.com/solutions/ai/x402)
- [Hedera x402 — how it works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Exact Hedera x402 scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [Hedera Mirror Node REST API](https://docs.hedera.com/hedera/sdks-and-apis/rest-api)
- [Heder1 Phase 10 evidence](./docs/PHASE-10.md)
- [Spending policy operations](./docs/SPENDING-POLICY.md)
