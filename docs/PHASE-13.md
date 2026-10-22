# Phase 13 — Mainnet readiness and user-controlled network modes

## Scope and safety boundary

Phase 13 adds explicit network-mode reporting and a fail-closed, read-only mainnet readiness review. Hedera Testnet remains the only enabled payment network. **No mainnet payment execution route is enabled or implemented by this phase.** The readiness acknowledgement is not a transaction signature and cannot authorize a payment.

This follows the x402 Hedera exact-scheme rules: network identifiers are exactly `hedera:testnet` and `hedera:mainnet`; HBAR is asset `0.0.0` with 8 decimals and amounts in tinybars; HTS fungible-token amounts are expressed in the token's smallest unit and decimals must match token metadata. See the official [x402 Hedera exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md).

## What changed

- `GET /api/networks` explicitly reports `hedera:testnet` as the only enabled payment network and reports mainnet payment execution as `false`.
- `POST /api/mainnet/readiness/check` performs read-only validation of explicit opt-in, exact network and scheme, asset ID, decimals, amount, maximum exposure, payer, destination, facilitator support, Mirror Node token metadata, payer balance, and destination account existence.
- `POST /api/mainnet/readiness/challenge` repeats the live checks and creates a short-lived wallet-signing challenge bound to the exact quote and exposure.
- `POST /api/mainnet/readiness/verify` verifies the wallet signature and issues a separate single-use readiness grant with the scope `heder1:mainnet-readiness:quote-only`.
- `POST /api/mainnet/readiness/consume` consumes only that readiness grant. It does not sign, submit, or authorize a transaction.
- Readiness checks and grant lifecycle events write sanitized audit metadata. Grant tokens and signatures are not written to audit details.
- New unit tests cover testnet/mainnet mismatch, explicit opt-in, HBAR decimals, exposure caps, facilitator network support, HTS token decimals, and current payer balance.
- Existing testnet payment routes, user policies, and quote approvals remain testnet-only.

## Environment configuration

Mainnet readiness is disabled by default. To enable **read-only checks only**, configure these API-side environment variables in a controlled development/staging environment:

- `HEDERA_MAINNET_READINESS_ENABLED=true` — enables readiness endpoints only. It does not enable payment execution.
- `HEDERA_MAINNET_FACILITATOR_URL` — HTTPS URL of the selected facilitator; the service queries its `/supported` endpoint.
- `HEDERA_MAINNET_MIRROR_NODE_URL` — optional HTTPS Mirror Node base URL; defaults to `https://mainnet.mirrornode.hedera.com`.
- `HEDERA_MAINNET_MAX_EXPOSURE_BASE_UNITS` — hard ceiling in the selected asset's smallest units; defaults to `1000000`. Configure this deliberately for the asset being reviewed because the meaning of base units differs between HBAR and HTS tokens.

Do not add private keys to browser variables, `VITE_*` variables, source files, or Git. The readiness flow does not require or read a mainnet private key. Mainnet payment credentials, if introduced in a later phase, must be stored only in a server-side secret manager with minimal permissions and must use a dedicated payer.

## API request example

```json
{
  "account": "0x0000000000000000000000000000000000000001",
  "explicitOptIn": true,
  "network": "hedera:mainnet",
  "scheme": "exact",
  "asset": "0.0.0",
  "assetDecimals": 8,
  "amount": "50000",
  "maximumExposure": "100000",
  "payerAccountId": "0.0.1001",
  "destinationAccountId": "0.0.1002"
}
```

The amount and maximum exposure are strings in the asset's smallest unit. This example is illustrative; the account IDs are not asserted to exist. The API performs live Mirror Node checks and will reject nonexistent accounts or insufficient balances.

## Important limitations

- The mainnet readiness toggle is an API-side opt-in, not a frontend-only dropdown.
- Facilitator `/supported` verifies advertised network/scheme support. It does not necessarily enumerate every supported asset; the exact live x402 quote must be checked again before any future payment execution.
- Mirror Node balance checks are point-in-time checks and can become stale immediately. They are not a reservation and cannot prevent concurrent external spending.
- The EVM wallet signature acknowledges a quote-specific readiness review only. It is not a Hedera transaction signature or proof that the payer controls the Hedera account.
- No actual mainnet transaction is attempted in this phase. Do not treat a successful readiness acknowledgement as approval for real payments.

## Validation

Run from the repository root:

```powershell
pnpm install
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

The test suite uses mocked facilitator and Mirror Node responses; it does not spend funds or prove that a real facilitator will settle a mainnet payment. Before any future mainnet execution phase, run the complete testnet flow, review the selected facilitator and asset, validate dedicated credentials and caps, configure alerting and emergency disablement, rehearse reconciliation, and perform an independent operational review. A deliberately tiny mainnet transaction must be a separately approved later step, not part of Phase 13.
