# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

heder1 demonstrates a fixed-price HTTP resource protected by the x402 v2 payment flow on **Hedera testnet**. A client receives an HTTP 402 challenge, creates a payment payload using the configured payer, and retries the request. The API asks the configured facilitator to verify and settle the payment, and returns the protected resource only when settlement reports success with a transaction ID.

> **Status:** The end-to-end paid-resource demo has returned HTTP 200 with a facilitator-reported settlement transaction on Hedera testnet. Verify transaction details on HashScan for independent confirmation. Typecheck and production builds have passed locally. Automated integration tests, durable replay protection, audit persistence, and public deployment remain future work.

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

## Optional direct payment endpoint

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
- [ ] Automated unit/integration tests for challenge, invalid proofs, facilitator errors, and successful settlement
- [ ] Durable replay protection and persistent audit trail
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
