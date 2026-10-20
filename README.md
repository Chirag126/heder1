# heder1

**Security-first autonomous AI-agent payments on Hedera using x402.**

heder1 aims to let an agent discover a priced service, evaluate the request against an explicit spending policy, and complete an x402 payment on Hedera. The goal is to make autonomous payments useful without giving the agent unrestricted spending authority.

> **Current status:** foundation scaffold. The health endpoint and dashboard shell are implemented; x402 settlement, policy enforcement, HCS audit logging, and production deployment are not implemented yet. Do not interpret the UI as evidence of a completed payment.

## Planned acceptance criteria

- An x402-protected endpoint settles on Hedera testnet through a facilitator supported by the official Hedera documentation.
- An agent/client discovers the endpoint and completes at least one paid request end to end without a human approving the payment.
- A spending policy checks total budget, per-provider limits, and allowlists before payment.
- A public repository documents setup, architecture, and the payment flow.
- The README includes a verified Hedera transaction ID and HashScan URL once a real testnet payment succeeds.
- A demo video of five minutes or less shows the payment settling and opens its HashScan evidence.

## Stack

- TypeScript
- React + Vite
- Node.js + Fastify
- pnpm workspace
- Hedera x402 (integration phase)
- Hedera Consensus Service audit trail (planned)

## Prerequisites

- Node.js 24 LTS
- Git
- pnpm 10
- VS Code

## Local setup

Clone the repository and check out the working branch:

```bash
git clone https://github.com/Chirag126/heder1.git
cd heder1
git switch chore/phase-0-foundation
npm install --global pnpm@10
pnpm install
```

Run the web app and API together:

```bash
pnpm dev
```

- Web dashboard: http://localhost:5173
- API health: http://localhost:4000/api/health

Build and type-check:

```bash
pnpm typecheck
pnpm build
```

## Environment variables and secrets

Copy `.env.example` to a local `.env` when the payment integration phase needs credentials. Never commit `.env`, private keys, seed phrases, or funded-wallet credentials. The current foundation scaffold does not require a secret or execute payments.

## Architecture (planned)

1. **Web dashboard** displays agent activity, budgets, decisions, and transaction evidence.
2. **Agent client** discovers priced services and requests a resource through x402.
3. **Policy engine** rejects disallowed providers or requests that exceed spending limits before a payment is attempted.
4. **Merchant endpoint** returns HTTP 402 payment requirements and serves the protected resource after valid settlement.
5. **Hedera settlement** uses a supported x402 facilitator and Hedera testnet.
6. **Audit service** records payment and policy-decision evidence, with HCS planned as a tamper-evident event log.

## Official references

- [Hedera x402 overview](https://docs.hedera.com/solutions/ai/x402)
- [How x402 works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Pay with x402](https://docs.hedera.com/solutions/ai/x402/pay-with-x402)
- [Merchant integration](https://docs.hedera.com/solutions/ai/x402/merchant-integration)
- [Facilitators](https://docs.hedera.com/solutions/ai/x402/facilitators)
- [Hedera Agent Kit](https://docs.hedera.com/solutions/ai/agent-kit)

## Development status

- [x] Repository foundation and safe Git defaults
- [x] React dashboard shell
- [x] Fastify health endpoint
- [ ] Verified Hedera x402 payment
- [ ] Spending-policy enforcement
- [ ] HCS audit topic
- [ ] Automated integration tests
- [ ] Public deployment
- [ ] Verified transaction ID and HashScan link
- [ ] Demo video (5 minutes or less)

## License

To be selected before public release.
