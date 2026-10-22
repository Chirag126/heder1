import { randomUUID } from "node:crypto";

export type MarketplaceCandidate = {
  serviceId: string;
  status: string;
  amountTinybars?: number;
  reason: string;
};

export type MarketplaceAgentCard = {
  agentId: string;
  name: string;
  role: "provider";
  serviceId: string;
  description: string;
  capabilities: string[];
  network: "hedera:testnet";
  asset: "0.0.0";
  identity: { status: "local-unverified"; method: "local-registry-id"; note: string };
  pricing: { mode: "fixed-x402-quote"; priceSource: "live-http-402"; negotiable: false };
};

const PROVIDERS: readonly MarketplaceAgentCard[] = Object.freeze([
  {
    agentId: "heder1:provider:full-report",
    name: "Research Provider Agent",
    role: "provider",
    serviceId: "heder1-full-report",
    description: "Produces the full demo report resource.",
    capabilities: ["full report", "detailed report", "comprehensive report", "research", "in-depth"],
    network: "hedera:testnet",
    asset: "0.0.0",
    identity: { status: "local-unverified", method: "local-registry-id", note: "Local identifier only; not an HCS-14 or ERC-8004 verified identity." },
    pricing: { mode: "fixed-x402-quote", priceSource: "live-http-402", negotiable: false },
  },
  {
    agentId: "heder1:provider:summary",
    name: "Summary Provider Agent",
    role: "provider",
    serviceId: "heder1-short-summary",
    description: "Produces the short summary resource.",
    capabilities: ["summary", "short report", "brief", "overview", "concise"],
    network: "hedera:testnet",
    asset: "0.0.0",
    identity: { status: "local-unverified", method: "local-registry-id", note: "Local identifier only; not an HCS-14 or ERC-8004 verified identity." },
    pricing: { mode: "fixed-x402-quote", priceSource: "live-http-402", negotiable: false },
  },
]);

export function getMarketplaceAgentCards(): MarketplaceAgentCard[] {
  return PROVIDERS.map((agent) => ({
    ...agent,
    capabilities: [...agent.capabilities],
    identity: { ...agent.identity },
    pricing: { ...agent.pricing },
  }));
}

function requestedCapability(goal: string): "full" | "summary" | "any" {
  const normalized = goal.toLowerCase();
  if (/\b(full|detailed|comprehensive|in.depth|research)\b/.test(normalized)) return "full";
  if (/\b(summary|summarize|brief|short|overview|concise)\b/.test(normalized)) return "summary";
  return "any";
}

/**
 * A bounded two-round negotiation envelope over live x402 quotes.
 * Providers accept, reject, or return an advisory alternative when capability
 * intent mismatches. x402 remains authoritative for the actual payable amount.
 */
