# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

heder1 is a testnet-focused Web3 project that demonstrates how an AI agent can access paid HTTP resources while operating within explicit spending limits and wallet authorization rules.

The project combines an x402 payment flow, a bounded autonomous agent, a spending firewall, wallet-signed one-time authorization, a hash-chained local audit log, optional Hedera Consensus Service (HCS) anchoring, and a live product dashboard.

> **Current status:** Phases 0–10 are implemented as a Hedera Testnet prototype. A local Phase 10 wallet-authorized run completed with a 0.0005 HBAR settlement; HashScan/Mirror Node and both matching HCS audit-anchor checks were verified for that recorded run. User policy, quote preview, quote-specific wallet approval APIs, and durable reservation/reconciliation operations are implemented on the feature branch described in the spending-policy guide. Public Render payment execution remains disabled. This is not production-ready payment infrastructure.

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Safety and payment limits](#safety-and-payment-limits)
- [Technology stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation and configuration](#installation-and-configuration)
- [Run the application](#run-the-application)
- [Phase 1: x402 paid resource](#phase-1-x402-paid-resource)
- [Phase 2: autonomous payment agent](#phase-2-autonomous-payment-agent)
- [Phase 3: spending firewall](#phase-3-spending-firewall)
- [Phase 4: wallet authorization](#phase-4-wallet-authorization)
- [Phase 5: verifiable audit trail and HCS](#phase-5-verifiable-audit-trail-and-hcs)
- [Phase 6: live product dashboard](#phase-6-live-product-dashboard)
- [Phase 7: testing and security hardening](#phase-7-testing-and-security-hardening)
- [Phase 8: public deployment](#phase-8-public-deployment)
- [Phase 9: settlement receipt validation](#phase-9-settlement-receipt-validation)
- [Phase 9 live acceptance evidence](#phase-9-live-acceptance-evidence)
- [Phase 10: autonomous agent v2](#phase-10-autonomous-agent-v2)
- [User spending policy and reservation operations](docs/SPENDING-POLICY.md)
- [Validation and testing](#validation-and-testing)
- [Limitations and future work](#limitations-and-future-work)
- [Official references](#official-references)
- [License](#license)

## Features

- **x402 payments:** handle HTTP 402 payment challenges and retry paid-resource requests.
- **Autonomous agent:** execute a bounded payment task against an allowlisted local resource.
- **Spending firewall:** enforce per-payment caps, a daily budget, and a daily attempt limit.
- **Wallet authorization:** verify a wallet-signed challenge and issue a short-lived, single-use authorization grant.
- **Tamper-evident audit log:** link local JSONL records using a SHA-256 hash chain.
- **HCS anchoring:** publish audit-record hashes to a Hedera Testnet topic and verify them against the public Mirror Node.
- **Live dashboard:** display backend configuration, agent status, spending policies, audit history, and HCS evidence.
- **Security-first defaults:** autonomous agent execution and the direct demo-payment endpoint are disabled by default.
- **Phase 10 autonomous agent v2:** approved service registry, actual HTTP 402 price discovery, deterministic cheapest-service selection, bounded x402 payment execution, cancellation, and settlement receipts. A local live run completed; independent explorer/audit verification is documented in the Phase 10 evidence section.
- **User spending policy:** wallet-signed limits, per-payment/task/daily budgets, allowlists, short expiry, grant revocation, and a server-side kill switch.
- **No-payment quote planning:** inspect registered services' actual HTTP 402 quotes and return candidate prices, selected service, and rejection reasons without signing or reserving funds.
- **Durable reservation ledger:** reservation IDs/status, atomic file replacement, exclusive local-filesystem locking, task-level budget/call accounting, conservative migration of older ledger balances, and operator-controlled settlement reconciliation. Ambiguous outcomes remain reserved.
- **Operator reconciliation API:** protected by a server-only `HEDERA_RECONCILIATION_TOKEN`; records operator-confirmed settlement outcomes after independent HashScan/Mirror Node checks. It does not independently prove settlement.
- **Quote-specific wallet approval:** a short-lived EIP-191 message binds the wallet approval to the exact service, network, asset, amount, receiver, policy, and expiry. The runner rediscovers the quote and fails closed if it changes. Backend endpoints are implemented; the guided dashboard flow remains to be integrated.

## Architecture

```text
Wallet / Dashboard
        |
        v
Fastify API
        |
        +--> Wallet authorization challenge and verification
        |
        +--> Autonomous agent
        |       |
        |       +--> Spending firewall
        |       |
        |       +--> x402 HTTP 402 challenge / retry
        |                    |
        |                    v
        |             Configured facilitator
        |
        +--> Local SHA-256 hash-chained audit log
        |                    |
        |                    v
        |             Hedera Testnet HCS
        |                    |
        |                    v
        |             Public Mirror Node verification
        |
        +--> Dashboard status, history, and evidence APIs
```

The facilitator handles the x402 verification and settlement flow. HCS anchors audit hashes; it does not store the entire local audit log or independently establish that an underlying payment or event was truthful.

## Safety and payment limits

| Control | Current policy |
|---|---|
| Network | Hedera Testnet |
| Maximum payment | 100,000 tinybars (0.001 HBAR) |
| Daily reserved budget | 1,000,000 tinybars (0.01 HBAR) |
| Daily attempt limit | 10 |
| Agent resource | Exact allowlisted local paid-resource route |
| Agent execution | Disabled by default |
| Direct demo-payment endpoint | Disabled by default |
| Wallet authorization | Short-lived, single-use grant |
| Local firewall and audit storage | Single-process prototype |

Important security rules:

- Never commit `.env` files, private keys, seed phrases, wallet credentials, or payment proofs.
- Do not put secrets in frontend code, README files, screenshots, logs, or public issues.
- Use dedicated testnet accounts and rotate credentials that have been exposed.
- Keep the API bound to localhost during local payment testing.
- Do not enable the agent or demo-payment endpoint in production.
- A facilitator-reported settlement is not independent proof of a confirmed on-chain transfer. Verify transaction details on HashScan.
- HCS anchoring provides independently inspectable hash evidence, not a production security certification.

## Technology stack

- TypeScript
- React and Vite
- Node.js and Fastify
- pnpm workspaces
- x402 SDK packages: `@x402/core`, `@x402/fetch`, and `@x402/hedera`
- Hedera Testnet
- Hedera SDK: `@hiero-ledger/sdk`
- EVM wallet provider for signed authorization
- SHA-256 hash-chained JSONL audit log

## Prerequisites

- Node.js 24 or newer
- Git
- pnpm 10
- VS Code (recommended)
- A Hedera Testnet account for testnet payment functionality
- An EVM-compatible wallet that supports Hedera Testnet for wallet authorization

## Installation and configuration

Clone the repository:

```bash
git clone https://github.com/Chirag126/heder1.git
cd heder1
npm install --global pnpm@10
pnpm install
```

Create a local API environment file by copying the example:

**Windows CMD:**

```cmd
copy services\api\.env.example services\api\.env
```

Fill in the appropriate values in `services/api/.env`. Never commit this file.

Example configuration:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_CLIENT_ACCOUNT_ID=0.0.YOUR_TESTNET_PAYER_ACCOUNT
HEDERA_CLIENT_PRIVATE_KEY=YOUR_TESTNET_ECDSA_PRIVATE_KEY
HEDERA_RECEIVER_ACCOUNT_ID=0.0.YOUR_TESTNET_RECEIVER_ACCOUNT
HEDERA_X402_FACILITATOR_URL=https://api.testnet.blocky402.com
HEDERA_X402_DEMO_ENABLED=false
HEDERA_AGENT_ENABLED=false
HEDERA_X402_PAID_RESOURCE_URL=http://127.0.0.1:4000/api/x402/paid-resource

HEDERA_AUDIT_HCS_ENABLED=false
HEDERA_AUDIT_HCS_TOPIC_ID=
HEDERA_AUDIT_HCS_OPERATOR_ACCOUNT_ID=
HEDERA_AUDIT_HCS_OPERATOR_PRIVATE_KEY=
```

Use your own testnet account IDs and private keys locally. The example values above are placeholders; do not paste actual keys into this README.

Create and fund testnet accounts through the [Hedera Portal](https://portal.hedera.com/).

## Run the application

Start the web dashboard and API using the repository's development script:

```bash
pnpm dev
```

Default local endpoints:

- Dashboard: http://localhost:5173
- API health: http://localhost:4000/api/health
- x402 status: http://localhost:4000/api/x402/status
- Agent status: http://localhost:4000/api/agent/status
- Audit integrity: http://localhost:4000/api/audit/status
- HCS anchor index: http://localhost:4000/api/audit/anchors

The dashboard reads status and audit information from the backend. Backend configuration and persisted local data determine the actual status; a frontend display alone is not proof that a payment settled.

## Phase 1: x402 paid resource

The paid-resource endpoint returns an HTTP 402 challenge when a request does not contain the required payment proof. The client processes the challenge, creates the payment payload using the configured payer, and retries the request.

The backend returns the protected resource only after the configured facilitator reports successful verification and settlement, including a transaction ID.

Endpoint:

```text
GET /api/x402/paid-resource
```

Run the demo from the repository root:

```bash
pnpm --filter @heder1/api demo:paid-resource
```

**Payment warning:** the client may make a 0.001 HBAR testnet payment. Only run it when you intend to make that payment and your testnet configuration is correct.

A successful response should include HTTP 200, the protected resource, settlement information, and a transaction reference. Verify the returned transaction independently on [HashScan Testnet](https://hashscan.io/testnet).

The paid-resource duplicate-proof protection is in-memory and is not durable across restarts or multiple instances.

## Phase 2: autonomous payment agent

The agent can evaluate its configured target and perform the x402 challenge/retry flow within a restrictive policy.

The policy restricts the agent to:

- Hedera Testnet
- The exact local resource path `/api/x402/paid-resource`
- The configured receiver
- Native HBAR
- A maximum payment of 0.001 HBAR
- A locally configured resource URL without query strings or credentials

Check the agent status without making a payment:

```cmd
curl http://localhost:4000/api/agent/status
```

Agent execution is disabled by default. For a deliberate local testnet run only, set:

```dotenv
HEDERA_AGENT_ENABLED=true
HEDERA_NETWORK=testnet
```

The run endpoint is:

```text
POST /api/agent/run
```

A valid single-use wallet authorization grant is required. An enabled run can spend testnet HBAR, so do not invoke it casually. Set `HEDERA_AGENT_ENABLED=false` again when testing is complete.

## Phase 3: spending firewall

Before the agent creates a signer or begins the payment flow, the spending firewall reserves the proposed spend in a persistent local ledger.

Current limits:

- Maximum 100,000 tinybars (0.001 HBAR) per payment.
- Maximum 1,000,000 tinybars (0.01 HBAR) reserved per UTC day.
- Maximum 10 payment attempts per UTC day.
- Exact local API port `4000` and allowlisted paid-resource path.
- Syntactically valid Hedera receiver account ID.
- Fail-closed behavior when the ledger is malformed or unreadable.
- Failed or ambiguous attempts remain counted to avoid repeated retries silently exceeding the budget.

Default ledger path:

```text
services/api/data/spending-firewall.json
```

The ledger location can be overridden with `HEDERA_FIREWALL_LEDGER_PATH`.

The API exposes the firewall policy through:

```text
GET /api/agent/status
```

**Limitation:** reservation serialization protects concurrent calls within one Node.js process. The local JSON ledger is not safe for multiple API instances or hosts. Use a transactional shared database before scaling or deploying publicly.

## Phase 4: wallet authorization

The dashboard supports wallet connection through an EVM-compatible provider and verifies Hedera Testnet chain ID `296` (`0x128`).

The authorization flow:

1. Connect a compatible wallet and verify the network.
2. Explicitly approve the limited, one-run permission in the dashboard.
3. Request a short-lived challenge from the API.
4. Sign the challenge using the wallet's `personal_sign` method.
5. Submit the challenge nonce and signature for server-side verification.
6. Receive a short-lived, single-use authorization grant.
7. Present the grant to the agent-run endpoint.

The API verifies the wallet signature and consumes the grant before invoking the agent. A valid grant does not override the server's `HEDERA_AGENT_ENABLED` switch.

Security boundaries:

- The frontend never requests or stores a wallet private key or seed phrase.
- The wallet signature proves control of the signing address; it does not expose the private key to heder1.
- The authorization store is in-memory and single-process. Restarting the API invalidates outstanding grants.
- Multi-instance deployment requires shared atomic storage, rate limiting, and additional security review.
- Wallet support depends on the wallet's compatibility with Hedera Testnet EVM chain ID 296.
- This authorization layer is a prototype and should not be exposed publicly without reviewing origin/CSRF protections, persistence, rate limiting, and wallet/account mapping.

## Phase 5: verifiable audit trail and HCS

### Local hash-chained audit trail

The API records security-relevant events, including wallet authorization outcomes, agent-run results, payment attempts, rejections, and settlement references.

The local append-only JSONL records contain sequence numbers, timestamps, event/outcome details, and SHA-256 hashes linked to previous records.

Default location:

```text
services/api/data/audit-trail.jsonl
```

Override the location with `HEDERA_AUDIT_LOG_PATH`.

The API provides:

```text
GET /api/audit/status
GET /api/audit/records?limit=30
```

The status endpoint validates the hash chain and reports its record count and head hash. The records endpoint returns a bounded, sanitized view and refuses to return records if integrity verification fails.

The log avoids storing raw payment payloads, wallet signatures, private keys, and seed phrases. The local file remains single-process storage; a host operator with write access can delete or replace it. Hash chaining is not a substitute for independent anchoring or a durable production audit system.

### Optional HCS anchoring

Optional Hedera Consensus Service anchoring is available behind an explicit opt-in. When enabled, each local audit record's SHA-256 hash is published as a compact JSON message to the configured Hedera Testnet topic.

Configure these settings locally:

```dotenv
HEDERA_AUDIT_HCS_ENABLED=true
HEDERA_AUDIT_HCS_TOPIC_ID=0.0.YOUR_TESTNET_TOPIC
HEDERA_AUDIT_HCS_OPERATOR_ACCOUNT_ID=0.0.YOUR_TESTNET_OPERATOR
HEDERA_AUDIT_HCS_OPERATOR_PRIVATE_KEY=YOUR_TESTNET_OPERATOR_PRIVATE_KEY
```

Use a dedicated, least-privilege testnet operator where possible. If the HCS-specific operator credentials are left blank, the implementation may fall back to the configured x402 payer credentials. Keep credentials private.

HCS anchoring is disabled by default. Each audit append may create a separate HCS transaction and incur fees. If anchoring fails after the local event has been persisted, reconcile the result rather than assuming the event was not recorded.

The API provides:

```text
GET /api/audit/anchors
GET /api/audit/verify-hcs?topicId=0.0.x&sequenceNumber=123&auditHash=EXPECTED_SHA256_HASH
```

The verification endpoint queries the public Hedera Testnet Mirror Node and compares the decoded message with the expected audit hash.

### Live testnet verification evidence

A testnet anchor was successfully checked against the public Mirror Node.

- **Network:** Hedera Testnet
- **Topic ID:** `0.0.11115485`
- **Sequence number:** `1`
- **Audit sequence:** `39`
- **Hash algorithm:** SHA-256
- **Verification result:** `valid: true`
- **Expected hash matched anchored hash:** Yes

Public Mirror Node message:

https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/1

The local verification endpoint returned `valid: true`, and the expected audit-record hash matched the hash decoded from the public HCS message.

This confirms that the specified audit hash was anchored and matched the public topic message. It does **not** establish that the underlying event was truthful or that a payment occurred. HCS stores the audit hash and minimal anchoring metadata, not the full local audit record.

Private keys, seed phrases, wallet signatures, and payment proofs must never be included in the README or committed to the repository.

## Phase 6: live product dashboard

The dashboard connects to the Fastify API to display live backend state rather than relying only on static labels.

### Dashboard capabilities

- **System status:** API health, network, and x402 configuration status.
- **Agent status:** enabled/disabled state and current spending-firewall limits.
- **Spending policy:** maximum payment, daily budget, attempt limit, allowlisted resource, and ledger limitations.
- **Wallet authorization:** connect wallet, verify Hedera Testnet, approve a limited permission, sign a one-time challenge, and request an authorized agent run.
- **Audit integrity:** local hash-chain status, record count, and recent sanitized activity.
- **HCS evidence:** indexed topic anchors, public Mirror Node links, and expected-hash verification controls.
- **Transaction references:** HashScan links where the backend recorded a transaction reference.
- **UI states:** manual refresh, loading indicators, errors, and empty states.

Run the dashboard and API:

```bash
pnpm dev
```

Open:

http://localhost:5173

The dashboard uses the following API endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | API health |
| `GET /api/x402/status` | x402 configuration and payment readiness |
| `GET /api/agent/status` | Agent and firewall policy |
| `POST /api/authorization/challenge` | Create a wallet-signing challenge |
| `POST /api/authorization/verify` | Verify the signature and issue a grant |
| `POST /api/agent/run` | Execute one authorized agent task if enabled |
| `GET /api/audit/status` | Verify local audit integrity |
| `GET /api/audit/records?limit=30` | Retrieve sanitized audit history |
| `GET /api/audit/anchors` | List locally indexed HCS anchors |
| `GET /api/audit/verify-hcs` | Verify a hash against a public Mirror Node message |

**Safety boundary:** the agent remains disabled by default. If explicitly enabled for local testnet development, an authorized run may spend up to 0.001 HBAR. The dashboard cannot override backend policy. The local audit log and spending firewall are not multi-instance safe, and a transaction link should be independently checked before treating it as proof of settlement.

## Phase 7: testing and security hardening

Phase 7 adds automated API integration coverage and adversarial tests around the payment and audit boundaries. CI runs the API test suite before type-checking and building.

Coverage includes:

- API health, invalid audit-history limits, and disabled-by-default agent/demo-payment routes using Fastify injection (no listening socket required).
- Duplicate concurrent x402 requests with a mocked facilitator, asserting only one verification/settlement sequence occurs.
- Audit history secret-key filtering for signatures, tokens, API keys, passwords, authorization values, cookies, and mnemonic fields.
- Spending-firewall policy-bypass attempts involving remote hosts, alternate paths, URL credentials, query strings, fragments, and malformed amounts/receivers.
- Existing authorization replay/expiry, facilitator failure, settlement withholding, and audit tamper-detection tests remain part of the suite.

All payment tests use mocked facilitator responses and do not submit HBAR or HCS transactions. Keep `HEDERA_AGENT_ENABLED=false`, `HEDERA_X402_DEMO_ENABLED=false`, and `HEDERA_AUDIT_HCS_ENABLED=false` while running automated tests.

## Phase 8: public deployment

The repository includes a Render Blueprint at `render.yaml` to deploy the API and dashboard as separate public services. Review the Blueprint and environment values before creating services. This config is a deployment starting point; it does not provision Hedera accounts, fund testnet HBAR, create HCS topics, or deploy services on your behalf.

### Deploy with Render

1. Push the merged code to GitHub and open the [Render Dashboard](https://dashboard.render.com/).
2. Choose **New → Blueprint**, connect this repository, and select the `render.yaml` file.
3. Review both services, their build/start commands, health check, static publish directory, and environment variables before approving creation.
4. Wait for the API service health check at `/api/health` and the static dashboard deployment to finish.
5. Open the public dashboard URL in a fresh private/incognito browser session and refresh the dashboard. Confirm API status, testnet network display, audit status, and disabled agent/payment controls.
6. If you add a payer key later, set it only as a secret environment variable in the API service's hosting dashboard. Never add it to `render.yaml`, the frontend environment, Git, logs, or README.

### Public-deployment security defaults

- API binds to `0.0.0.0` only in production; local runs default to `127.0.0.1`.
- `HEDERA_CORS_ORIGINS` is an exact comma-separated origin allowlist. The API rejects unknown browser origins and does not enable credentialed CORS.
- `HEDERA_AGENT_ENABLED=false`, `HEDERA_X402_DEMO_ENABLED=false`, and `HEDERA_AUDIT_HCS_ENABLED=false` remain the deployment defaults.
- Do not expose the agent or demo-payment endpoint publicly. The agent is intentionally disabled in production.
- The baseline deployment intentionally omits payer and HCS operator private keys. The dashboard and read-only status endpoints can be verified without those credentials; payment readiness remains false until an operator deliberately configures a dedicated testnet payer.
- If HCS anchoring is needed, create a testnet topic and use a dedicated least-privilege operator. Add its credentials only to the API host's secret environment settings and account for transaction fees.
- CORS is not authentication or rate limiting. Do not enable payments or configure valuable credentials until public API rate limits, persistent multi-instance storage, monitoring, and an operational security review are in place.

### Deployment environment

The Blueprint sets the network to Hedera Testnet and keeps payment execution and HCS anchoring off. It also sets the frontend's API base URL and the API's allowed frontend origin. If your hosting provider assigns different URLs, update both `VITE_API_BASE_URL` on the frontend build service and `HEDERA_CORS_ORIGINS` on the API service to match the exact deployed origins, then redeploy both services.

### Fresh-browser smoke test

- Open the dashboard from a private/incognito window.
- Confirm the API is connected and displays Hedera Testnet.
- Confirm the agent is disabled and demo-payment execution is off.
- Confirm audit status loads, including an empty state if no production-host audit file exists yet.
- Confirm browser developer tools show no CORS errors.
- Confirm wallet authorization can only issue a grant; agent execution remains disabled in production.
- Do not perform a live payment as part of the deployment smoke test.

## Phase 11: user-defined spending policy\n\nPhase 11 extends the existing firewall and wallet authorization with a policy object bound to the wallet-signed challenge, a no-payment quote simulation endpoint, signed per-payment/task/daily caps, service and native-HBAR allowlists, grant revocation, and a server-side emergency kill switch. The approval-required runner mode fails closed until an explicit approval-and-resume workflow is implemented. Mainnet remains disabled. See [docs/PHASE-11.md](docs/PHASE-11.md).\n\n## Validation and testing

Install dependencies first, then run the repository checks:

```bash
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

These commands test the API and validate types/builds. They do not independently prove that a live payment settled or that every HCS transaction can be verified.

For a payment demo, verify the returned transaction on HashScan. For HCS anchoring, inspect the public Mirror Node message and confirm that the expected audit hash matches.

## Phase 9: settlement receipt validation

Phase 9 hardens the agent's success criteria. A successful HTTP status by itself is not enough for Heder1 to report a paid-resource task as successful. The agent now requires the protected resource response to contain an explicit settlement receipt with `payment.status: "settled"`, a non-empty transaction ID, and the expected resource identifier.

When present, the agent returns a normalized settlement object with the transaction ID, settlement timestamp when provided, and a HashScan Testnet transaction URL. The agent completion audit event includes the settlement status and transaction reference so the dashboard's sanitized audit history can expose the receipt without storing payment signatures or private credentials.

Automated unit tests cover a valid settlement receipt, missing receipt, non-settled status, missing protected resource, and non-2xx response. These tests use local fixtures and do not make real payments.

### Phase 9 scope and verification status

- The existing x402 v2 client/resource-server flow is retained; this phase does not replace it wholesale with middleware.
- Existing facilitator capability discovery, fixed testnet payment requirements, proof validation, facilitator verification/settlement, and withholding the protected resource on settlement failure remain in place.
- The agent is still restricted to the exact loopback testnet resource and a fixed 0.001 HBAR cap. It remains disabled by default and refuses execution in production.
- This change makes the agent require and surface the resource's settlement receipt. It does **not** claim that a new live testnet payment has been executed as part of this code change.
- Before marking Phase 9 fully verified, run the local integration flow with dedicated testnet credentials, confirm the facilitator returns a transaction ID, and independently verify the transaction on HashScan.

The agent also requires the returned resource identifier to equal `heder1-demo-report`; an arbitrary non-empty resource string is not accepted as successful delivery. The HCS anchor list is separate audit evidence and does not satisfy the x402 settlement acceptance gate.

**Live acceptance checklist (local testnet only):**
1. With a dedicated Hedera Testnet payer configured only in `services/api/.env`, confirm `/api/x402/paid-resource` returns HTTP 402 before payment.
2. Authorize one agent invocation with a Hedera Testnet EVM wallet, then run the agent once.
3. Confirm the response reports `settlement.status = "settled"`, resource `heder1-demo-report`, and a non-empty transaction ID.
4. Open the returned HashScan Testnet link and independently check successful status, payer/receiver, and the 0.001 HBAR transfer.
5. Confirm the matching `payment.settled` and `agent.run_finished` records appear in local audit history.

### Phase 9 live acceptance evidence

**Result: PASS — Hedera Testnet live acceptance completed on 2026-10-22.**

The following Phase 9 evidence was checked after running the local, wallet-authorized agent flow:

| Check | Observed result |
|---|---|
| Unpaid protected-resource request | HTTP 402 challenge returned before payment |
| Agent result | HTTP 200; decision approved; settlement status `settled` |
| Protected resource | `heder1-demo-report` |
| x402 settlement transaction | `0.0.7162784@1792616089.538653745` |
| Settlement amount | 100,000 tinybars = 0.001 HBAR |
| Receiver | `0.0.11044329` |
| Independent transaction check | HashScan Testnet showed SUCCESS and the transfer details matched the audit receipt |
| Local audit chain | `valid: true`; 123 records; head hash `eed489f668beffe7add343788422ff1b7adc213988f4ad1215b4a5e78b6ac2a3` |
| Settlement audit records | `payment.settled` sequence #122 and `agent.run_finished` sequence #123 referenced the same settlement transaction |
| HCS anchors | 13 indexed anchors for topic `0.0.11115485`; the user confirmed anchor and hash verification succeeded |

Evidence links:

- [Verified x402 settlement on HashScan Testnet](https://hashscan.io/testnet/transaction/0.0.7162784%401792616089.538653745)
- [HCS topic message 13 on the public Mirror Node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/13)
- [HCS topic message 12 on the public Mirror Node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/12)

**Evidence boundaries:** The HashScan transaction above is the x402 payment settlement transaction. HCS `SUBMIT MESSAGE` transactions are separate anchoring transactions and must not be presented as the payment itself. The local audit endpoint reported `independentlyAnchored: false`; this describes the local hash-chain status response and does not negate the separately verified HCS topic messages. Local hash-chain validity, HCS hash matching, and on-chain payment settlement are distinct checks.

**Safety remains unchanged:** keep public Render agent/payment execution disabled. Never commit `.env`, private keys, wallet signatures, payment proofs, or other credentials. This acceptance result is for Hedera Testnet only and is not a mainnet approval or production security audit.

Useful checks:

```bash
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

## User spending policy and reservation operations

The policy and reservation work extends the existing spending firewall and approved-service runner. It adds:

- `POST /api/agent/v2/plan` for multi-service quote discovery and cost comparison. It never signs or sends payments.
- `GET /api/agent/v2/reservations` and `POST /api/agent/v2/reservations/reconcile` for operator-only reservation review and reconciliation. Configure `HEDERA_RECONCILIATION_TOKEN` server-side to enable these routes; never put it in frontend configuration.
- A durable version-2 reservation ledger with task IDs, budget/call accounting, migration of version-1 balances, atomic replacement, and an exclusive lock on the shared local filesystem.
- Conservative reconciliation: only a confirmed failure releases the reservation; ambiguous outcomes remain reserved; settled records require a transaction ID.

Read [the spending policy operations guide](docs/SPENDING-POLICY.md) for API examples, migration notes, operational safeguards, and limitations.

**Still not complete:** the backend supports quote-specific wallet approval and one-time resume authorization, but the dashboard does not yet guide users through every approval step. The executor intentionally makes at most one paid call per task. Task accounting enforces a multi-call budget/call limit for reservations, but multi-service payment execution is not enabled. The local JSON ledger is not a distributed database; do not use it across separate hosts or ephemeral instances. Mainnet and additional assets remain disabled.

## Limitations and future work

The current implementation is a testnet prototype. Important remaining hardening work includes:

- Shared transactional storage for firewall reservations and authorization grants.
- Durable replay protection for paid-resource proofs.
- Multi-instance-safe audit storage and operational recovery.
- Rate limiting, origin/CSRF controls, and deployment-specific wallet/account mapping.
- More end-to-end integration testing and failure-path testing.
- Production deployment review, monitoring, and secrets management.
- Demo video and final submission documentation.

Do not describe the project as production-ready until these limitations have been addressed and reviewed.

## Official references

- [Hedera x402 overview](https://docs.hedera.com/solutions/ai/x402)
- [How x402 works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Hedera x402 TypeScript package](https://www.npmjs.com/package/@x402/hedera)
- [Blocky402 quickstart and facilitator API](https://blocky402.com/docs/quickstart/)
- [Exact Hedera scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [Hedera Testnet Mirror Node](https://testnet.mirrornode.hedera.com/)
- [HashScan Testnet](https://hashscan.io/testnet)

## License

To be selected before public release.


## Phase 10: autonomous agent v2

The Phase 10 implementation is documented in [`docs/PHASE-10.md`](docs/PHASE-10.md). It provides two explicitly registered local testnet services, real HTTP 402 requirement inspection, deterministic cheapest-eligible selection, a persistent spend reservation before signing, a dedicated wallet authorization scope, bounded runtime/call limits, cancellation, safe-stop behavior, and receipt validation.

New local endpoints:

- `GET /api/agent/v2/services` — approved registry and informational price hints.
- `GET /api/agent/v2/status` — feature status and policy.
- `POST /api/agent/v2/run` — execute one bounded task after a Phase 10 wallet grant.
- `POST /api/agent/v2/cancel` — request cancellation using the client-generated UUID `runId`.
- `GET /api/x402/summary` — second paid service, priced at 50,000 tinybars (0.0005 HBAR).

Set `HEDERA_AGENT_V2_ENABLED=true` only for local Hedera Testnet testing. Keep public Render payment execution disabled. The code and automated tests do not replace a live testnet payment and independent HashScan receipt check; Phase 10 is not complete until that acceptance run succeeds.


### Phase 10 live run evidence — 2026-10-21

**Phase 10 evidence checks: PASS for on-chain payment and both HCS audit anchors.** The operator confirmed HashScan success; the public Hedera Testnet Mirror Node returned `SUCCESS` with the expected 50,000-tinybar transfer. The local audit chain validates, and the API's HCS verification endpoint returned `valid: true` for both the `payment.settled` and `agent.run_finished` audit hashes.

| Check | Observed result |
|---|---|
| Agent run ID | `d2e64178-19f9-4e80-a4ca-6855d63e82b9` |
| Agent status | `completed`; plan accepted; no reported plan errors |
| Discovery | 2 registered services checked; 4 HTTP calls |
| Deterministic selection | `heder1-short-summary` |
| Selected price | 50,000 tinybars = 0.0005 HBAR |
| Paid calls | 1 |
| Budget | 500,000 tinybars (0.005 HBAR); API reports 50,000 tinybars reserved |
| Settlement reported by API | `settled` |
| Independent Mirror Node result | `SUCCESS`; transaction type `CRYPTOTRANSFER` |
| Payment transfer | payer `0.0.11044318`: −50,000 tinybars; receiver `0.0.11044329`: +50,000 tinybars (0.0005 HBAR) |
| Network fee | 234,000 tinybars, charged separately to account `0.0.7162784` in the returned transaction data |
| Transaction ID returned | `0.0.7162784@1792621688.152704457` |
| Wallet authorization | Correct Phase 10 scope; single-use grant consumed |

Evidence links:

- [Open the reported Phase 10 settlement in HashScan Testnet](https://hashscan.io/testnet/transaction/0.0.7162784%401792621688.152704457)
- [Look up the transaction in the Hedera Testnet Mirror Node](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1792621688-152704457)

If you save the run response locally as `evidence/phase-10/successful-agent-run.json`, inspect it before committing and confirm it contains no secrets, signatures, authorization tokens, or payment proofs.

**Payment and audit verification are complete for this recorded run:** HashScan showed success and the public Mirror Node returned `SUCCESS`, with 50,000 tinybars transferred from `0.0.11044318` to `0.0.11044329`; the 234,000-tinybar network fee was charged separately to `0.0.7162784`. The local audit status returned `valid: true` for 153 records. HCS verification returned `valid: true` with exact expected/anchored hash equality for `payment.settled` (audit sequence 152, topic `0.0.11115485`, message 24) and `agent.run_finished` (audit sequence 153, same topic, message 25). This establishes the local record-to-HCS hash match for both events.

PowerShell audit inspection (local API must be running):

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/audit/status |
  ConvertTo-Json -Depth 5

Invoke-RestMethod "http://127.0.0.1:4000/api/audit/records?limit=30" |
  ConvertTo-Json -Depth 10

Invoke-RestMethod http://127.0.0.1:4000/api/audit/anchors |
  ConvertTo-Json -Depth 10
```

Use the matching anchor's `topicId`, `sequenceNumber`, and `auditRecordHash` to verify it via the API or public Mirror Node. The verification API is documented above as `GET /api/audit/verify-hcs?topicId=...&sequenceNumber=...&auditHash=...`.

The transaction above is the reported x402 payment. An HCS `SUBMIT MESSAGE` transaction is a separate audit-anchor transaction and must not be represented as the payment itself. Local hash-chain integrity, HCS hash matching, and payment settlement are three separate checks.


HCS verification evidence for the Phase 10 run:

- `payment.settled`: audit sequence 152; HCS topic `0.0.11115485`, message sequence 24; expected and anchored hash both `cd6e1cbd721d8b68ef882af992a9948c3cfc2b678ca785473ae7dc4b037ff2b4`. [Public HCS message 24](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/24).
- `agent.run_finished`: audit sequence 153; HCS topic `0.0.11115485`, message sequence 25; expected and anchored hash both `6508b4d231d14b70155d125ac837c531ef82690253a9cd4a97e12cf255e8f2f6`. [Public HCS message 25](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.11115485/messages/25).
- Local audit endpoint reported `valid: true`, 153 records, and head hash equal to the final `agent.run_finished` hash.

The HCS anchor is a separate consensus message, not the x402 payment transaction. These checks support the evidence for this specific Testnet run; they do not establish production readiness or protection from a host that can rewrite local files before anchoring.
