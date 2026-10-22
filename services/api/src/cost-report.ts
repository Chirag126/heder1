/**
 * Phase 16: explicit, conservative cost breakdowns for the current deterministic
 * Heder1 agent. This module never executes a payment or calls an LLM.
 */
import { getApprovedServiceRegistry } from "./agent-v2.js";

const TINYBARS_PER_HBAR = 100_000_000n;
const DEFAULT_DAILY_TASK_QUOTA = 10;

function toHbar(tinybars: bigint): string {
  const whole = tinybars / TINYBARS_PER_HBAR;
  const fraction = (tinybars % TINYBARS_PER_HBAR).toString().padStart(8, "0");
  return `${whole}.${fraction}`.replace(/0+$/, "").replace(/\.$/, "");
}

export function dailyTaskQuota(): number {
  const raw = process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY;
  if (!raw) return DEFAULT_DAILY_TASK_QUOTA;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY must be an integer from 1 to 100.");
  }
  return parsed;
}

export function getPublicPricing() {
  return {
    currency: "HBAR for on-network resource payments; USD only when a separately configured provider supplies a price",
    plans: {
      preview: { price: "Free", usage: "Quote discovery and policy simulation; does not sign or settle payments." },
      selfHosted: { price: "Free software", usage: "You pay your own hosting, model provider if added, and any resource payments." },
      hostedReadOnly: { price: "Free for read-only dashboard access", usage: "Read-only views and account context; subject to API rate limits and hosting availability." },
      hostedAgent: { price: "Not offered in this release", usage: "A paid hosted tier will be considered after real infrastructure costs and abuse patterns are measured." },
    },
    currentAgent: {
      model: "deterministic; no LLM inference is called",
      heder1ServiceFeeTinybars: "0",
      hostedUsageCharge: "0",
      network: "hedera:testnet",
      mainnetPaymentExecutionEnabled: false,
    },
    important: [
      "Provider resource price is separate from Heder1 service fees.",
      "For the Hedera x402 exact flow, the facilitator sponsors the settlement network fee; this does not pay the resource price or hosting/model costs.",
      "Hosting and infrastructure costs are not currently allocated per task and are not represented as zero-dollar costs.",
      "The actual HTTP 402 quote is authoritative; registry price hints are estimates only.",
    ],
  };
}

export type CostEstimate = {
  serviceId: string;
  estimateOnly: true;
  resourcePayment: {
    source: "informational-hint-only";
    amountTinybarsPerCall: string;
    amountHbarPerCall: string;
    maxPaidCalls: number;
    maximumResourcePaymentTinybars: string;
    maximumResourcePaymentHbar: string;
    authoritativeQuoteRequired: true;
  };
  heder1ServiceFee: { amountTinybars: "0"; amountHbar: "0"; status: "no fee configured" };
  hederaNetworkFee: { userPayableTinybars: "0"; paidBy: "x402 facilitator"; status: "sponsored for supported x402 settlement only" };
  modelInference: { estimatedUsd: "0"; calls: 0; reason: string };
  hostingInfrastructure: { allocatedUsd: null; status: string };
  maximumKnownUserCost: { amountTinybars: string; amountHbar: string };
};

export function estimateTaskCost(serviceId: string, maxPaidCalls = 1): CostEstimate {
  if (!Number.isSafeInteger(maxPaidCalls) || maxPaidCalls < 1 || maxPaidCalls > 3) {
    throw new Error("maxPaidCalls must be an integer from 1 to 3.");
  }
  const service = getApprovedServiceRegistry().find((candidate) => candidate.id === serviceId && candidate.allowed && candidate.trust === "approved");
  if (!service?.priceMetadata || service.priceMetadata.asset !== "HBAR") {
    throw new Error("No estimate is available for that approved service.");
  }
  const perCall = BigInt(service.priceMetadata.amountTinybars);
  const maximum = perCall * BigInt(maxPaidCalls);
  return {
    serviceId,
    estimateOnly: true,
    resourcePayment: {
      source: "informational-hint-only",
      amountTinybarsPerCall: perCall.toString(),
      amountHbarPerCall: toHbar(perCall),
      maxPaidCalls,
      maximumResourcePaymentTinybars: maximum.toString(),
      maximumResourcePaymentHbar: toHbar(maximum),
      authoritativeQuoteRequired: true,
    },
    heder1ServiceFee: { amountTinybars: "0", amountHbar: "0", status: "no fee configured" },
    hederaNetworkFee: { userPayableTinybars: "0", paidBy: "x402 facilitator", status: "sponsored for supported x402 settlement only" },
    modelInference: { estimatedUsd: "0", calls: 0, reason: "The current task runner is deterministic and does not call an LLM." },
    hostingInfrastructure: { allocatedUsd: null, status: "Not allocated per task; hosting is not free." },
    maximumKnownUserCost: { amountTinybars: maximum.toString(), amountHbar: toHbar(maximum) },
  };
}

export function reportActualTaskCost(receipts: ReadonlyArray<{ amountTinybars: string; serviceId: string; transactionId: string }>) {
  let total = 0n;
  const items = receipts.map((receipt) => {
    if (!/^\d+$/.test(receipt.amountTinybars)) throw new Error("Receipt amountTinybars must be a non-negative integer.");
    const amount = BigInt(receipt.amountTinybars);
    total += amount;
    return {
      serviceId: receipt.serviceId,
      amountTinybars: amount.toString(),
      amountHbar: toHbar(amount),
      transactionId: receipt.transactionId,
      status: "settled" as const,
    };
  });
  return {
    source: "settlement receipts",
    items,
    resourcePayment: { amountTinybars: total.toString(), amountHbar: toHbar(total) },
    heder1ServiceFee: { amountTinybars: "0", amountHbar: "0", status: "no fee configured" },
    hederaNetworkFee: { userPayableTinybars: "0", paidBy: "x402 facilitator", status: "sponsored for supported x402 settlement only" },
    modelInference: { actualUsd: "0", calls: 0, reason: "No LLM inference was called by this task." },
    hostingInfrastructure: { allocatedUsd: null, status: "Not allocated per task; hosting is not free." },
    knownUserCost: { amountTinybars: total.toString(), amountHbar: toHbar(total) },
    unknownOrUnallocatedCosts: ["hosting", "database", "monitoring", "future model inference if enabled"],
  };
}
