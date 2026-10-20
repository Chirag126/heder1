# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

> **Current status:** Phase 1 integration groundwork. The dashboard and API are implemented, the API can report whether testnet client credentials are configured, and the Hedera x402 SDK is wired into the API package. A successful paid request and on-chain settlement have **not yet been verified**. Configuration readiness is not proof of a completed payment.

## Phase 1 scope

- Add the official TypeScript x402 core, fetch, and Hedera packages.
- Configure a Hedera testnet x402 client from server-side environment variables.
- Expose `GET /api/x402/status` to check whether testnet credentials are configured without revealing the private key.
- Keep actual payment execution disabled until the protected-resource handshake and settlement are implemented and verified.

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

For local API configuration, create `services/api/.env` and add a **Hedera testnet ECDSA account**:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_CLIENT_ACCOUNT_ID=0.0.YOUR_TESTNET_ACCOUNT
HEDERA_CLIENT_PRIVATE_KEY=0xYOUR_TESTNET_ECDSA_PRIVATE_KEY
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

## Planned architecture

1. The dashboard displays agent activity, budgets, decisions, and transaction evidence.
2. The agent discovers priced services and requests resources through x402.
3. A policy engine rejects disallowed providers or over-budget requests before payment authorization.
4. A merchant endpoint returns HTTP 402 payment requirements and serves the protected resource after valid settlement.
5. A supported facilitator settles payment on Hedera testnet.
6. An audit service records payment and policy evidence; HCS logging is planned for a later phase.

## Official references

- [Hedera x402 overview](https://docs.hedera.com/solutions/ai/x402)
- [How x402 works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Pay with x402](https://docs.hedera.com/solutions/ai/x402/pay-with-x402)
- [Merchant integration](https://docs.hedera.com/solutions/ai/x402/merchant-integration)
- [Facilitators](https://docs.hedera.com/solutions/ai/x402/facilitators)
- [Hedera x402 TypeScript package](https://www.npmjs.com/package/@x402/hedera)

## Development status

- [x] Repository foundation, dashboard shell, and Fastify health endpoint
- [x] x402 SDK dependencies and testnet configuration-status endpoint
- [ ] Verified paid-resource handshake and testnet settlement
- [ ] Spending-policy enforcement
- [ ] HCS audit topic
- [ ] Automated integration tests
- [ ] Public deployment
- [ ] Verified transaction ID and HashScan link
- [ ] Demo video (5 minutes or less)

## License

To be selected before public release.
