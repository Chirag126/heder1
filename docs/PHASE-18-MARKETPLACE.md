# Phase 18 — Agent marketplace negotiation

## Goal

Add a safe marketplace layer on top of the existing Phase 10 x402 quote discovery and payment runner. A buyer agent discovers provider-agent cards, evaluates their live HTTP 402 quotes, chooses a provider based on task intent and budget, and can then hire that provider through the existing wallet-authorized runner.

## What is implemented

- `GET /.well-known/agent-card.json`: a discovery descriptor for the Heder1 buyer agent.
- `GET /api/marketplace/agents`: two local provider-agent cards, each with a distinct ID, capabilities, service binding, network/asset support, and explicit local-unverified identity status.
- Dashboard **Agent Marketplace** page: submit a goal and budget, compare discovered provider offers, inspect each offer's capability and identity status, and move the selected provider into the existing Agent Playground. The UI never pays directly from the negotiation button.
- `POST /api/marketplace/negotiate`: discovers the live x402 quotes through the existing preview planner, filters them against the buyer's budget and existing 100,000-tinybar per-payment ceiling, evaluates task intent, and returns a deterministic offer decision.
- Audit event `marketplace.negotiation_completed` records only the negotiation summary, not secrets or payment proofs.
- Unit tests cover provider identities, price selection, capability preference, budget rejection, and invalid input.
- The negotiation endpoint never signs, reserves, or submits a payment. It is safe to call as a preview.

## Run locally

Keep Heder1 bound to `127.0.0.1` and on Hedera Testnet. Start the API, then:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/.well-known/agent-card.json
Invoke-RestMethod http://127.0.0.1:4000/api/marketplace/agents

$body = @{
  goal = "Create a detailed full report"
  budgetTinybars = 100000
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/marketplace/negotiate -ContentType "application/json" -Body $body
```

The full-report provider should win when its live quote is within budget and the goal clearly requests a detailed/full report. A generic report goal selects the cheapest eligible quote. If the budget is below every live quote, no offer is selected.

## Hire the selected provider

Negotiation is intentionally separate from payment. To hire the returned `selected.serviceId`:

1. Use the existing dashboard wallet authorization flow with the current spending policy. Keep the policy in autonomous mode only if you intend to pay without quote-specific approval.
2. Generate a fresh UUID and send `POST /api/agent/v2/run` with that `runId`, the same `goal`, a budget within the signed task budget, and `allowedServiceIds: [selected.serviceId]`.
3. Send the fresh `x-heder1-authorization` grant in the header.
4. The existing runner re-discovers the live HTTP 402 quote and re-applies the signed network, asset, receiver, per-payment cap, task budget, spending ledger, kill switch, and settlement validation. It does not trust the negotiation result as payment authorization.
5. Verify the returned transaction independently on HashScan Testnet and verify the audit record as described in `QualificationCheckREADME.md`.

Do not retry an uncertain payment until HashScan/Mirror Node and the reservation state have been checked.

## Boundaries and remaining work

This is an additive deterministic local marketplace slice, not a claim that Heder1 is now a full A2A or ACP implementation. Provider adapters are local modules rather than independently hosted agent processes. Provider prices are immutable live x402 quotes; negotiation chooses among offers and does not modify the amount that the resource server requires. The card IDs are local identifiers, not HCS-14 or ERC-8004 verifiable identities.

The following sponsor extras remain **not implemented** and must not be claimed in a submission:
- HCS-14 / ERC-8004 identity and reputation registry.
- HTS token / USDC settlement. Current runner is HBAR-only (`0.0.0`).
- Hedera Scheduled Transactions recurring payments.
- Runtime Hedera Agent Kit or hosted Network MCP integration.
- Full standards-conformant A2A JSON-RPC task lifecycle or ACP negotiation.
- Independent third-party provider deployments.

These are intentionally deferred instead of being represented by mock integrations or untested payment paths. Each requires a separate, integration-specific implementation and tests.

## Safety and compatibility

- No existing x402 route, payment engine, wallet authorization scope, spending policy, database schema, HCS audit code, or package dependency is changed.
- The new negotiation endpoint only calls the existing preview planner; it never creates a signer or makes a payment.
- The paid hiring step uses the existing runner, not a new payment implementation.
- Network is fixed to Hedera Testnet; native HBAR is the only asset offered.
- This implementation does not make the project production-ready.

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
- Heder1 Phase 10 runner: ./PHASE-10.md
- Heder1 acceptance guide: ../QualificationCheckREADME.md
