# Phase 17 — Production hardening and deployment reliability

## Scope
Improve operational safety without rebuilding the existing x402 engine, wallet authorization, spending firewall, rate limiter, PostgreSQL reservation model, recovery sweep, or HCS integration. Demo-video and submission-documentation work is excluded.

## Implemented
- API security response headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, and `Cross-Origin-Resource-Policy: same-site`.
- `GET /api/health/ready` distinguishes readiness from process liveness. In production it requires PostgreSQL configuration, migrations, and a successful `SELECT 1`; failures return HTTP 503 with a sanitized message.
- Existing `GET /api/health` remains lightweight and does not claim that payment dependencies are ready.
- Fastify injection tests cover response headers, untrusted-origin rejection, preflight rejection, and development readiness.
- Deployment checklist covers secret hygiene, database backup/restore, and Testnet failure-path acceptance.

## Existing controls retained
- Exact-origin CORS allowlist through `HEDERA_CORS_ORIGINS`; arbitrary origins are not reflected and credentialed CORS is not enabled.
- Shared PostgreSQL rate limits when `DATABASE_URL` is configured; shared limiter failures fail closed.
- Short-lived, single-use wallet authorization, server-side spending policy, task idempotency, durable reservations, and conservative stale-payment recovery.
- Structured API logging redacts sensitive authorization and payment headers.

## Known limitations
- The hash-chained JSONL audit trail remains the local authoritative chain. PostgreSQL stores an audit metadata mirror, not an atomic distributed replacement. Multi-instance-safe canonical audit sequencing and recovery are **not completed** in this phase.
- In-memory rate limiting is development-only; public/multi-instance deployments require PostgreSQL.
- Readiness checks PostgreSQL, not external facilitator or Mirror Node availability.
- Passing tests and health checks do not constitute a penetration test or production certification.

## Validate locally
```powershell
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

## Deployment acceptance checklist
1. Configure `NODE_ENV=production` and `DATABASE_URL` in hosting-platform secret settings; never put credentials in frontend variables or commit them.
2. Confirm `/api/health` reports liveness and `/api/health/ready` returns HTTP 200 only after database migrations and connectivity succeed.
3. In staging, test an unavailable database and verify readiness returns 503 without leaking connection details.
4. Send an untrusted `Origin` and verify HTTP 403; configure only exact frontend origins in `HEDERA_CORS_ORIGINS`.
5. Exercise duplicate task IDs, facilitator timeout/unknown settlement, cancellation after submission, API restart, and stale-reservation recovery on Testnet with tiny limits.
6. Back up PostgreSQL and restore into a disposable database; verify migrations, task/reservation records, and rate limiting.
7. Confirm logs and error responses contain no private keys, signatures, bearer tokens, payment proofs, or provider credentials.
8. Keep payment execution disabled on public deployments until separately reviewed.

## Hedera and x402 compatibility
No changes are made to Hedera transaction construction, x402 scheme negotiation, facilitator settlement, tinybar accounting, or Hedera Agent Kit dependencies. The agent remains deterministic; no new model or API-key surface is introduced.

Official references:
- [Hedera x402 documentation](https://docs.hedera.com/solutions/ai/x402)
- [Hedera x402 how it works](https://docs.hedera.com/solutions/ai/x402/how-it-works)
- [Exact Hedera x402 scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [Hedera Mirror Node REST API](https://docs.hedera.com/hedera/sdks-and-apis/rest-api)
- [Hedera Agent Kit repository](https://github.com/hashgraph/hedera-agent-kit-js)
