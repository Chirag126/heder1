# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

heder1 demonstrates a fixed-price HTTP resource protected by the x402 v2 payment flow on **Hedera testnet**. A client receives an HTTP 402 challenge, creates a payment payload using the configured payer, and retries the request. The API asks the configured facilitator to verify and settle the payment, and returns the protected resource only when settlement reports success with a transaction ID.

> **Status:** The end-to-end paid-resource demo has returned HTTP 200 with a facilitator-reported settlement transaction on Hedera testnet. Verify transaction details on HashScan for independent confirmation. Typecheck and production builds have passed locally. The Phase 3 spending firewall now adds a persistent local reservation ledger, a fixed per-payment cap, a UTC-day budget, and a daily attempt limit. The local JSON ledger is single-process only; multi-instance deployment requires a transactional shared database.

## Safety and payment limits

- **Testnet only.** The paid-resource client refuses to run unless `HEDERA_NETWORK=testnet`.
- Fixed price: **100,000 tinybars = 0.001 HBAR** per paid-resource request.
- The recipient is configured by `HEDERA_RECEIVER_ACCOUNT_ID` (default `0.0.11044329`).
- The facilitator is configured by `HEDERA_X402_FACILITATOR_URL` (default `https://api.testnet.blocky402.com`).
- Never commit `.env` files, private keys, seed phrases, or funded-wallet credentials. Never use mainnet keys for this demo.
- The direct demo-payment endpoint is separate from the HTTP 402 flow. It is disabled by default and must remain local-only.
- The paid-resource route's duplicate-proof protection is **in-memory only**; it is not durable across restarts or multiple instances. Do not treat this prototype as production-ready.

## Stack

- TypeScript, React + Vite, Node.js + Fastify, pnpm workspace
- `@x402/core`, `@x402/fetch`, `@x402/hedera`
- Hedera testnet and a compatible x402 facilitator

## Prerequisites

- Node.js 24 or newer
- Git and pnpm 10
- VS Code (recommended)

## Local setup

```bash
git clone https://github.com/Chirag126/heder1.git
cd heder1
npm install --global pnpm@10
pnpm install
```