export function negotiateMarketplaceOffers(input: {
  goal: string;
  budgetTinybars: number;
  offers: readonly MarketplaceCandidate[];
}) {
  const goal = input.goal.trim();
  if (!goal || goal.length > 2000) throw new Error("Goal must be between 1 and 2000 characters.");
  if (!Number.isSafeInteger(input.budgetTinybars) || input.budgetTinybars < 1 || input.budgetTinybars > 500_000) {
    throw new Error("Budget must be a safe integer between 1 and 500000 tinybars.");
  }
  const intent = requestedCapability(goal);
  const buyerAgentId = "heder1:buyer:autonomous";
  const offers = PROVIDERS.map((agent) => {
    const quote = input.offers.find((candidate) => candidate.serviceId === agent.serviceId);
    const amount = quote?.amountTinybars;
    const quoted = quote?.status === "quoted" && Number.isSafeInteger(amount) && (amount ?? 0) > 0;
    const withinBudget = quoted && (amount as number) <= input.budgetTinybars && (amount as number) <= 100_000;
    const capabilityMatch = intent === "any" ||
      (intent === "full" && agent.serviceId === "heder1-full-report") ||
      (intent === "summary" && agent.serviceId === "heder1-short-summary");

    let status: "eligible" | "rejected" = "eligible";
    let reason = "Live x402 quote is within the buyer's budget and payment ceiling.";
    if (!quoted) { status = "rejected"; reason = quote?.reason ?? "Provider did not return an eligible live x402 quote."; }
    else if (!withinBudget) { status = "rejected"; reason = "Offer exceeds the buyer's budget or per-payment hard ceiling."; }

    const negotiation = !quoted
      ? { response: "rejected" as const, reason: quote?.reason ?? "No live quote; provider declines this request.", counterOfferTinybars: null }
      : !capabilityMatch
        ? { response: "countered" as const, reason: "Provider offers its existing service at its current fixed price, but its advertised capability does not match the request; buyer may reject this alternative.", counterOfferTinybars: amount as number }
        : !withinBudget
          ? { response: "rejected" as const, reason: "Provider's live quote exceeds budget or the hard payment ceiling. No payment can be attempted.", counterOfferTinybars: null }
          : { response: "accepted" as const, reason: "Provider accepts at its current live x402 quote, subject to re-quoting and policy checks during execution.", counterOfferTinybars: null };

    return {
      agentId: agent.agentId,
      agentName: agent.name,
      serviceId: agent.serviceId,
      description: agent.description,
      capabilities: [...agent.capabilities],
      amountTinybars: quoted ? amount : null,
      amountHbar: quoted ? ((amount as number) / 100_000_000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : null,
      network: agent.network,
      asset: agent.asset,
      identityStatus: agent.identity.status,
      status,
      capabilityMatch,
      reason,
      pricing: agent.pricing,
      negotiation,
    };
  });

  const eligible = offers.filter((offer) => offer.status === "eligible" && offer.negotiation.response === "accepted");
  eligible.sort((a, b) => {
    if (intent !== "any" && a.capabilityMatch !== b.capabilityMatch) return a.capabilityMatch ? -1 : 1;
    return (a.amountTinybars ?? Number.MAX_SAFE_INTEGER) - (b.amountTinybars ?? Number.MAX_SAFE_INTEGER) || a.agentId.localeCompare(b.agentId);
  });

  const negotiationLog = [
    { round: 1, agentId: buyerAgentId, agentName: "Heder1 Buyer Agent", action: "broadcast-task", amountTinybars: null, reason: "Sent the requested task and maximum budget to each registered provider adapter." },
    ...offers.map((offer) => ({
      round: 1,
      agentId: offer.agentId,
      agentName: offer.agentName,
      action: offer.negotiation.response === "accepted" ? "accept-at-live-quote" : offer.negotiation.response === "countered" ? "counter-at-live-quote" : "reject",
      amountTinybars: offer.amountTinybars,
      reason: offer.negotiation.reason,
    })),
    ...(eligible.length ? [{
      round: 2,
      agentId: buyerAgentId,
      agentName: "Heder1 Buyer Agent",
      action: "select-offer",
      amountTinybars: eligible[0]!.amountTinybars,
      reason: intent === "any" ? "Selected the lowest-priced accepted offer within the hard ceiling." : "Selected an accepted offer whose advertised capability matches the task intent.",
    }] : [{
      round: 2,
      agentId: buyerAgentId,
      agentName: "Heder1 Buyer Agent",
      action: "no-agreement",
      amountTinybars: null,
      reason: "No provider accepted an offer within budget and declared capability requirements.",
    }]),
  ];

  const selected = eligible[0] ?? null;
  return {
    negotiationId: randomUUID(),
    protocol: "heder1-marketplace-v2-local-negotiation",
    rounds: 2,
    buyerAgent: { agentId: buyerAgentId, name: "Heder1 Buyer Agent" },
    goal,
    budgetTinybars: input.budgetTinybars,
    decision: selected ? "offer-selected" as const : "no-eligible-offer" as const,
    selected: selected ? {
      agentId: selected.agentId,
      agentName: selected.agentName,
      serviceId: selected.serviceId,
      amountTinybars: selected.amountTinybars,
      amountHbar: selected.amountHbar,
      network: selected.network,
      asset: selected.asset,
      reason: selected.capabilityMatch
        ? "Selected because its live quote fits policy and its advertised capability matches task intent."
        : "Selected as the lowest-priced accepted live quote within policy; no explicit provider capability preference was detected.",
    } : null,
    offers,
    negotiationLog,
    paymentAttempted: false as const,
    protocolNote: "This is a two-round deterministic local negotiation envelope, not full A2A/ACP conformance. Provider prices remain immutable live x402 quotes; counter-offers are advisory and cannot change the resource server's required settlement amount.",
  };
}
