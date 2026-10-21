# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

heder1 is a testnet-focused Web3 project that demonstrates how an AI agent can access paid HTTP resources while operating within explicit spending limits and wallet authorization rules.

The project combines an x402 payment flow, a bounded autonomous agent, a spending firewall, wallet-signed one-time authorization, a hash-chained local audit log, optional Hedera Consensus Service (HCS) anchoring, and a live product dashboard.

> **Current status:** Phases 0–6 have been implemented in the project workflow. The HCS testnet verification described below succeeded for the documented topic message. Run the latest tests, typecheck, and build after pulling the final changes. This remains a prototype, not a production-ready payment infrastructure.

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

## Validation and testing

Install dependencies first, then run the repository checks:

```bash
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

These commands test the API and validate types/builds. They do not independently prove that a live payment settled or that every HCS transaction can be verified.

For a payment demo, verify the returned transaction on HashScan. For HCS anchoring, inspect the public Mirror Node message and confirm that the expected audit hash matches.

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