Copy `services/api/.env.example` to `services/api/.env`, then fill in your own **Hedera testnet ECDSA payer credentials** locally:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_CLIENT_ACCOUNT_ID=0.0.YOUR_TESTNET_PAYER_ACCOUNT
HEDERA_CLIENT_PRIVATE_KEY=YOUR_TESTNET_ECDSA_PRIVATE_KEY
HEDERA_RECEIVER_ACCOUNT_ID=0.0.11044329
HEDERA_X402_FACILITATOR_URL=https://api.testnet.blocky402.com
HEDERA_X402_DEMO_ENABLED=false
HEDERA_AGENT_ENABLED=false
HEDERA_X402_PAID_RESOURCE_URL=http://127.0.0.1:4000/api/x402/paid-resource
```

Create/fund testnet accounts through the [Hedera Portal](https://portal.hedera.com/). Do not paste private keys into issues, chat, logs, or source files.

Start both apps:

```bash
pnpm dev
```

- Web dashboard: http://localhost:5173
- API health: http://localhost:4000/api/health
- x402 configuration status: http://localhost:4000/api/x402/status

## Run the paid-resource demo

Ensure the API is running locally and the facilitator is reachable. The client uses the payer credentials from `services/api/.env` and may make a **0.001 HBAR testnet payment** when the challenge is accepted.

```bash
pnpm --filter @heder1/api demo:paid-resource
```

A successful response should include HTTP status `200`, resource `heder1-demo-report`, payment status `settled`, a transaction ID, and a HashScan URL. Open the URL and verify the transaction status and transfer details. Do not treat a facilitator response alone as independent chain verification.

## Phase 2: bounded autonomous payment agent

The local agent can discover and evaluate its configured paid resource, then perform the x402 HTTP 402 challenge/retry automatically under a fixed policy. It is intentionally limited to the exact local route `/api/x402/paid-resource`, Hedera testnet, the configured receiver, native HBAR, and **at most 0.001 HBAR**. Remote URLs, alternate paths, query strings, and credentials in URLs are rejected. The agent is disabled by default and refuses to run in production.

1. Start the API locally with `pnpm dev`.
2. In `services/api/.env`, set `HEDERA_AGENT_ENABLED=true` and keep `HEDERA_NETWORK=testnet`.
3. Check policy/status without paying:

```cmd
curl http://localhost:4000/api/agent/status
```

4. Run one agent task:

```cmd
curl -X POST http://localhost:4000/api/agent/run
```

**Payment warning:** an enabled run can send one **0.001 HBAR testnet payment**. The agent is not a background scheduler and this first version only handles one allowlisted resource. Keep the API bound to localhost, never enable it in production, and set `HEDERA_AGENT_ENABLED=false` when finished. A facilitator-reported transaction still needs independent HashScan verification.

## Phase 3: spending firewall\n\nBefore the autonomous agent creates a signer or starts the x402 payment flow, it reserves the intended spend in a local persistent ledger. The firewall currently enforces:\n\n- Maximum **100,000 tinybars (0.001 HBAR)** per payment.\n- Maximum **1,000,000 tinybars (0.01 HBAR)** reserved per UTC day.\n- Maximum **10 payment attempts per UTC day**.\n- Exact local API port `4000`, exact paid-resource path, and a syntactically valid Hedera receiver account ID.\n- A fail-closed policy if the ledger is corrupt or cannot be read.\n- A conservative reservation: failed or ambiguous attempts remain counted, preventing repeated retries from silently exceeding the budget.\n\nThe ledger is stored at `services/api/data/spending-firewall.json` by default and is ignored by Git. The status endpoint reports the active limits at `GET /api/agent/status`. This first version serializes concurrent reservations within one Node.js process; it is **not safe for multiple API instances or multiple hosts**. Use a transactional shared database before scaling or deploying publicly. The firewall does not replace facilitator verification, chain verification, or a production security review.\n\n## Optional direct payment endpoint

This is a separate local-only test endpoint and is not needed for the paid-resource demo. It can send **0.001 HBAR** from the configured payer.

1. Keep the API bound to localhost.
2. Set `HEDERA_X402_DEMO_ENABLED=true` in `services/api/.env` and restart the API.
3. Explicitly confirm the test payment from CMD:

```cmd
curl -X POST http://localhost:4000/api/x402/demo-payment -H "Content-Type: application/json" -d "{\"confirmPayment\":true}"
```

4. Verify any returned transaction ID on [HashScan Testnet](https://hashscan.io/testnet).
5. Set `HEDERA_X402_DEMO_ENABLED=false` again.

Never expose this endpoint publicly or enable it in production.

## Validation

```bash
pnpm typecheck
pnpm build
```

These checks validate types and builds; they do not replace automated tests or on-chain verification.

## Development status

- [x] Repository foundation, dashboard shell, and Fastify health endpoint
- [x] x402 SDK dependencies and testnet payer configuration-status endpoint
- [x] Configurable testnet receiver and facilitator
- [x] Opt-in, fixed-amount direct facilitator-backed testnet payment endpoint
- [x] HTTP 402 paid-resource challenge and automatic client retry
- [x] Strict client-side policy for testnet, exact scheme, native HBAR, configured receiver, and fixed amount
- [x] Facilitator verification and settlement before protected resource response
- [x] Local end-to-end demo returned HTTP 200 with a settlement transaction ID
- [x] Automated x402 tests for challenge, invalid proofs, facilitator errors, and successful mocked settlement
- [x] Phase 2 bounded autonomous agent with target allowlist, testnet-only policy, and fixed 0.001 HBAR cap
- [ ] Automated end-to-end agent run against a mocked local service in CI
- [x] Phase 3 spending firewall: persistent local ledger, per-payment cap, daily budget, daily attempt limit, and fail-closed ledger validation\n- [ ] Shared transactional ledger for multi-instance deployments\n- [ ] Durable replay protection for paid-resource proofs and persistent settlement audit trail
- [ ] Optional HCS audit records
- [ ] Public deployment and deployment security review
- [ ] Demo video (5 minutes or less)

## Official references

- [Hedera x402 overview](https://docs.hedera.com/solutions/ai/x402)
- [How x402 works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Hedera x402 TypeScript package](https://www.npmjs.com/package/@x402/hedera)
- [Blocky402 quickstart and facilitator API](https://blocky402.com/docs/quickstart/)
- [Exact Hedera scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)

## License

To be selected before public release.


## Phase 4 — Wallet and authorization UI

The web app includes an EVM-provider wallet connection flow, connected account display, Hedera Testnet chain-ID verification (296 / `0x128`), a network-switch request, and a limited-consent panel describing the one-resource, 0.001 HBAR-per-invocation policy.

### Important security boundary

- The browser never requests, receives, or stores a private key or seed phrase.
- Wallet connection is used for account display and network verification; this change does not submit transactions.
- The checkbox is **page-local consent UI only**. It resets on disconnect/network change and is not a server-issued authorization token.
- This UI consent is not yet wired to authorize `POST /api/agent/run`. The backend agent remains separately disabled by default and uses its configured server-side testnet signer when enabled. Keep `HEDERA_AGENT_ENABLED=false` unless deliberately running the local testnet demo.
- An EVM-compatible provider is required. Wallet behavior depends on the wallet's support for Hedera Testnet EVM chain ID 296 and `wallet_switchEthereumChain`.
- Before production use, add a server-verified, short-lived, one-time authorization grant bound to a wallet signature and payment policy; never trust a frontend checkbox as an authorization boundary.


### Phase 4 server-side authorization enforcement

The dashboard now asks the wallet to sign a server-generated, short-lived challenge using `personal_sign`. The API recovers and validates the signing address, consumes the challenge once, and issues a short-lived single-use bearer grant scoped to one agent invocation. `POST /api/agent/run` rejects calls without that grant before invoking the agent. The grant is consumed before the agent is called, including failed runs, to avoid reusing authorization.

- Challenge scope is fixed to Hedera Testnet chain ID 296, one agent run, the allowlisted paid resource, and the existing 0.001 HBAR per-payment ceiling.
- The wallet signature proves control of the wallet address; it does not expose a private key to heder1.
- The grant and challenge stores are **in-memory and single-process only**. Restarting the API invalidates outstanding grants, and multi-instance deployment must use a shared, atomic, durable store plus rate limiting.
- The backend agent remains disabled unless `HEDERA_AGENT_ENABLED=true` in local testnet development and `HEDERA_NETWORK=testnet`. A valid wallet grant does not override this switch.
- The wallet authorization layer is a local prototype. Do not expose these endpoints publicly or treat them as production-ready until persistence, origin/CSRF controls, rate limiting, and deployment-specific wallet/account mapping have been reviewed.


## Phase 5 — Verifiable audit trail (local prototype)

The API now records wallet authorization challenges and grants, authorization rejections, agent-run outcomes, payment attempts, payment rejections, and facilitator-reported settlement references in a local append-only JSONL file. Each record includes a sequence number, timestamp, event/outcome, and SHA-256 hash linked to the previous record. The API exposes `GET /api/audit/status` to validate the chain and return its record count and head hash.

- Default path: `services/api/data/audit-trail.jsonl`; override with `HEDERA_AUDIT_LOG_PATH`. The local data directory is ignored by Git.
- Settlement records include the payment proof hash, fixed amount, configured receiver, network, transaction reference, and settlement timestamp. Raw payment payloads, signatures, private keys, and seed phrases are not written to the audit trail.
- A malformed or tampered existing chain fails closed for further audit appends.
- The file is serialized within one Node.js process. It is **not multi-process/multi-host safe**, and an operator with write access can delete or replace the file. The local hash chain is tamper-evident for edits that are checked against the retained chain, but it is not an independent external anchor.
- **Hedera Consensus Service (HCS) anchoring is not enabled in this change.** To claim independent evidence, a follow-up should publish audit record hashes to a configured HCS topic using a separately controlled testnet operator, retain HCS sequence/consensus timestamps, and test verification against a Mirror Node. Do not claim HCS logging or independent anchoring until that integration is implemented and verified.
- Do not deploy this local audit store publicly as a production audit system. A durable transactional store, access controls, retention/export policy, and optional HCS anchoring require separate review.


### Phase 5 follow-up — optional HCS anchoring and Mirror Node verification

Optional Hedera Consensus Service anchoring is now implemented behind an explicit opt-in. When `HEDERA_AUDIT_HCS_ENABLED=true`, each local audit record's SHA-256 hash is submitted as a compact JSON message to the configured Hedera **Testnet** topic. The local event itself remains in the JSONL file; only its hash and minimal sequence metadata are anchored on-chain. This incurs HCS transaction fees and should use a dedicated, least-privilege testnet operator.

Required settings:
- `HEDERA_AUDIT_HCS_ENABLED=true`
- `HEDERA_AUDIT_HCS_TOPIC_ID=0.0.x` (a topic you created and control)
- `HEDERA_AUDIT_HCS_OPERATOR_ACCOUNT_ID` and `HEDERA_AUDIT_HCS_OPERATOR_PRIVATE_KEY` (dedicated testnet operator recommended; if blank, the existing x402 payer credentials are used)

The feature is disabled by default. With it disabled, normal local audit behavior remains unchanged. When enabled, each audit append attempts a separate HCS message, so authorization and payment-related events can create multiple HCS transactions. If HCS submission fails, the local record may already be persisted; treat the operation as requiring reconciliation rather than assuming no event was recorded.

To verify a published anchor independently, call:
`GET /api/audit/verify-hcs?topicId=0.0.x&sequenceNumber=123&auditHash=<64-character-record-hash>`.
The API queries the public Hedera Testnet Mirror Node and compares the decoded message with the expected audit hash. The response includes the Mirror Node URL for independent inspection. The caller must obtain the audit record hash and HCS topic sequence number from the submission response/logs or the public topic messages; do not treat a local API response alone as proof.

Automated tests cover matching and mismatching Mirror Node messages without submitting a real HCS transaction. A live end-to-end anchor has not been run by CI. Before claiming a verified live deployment, configure a testnet topic/operator, submit one harmless test anchor, and independently confirm the message on the public Mirror Node.

## Phase 6 — Live product dashboard

The dashboard now reads current state from the Fastify API rather than relying only on static UI labels.

- Live API and x402 configuration status, including configured payer/receiver account IDs where available.
- Agent enablement and spending-firewall limits, including the local ledger's single-instance limitation.
- Wallet connection, Hedera Testnet chain-ID verification, and server-verified one-time wallet authorization for an agent invocation.
- Sanitized recent audit history via `GET /api/audit/records?limit=30`. The endpoint validates the local hash chain before returning records and omits detail keys that could contain nonces, signatures, tokens, proofs, or credentials.
- HCS anchor index, public Mirror Node links, HashScan transaction links for recorded transaction references, and an interactive expected-hash verification form.
- Manual refresh and loading/error/empty states.

Run the dashboard and API together with `pnpm dev`; the dashboard is available at `http://localhost:5173`.

**Safety boundary:** agent execution remains disabled by default. If explicitly enabled for local testnet development, an authorized run may spend up to 0.001 HBAR. The local audit history and firewall ledger are not multi-instance safe. A transaction link is only shown when the backend has recorded a transaction reference; a facilitator response is not a substitute for independent transaction verification.

