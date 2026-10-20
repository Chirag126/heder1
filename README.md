# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

> **Current status:** x402 configuration groundwork. The API can report whether payer credentials are configured and which testnet receiver account is configured. A successful paid request and on-chain settlement have **not yet been verified**. Configuration readiness is not proof of a completed payment.

## Current receiver configuration

The demo receiver is Hedera testnet account `0.0.11044329`. Override it locally with `HEDERA_RECEIVER_ACCOUNT_ID` if needed. The receiver account ID is public; its private key is not needed by this API for receiving payments.

This configuration change does not execute payments. The protected-resource handshake and facilitator-backed settlement still need to be implemented and verified before `readyForPaymentTest` can be considered true.

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

For local API configuration, copy `services/api/.env.example` to `services/api/.env` and set your **Hedera testnet ECDSA payer account**:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_CLIENT_ACCOUNT_ID=0.0.YOUR_TESTNET_PAYER_ACCOUNT
HEDERA_CLIENT_PRIVATE_KEY=YOUR_TESTNET_ECDSA_PRIVATE_KEY
HEDERA_RECEIVER_ACCOUNT_ID=0.0.11044329
```

Create/fund testnet accounts through https://portal.hedera.com/. Never commit `.env` files, private keys, seed phrases, or funded-wallet credentials. Do not use mainnet keys. The status route does not initiate a payment.

Run both apps:

```bash
pnpm dev
```

- Web dashboard: http://localhost:5173
- API health: http://localhost:4000/api/health
- x402 configuration status: http://localhost:4000/api/x402/status

Validate locally:

```bash
pnpm typecheck
pnpm build
```

## Planned payment architecture

1. The dashboard displays agent activity, budgets, decisions, and transaction evidence.
2. The agent discovers priced services and requests resources through x402.
3. A policy engine rejects disallowed providers or over-budget requests before payment authorization.
4. A merchant endpoint returns HTTP 402 payment requirements using the configured receiver account and serves the protected resource after valid settlement.
5. A compatible facilitator verifies and settles payment on Hedera testnet.
6. The API records transaction ID and on-chain evidence; HCS logging is planned for a later phase.

The Hedera exact scheme supports HBAR using asset ID `0.0.0` (amounts in tinybars) and compatible HTS fungible tokens. A facilitator compatible with `hedera:testnet` is required to sponsor network fees and settle the transaction. See the official x402 specification and package docs before enabling real settlement.

## Official references

- [Hedera x402 overview](https://docs.hedera.com/solutions/ai/x402)
- [How x402 works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Pay with x402](https://docs.hedera.com/solutions/ai/x402/pay-with-x402)
- [Merchant integration](https://docs.hedera.com/solutions/ai/x402/merchant-integration)
- [Facilitators](https://docs.hedera.com/solutions/ai/x402/facilitators)
- [Hedera x402 TypeScript package](https://www.npmjs.com/package/@x402/hedera)
- [Exact Hedera scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)

## Development status

- [x] Repository foundation, dashboard shell, and Fastify health endpoint
- [x] x402 SDK dependencies and testnet payer configuration-status endpoint
- [x] Explicit receiver account configuration for Hedera testnet
- [ ] Verified paid-resource handshake and testnet settlement
- [ ] Spending-policy enforcement
- [ ] HCS audit topic
- [ ] Automated integration tests
- [ ] Public deployment
- [ ] Verified transaction ID and HashScan link
- [ ] Demo video (5 minutes or less)

## License

To be selected before public release.
