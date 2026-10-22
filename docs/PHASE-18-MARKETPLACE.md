# Phase 18 — Agent marketplace negotiation

## User jobs: intentionally separate pages

- **Agent Marketplace — discover, compare, and choose.** A buyer workflow asks registered provider adapters for live x402 quotes, compares advertised capability fit and price, shows provider acceptance/rejection/advisory counter-offers and a negotiation transcript, then hands the selected goal and single-service allowlist to the Playground.
- **Agent Playground — authorize and execute.** A direct task-running workspace with quote preview, spending policy, wallet consent/authorization, execution, and receipts. The Playground does not require a Marketplace selection to run an approved task.
- Neither page performs the other's job. Marketplace negotiation never pays; the Playground remains the only page for executing a paid task.

## Marketplace workflow implemented

- `GET /.well-known/agent-card.json`: Heder1 buyer-agent descriptor (not a claim of full A2A conformance).
- `GET /api/marketplace/agents`: two local provider adapters with distinct IDs, capabilities, service bindings, Testnet/HBAR support, and explicit local-unverified identity status.
- `POST /api/marketplace/negotiate`: discovers live quotes through the existing Phase 10 preview planner; provider adapters accept, reject or return an advisory alternative when requested task intent does not match. The buyer selects an accepted offer by task intent and price, within the declared budget and 100,000-tinybar per-payment ceiling.
- A two-round transcript is included in the response and UI: buyer request, provider responses, and buyer decision.
- `marketplace.negotiation_completed` records a sanitized summary in the existing audit trail. Existing optional HCS anchoring can anchor audit hashes when configured.
- Tests check registry, selection, provider decisions, budget rejection, transcript, and validation.

## Critical pricing boundary

The provider's x402 resource is authoritative for the payable amount. Counter-offers in this deterministic local negotiation layer are **advisory only**; they do not modify the resource server's price, and the payment runner must rediscover the live quote. A counter-offer must never be represented as a settled or discounted price. Providers are local adapters, not independent hosted agents. This bounded transcript advances Idea 2 but does not claim full standards-conformant A2A JSON-RPC or ACP.

## Hire an offer

1. In Marketplace, enter a task and maximum budget, then click **Discover & negotiate offers**.
2. Read both provider cards and the negotiation transcript. Identity remains explicitly unverified.
3. Select **Continue to task authorization** after a provider is selected.
4. In Playground, review the goal, confirm Hedera Testnet, choose preview/autonomous/approval-required policy, and ensure the allowlist is restricted to the selected provider.
5. Provide required wallet authorization or quote-specific approval and execute. The runner re-discovers the live quote and enforces the signed policy, reservation ledger, kill switch, and receipt validation; it does not trust the Marketplace result as authorization.
6. Check transaction evidence independently on HashScan Testnet. Open Audit & HCS Evidence for local hash-chain status and any public HCS anchor.

## Already implemented; reused, not duplicated

- Per-payment/task/daily caps, service allowlisting, native-HBAR/Testnet restrictions, wallet-signed one-time authorization, quote-specific approval, reservation/idempotency controls, and emergency kill switch remain in the existing payment pipeline.
- Local SHA-256 hash-chained audit records and optional HCS anchoring/verification are existing features. The UI points users to Audit & HCS Evidence instead of adding a second audit engine.
- Read-only Hedera Testnet account context exists in Phase 15. Agent Kit and hosted Network MCP were evaluated but not added as runtime dependencies.

## Remaining sponsor extras — do not claim as implemented

- **HCS-14 or ERC-8004 identity/reputation:** provider IDs remain local and unverified. No registry contract or UAID verifier is wired.
- **HTS/USDC settlement:** payment remains native HBAR (`0.0.0`) only; do not try token payment through the HBAR-only runner.
- **Recurring payments via Scheduled Transactions:** no recurring billing workflow exists.
- **Runtime Hedera Agent Kit / Network MCP:** Phase 15's Mirror Node account query is not an Agent Kit or hosted MCP runtime integration.
- **Full A2A/ACP:** this local negotiation envelope is not full protocol conformance; independent providers and standard task/message lifecycle remain future work.

These integrations need their own verified protocol contract, configuration, keys, and live end-to-end validation. This PR must not advertise them as live features.

## Safety and compatibility

- No new payment engine, signer, wallet authorization scope, spending policy, database schema, or runtime package is introduced.
- Marketplace negotiation is preview-only with `paymentAttempted: false`; selections cannot bypass wallet authorization.
- Hedera Testnet and native HBAR remain the only supported payment network/asset.
- HCS anchoring is optional and requires valid Testnet topic/operator configuration. Missing anchor evidence does not prove an anchor exists.

## Tests

```powershell
pnpm --filter @heder1/api test
pnpm typecheck
pnpm build
```

## References

- Hedera x402: https://docs.hedera.com/solutions/ai/x402
- Hedera x402 flow: https://docs.hedera.com/solutions/ai/x402/how-it-works
- A2A protocol specification: https://a2a-protocol.org/v1.0.0/specification/
- HCS-14 UAID: https://hol.org/docs/standards/hcs-14/
- ERC-8004 Trustless Agents: https://eips.ethereum.org/EIPS/eip-8004
- Heder1 Phase 10 runner: ./PHASE-10.md
- Heder1 acceptance guide: ../QualificationCheckREADME.md
