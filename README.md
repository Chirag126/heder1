# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

> **Current status:** x402 testnet payment-attempt groundwork. The API can build a fixed-size HBAR payment payload, ask a compatible facilitator to verify and settle it, and return the facilitator transaction ID when settlement succeeds. A successful live settlement has not yet been verified. This is not yet a complete merchant HTTP 402 challenge/retry integration.

## Receiver and payment safety

The demo receiver is Hedera testnet account `0.0.11044329`. Override it locally with `HEDERA_RECEIVER_ACCOUNT_ID` if needed. The receiver account ID is public; its private key is not needed by this API for receiving payments.

The demo payment endpoint can send **0.001 HBAR** from the configured payer. It is disabled by default, refuses production mode, and requires an explicit JSON confirmation. Keep the API bound to localhost while testing; do not expose this endpoint publicly. Do not enable this feature in production.

## Stack

- TypeScript, React + Vite, Node.js + Fastify, pnpm workspace
- `@x402/core`, `@x402/fetch`, `@x402/hedera`
- Hedera testnet for development

## Prerequisites

- Node.js 24
- Git and pnpm 10
- VS Code

## Local setup

```bash
git clone https://github.com/Chirag126/heder1.git
cd heder1
npm install --global pnpm@10
pnpm install
```

Copy `services/api/.env.example` to `services/api/.env` and set your **Hedera testnet ECDSA payer account** locally:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_CLIENT_ACCOUNT_ID=0.0.YOUR_TESTNET_PAYER_ACCOUNT
HEDERA_CLIENT_PRIVATE_KEY=YOUR_TESTNET_ECDSA_PRIVATE_KEY
HEDERA_RECEIVER_ACCOUNT_ID=0.0.11044329
HEDERA_X402_FACILITATOR_URL=https://api.testnet.blocky402.com
HEDERA_X402_DEMO_ENABLED=false
```

Create/fund testnet accounts through https://portal.hedera.com/. Never commit `.env` files, private keys, seed phrases, or funded-wallet credentials. Do not use mainnet keys.

Run both apps:

```bash
pnpm dev
```

- Web dashboard: http://localhost:5173
- API health: http://localhost:4000/api/health
- x402 configuration status: http://localhost:4000/api/x402/status

## Explicit testnet payment attempt

First verify the facilitator advertises the exact Hedera testnet scheme by checking `HEDERA_X402_FACILITATOR_URL/supported`. Keep `HEDERA_X402_DEMO_ENABLED=false` until you intentionally want to attempt a testnet transfer.

For a local test only, set `HEDERA_X402_DEMO_ENABLED=true` in `services/api/.env`, keep the API on localhost, and restart it. Then send this explicit request:

```bash
curl -X POST http://localhost:4000/api/x402/demo-payment ^
  -H "Content-Type: application/json" ^
  -d "{\"confirmPayment\":true}"
```

This endpoint is a direct facilitator-backed payment attempt, not the full merchant 402 challenge/retry flow. It is fixed at 100,000 tinybars (0.001 HBAR) and does not accept a caller-supplied amount or destination. A successful response must include the facilitator's transaction ID; verify it on [HashScan Testnet](https://hashscan.io/testnet). If the facilitator is unavailable or does not advertise `hedera:testnet`, the endpoint fails closed.

After the test, set `HEDERA_X402_DEMO_ENABLED=false` again.

Validate locally:

```bash
pnpm typecheck
pnpm build
```

## Remaining work

1. Implement a proper merchant endpoint that returns HTTP 402 payment requirements and serves the resource only after verification/settlement.
2. Add a client-side automatic 402 retry with the x402 fetch client.
3. Add spending-policy enforcement before any payment.
4. Add automated tests, HCS audit records, deployment, and a demo.

## Official references

- [Hedera x402 overview](https://docs.hedera.com/solutions/ai/x402)
- [How x402 works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Hedera x402 TypeScript package](https://www.npmjs.com/package/@x402/hedera)
- [Blocky402 x402 v2 quickstart and facilitator API](https://blocky402.com/docs/quickstart/)
- [Exact Hedera scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)

## Development status

- [x] Repository foundation, dashboard shell, and Fastify health endpoint
- [x] x402 SDK dependencies and testnet payer configuration-status endpoint
- [x] Explicit receiver account configuration for Hedera testnet
- [x] Opt-in, fixed-amount facilitator-backed testnet payment attempt
- [ ] Live settlement verified with transaction ID and HashScan
- [ ] Complete HTTP 402 merchant handshake and client retry
- [ ] Spending-policy enforcement
- [ ] HCS audit topic
- [ ] Automated integration tests
- [ ] Public deployment
- [ ] Demo video (5 minutes or less)

## License

To be selected before public release.
