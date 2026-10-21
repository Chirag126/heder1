/**
 * Phase 10 deterministic planning primitives.
 *
 * This module is intentionally side-effect free: it never fetches URLs, signs
 * payments, or holds credentials. Network discovery and payment execution must
 * call these policy functions and remain behind the existing authorization and
 * spending firewall.
 */
export type ApprovedService = {
  id: string;
  url: string;
  description: string;
  networks: readonly string[];
  assetTypes: readonly string[];
  trust: "approved" | "blocked";
  allowed: boolean;
};

export type AgentV2Limits = {
  budgetTinybars: number;
  maxPaidCalls: number;
  maxSteps: number;
  maxRuntimeMs: number;
  maxRetries: number;
  maxAttemptsPerService: number;
};

export type PaymentRequirement = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
};

export const DEFAULT_AGENT_V2_LIMITS: Readonly<AgentV2Limits> = Object.freeze({
  budgetTinybars: 500_000, // 0.005 HBAR
  maxPaidCalls: 3,
  maxSteps: 8,
  maxRuntimeMs: 45_000,
  maxRetries: 1,
  maxAttemptsPerService: 1,
});

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** URLs are checked structurally; callers must still match the full URL to a registry entry. */
export function isSafeRegisteredUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" &&
      LOCAL_HOSTS.has(url.hostname) &&
      url.port === "4000" &&
      !url.username && !url.password &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function validateAgentV2Limits(limits: AgentV2Limits): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(limits.budgetTinybars) || limits.budgetTinybars < 0) errors.push("budgetTinybars must be a non-negative safe integer.");
  for (const [key, value] of Object.entries({
    maxPaidCalls: limits.maxPaidCalls,
    maxSteps: limits.maxSteps,
    maxRetries: limits.maxRetries,
    maxAttemptsPerService: limits.maxAttemptsPerService,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) errors.push(`${key} must be a non-negative safe integer.`);
  }
  if (!Number.isSafeInteger(limits.maxRuntimeMs) || limits.maxRuntimeMs < 1 || limits.maxRuntimeMs > 120_000) {
    errors.push("maxRuntimeMs must be between 1 and 120000.");
  }
  if (limits.maxPaidCalls > 10 || limits.maxSteps > 20 || limits.maxRetries > 3 || limits.maxAttemptsPerService > 3) {
    errors.push("Requested limits exceed the hard safety ceilings.");
  }
  return errors;
}

/**
 * Parses x402 v2 challenge JSON. The returned amounts are only advertised
 * requirements, not authorization; the deterministic policy must check them.
 */
export function parseX402Requirements(body: unknown): PaymentRequirement[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  if (record.x402Version !== 2 || !Array.isArray(record.accepts)) return [];
  return record.accepts.flatMap((candidate): PaymentRequirement[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.scheme !== "string" || typeof item.network !== "string" ||
        typeof item.asset !== "string" || typeof item.amount !== "string" ||
        typeof item.payTo !== "string" || !/^\d+$/.test(item.amount)) return [];
    return [{
      scheme: item.scheme,
      network: item.network,
      asset: item.asset,
      amount: item.amount,
      payTo: item.payTo,
      ...(typeof item.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: item.maxTimeoutSeconds } : {}),
    }];
  });
}

export type EligibleCandidate = {
  service: ApprovedService;
  requirement: PaymentRequirement;
  amountTinybars: number;
};

/** The policy engine, never a model, makes the final eligibility decision. */
export function selectCheapestEligibleService(input: {
  services: readonly ApprovedService[];
  requirementsByService: ReadonlyMap<string, readonly PaymentRequirement[]>;
  budgetTinybars: number;
  allowedServiceIds?: readonly string[];
  allowedReceiverIds?: readonly string[];
  network?: string;
}): { selected: EligibleCandidate | null; eligible: EligibleCandidate[]; rejected: Array<{ serviceId: string; reason: string }> } {
  const eligible: EligibleCandidate[] = [];
  const rejected: Array<{ serviceId: string; reason: string }> = [];
  const network = input.network ?? "hedera:testnet";
  for (const service of input.services) {
    const reject = (reason: string) => rejected.push({ serviceId: service.id, reason });
    if (!service.allowed || service.trust !== "approved") { reject("Service is not approved."); continue; }
    if (input.allowedServiceIds && !input.allowedServiceIds.includes(service.id)) { reject("Service is outside the user's service allowlist."); continue; }
    if (!isSafeRegisteredUrl(service.url)) { reject("Service URL is outside the local testnet endpoint boundary."); continue; }
    if (!service.networks.includes(network)) { reject("Service does not support the required network."); continue; }
    const requirements = input.requirementsByService.get(service.id) ?? [];
    const candidates = requirements.filter((r) =>
      r.scheme === "exact" &&
      r.network === network &&
      r.asset === "0.0.0" &&
      (!input.allowedReceiverIds || input.allowedReceiverIds.includes(r.payTo)) &&
      Number.isSafeInteger(Number(r.amount)) &&
      Number(r.amount) > 0 &&
      Number(r.amount) <= input.budgetTinybars
    );
    if (!candidates.length) { reject("No advertised x402 requirement fits network, asset, receiver, and budget policy."); continue; }
    candidates.sort((a, b) => Number(a.amount) - Number(b.amount));
    const requirement = candidates[0]!;
    eligible.push({ service, requirement, amountTinybars: Number(requirement.amount) });
  }
  eligible.sort((a, b) => a.amountTinybars - b.amountTinybars || a.service.id.localeCompare(b.service.id));
  return { selected: eligible[0] ?? null, eligible, rejected };
}

export function summarizeTaskPlan(goal: string, limits: AgentV2Limits) {
  const errors = validateAgentV2Limits(limits);
  if (!goal.trim()) errors.push("Task goal is required.");
  if (goal.length > 2_000) errors.push("Task goal must be at most 2000 characters.");
  return {
    accepted: errors.length === 0,
    goal: goal.trim().slice(0, 2_000),
    strategy: "deterministic",
    limits: { ...limits },
    steps: ["discover approved registry entries", "inspect each approved service's HTTP 402 requirements", "filter by user policy and budget", "reserve selected spend", "execute bounded payment", "validate response and settlement receipt"],
    errors,
  };
}

export const agentV2Policy = Object.freeze({
  enabledByDefault: false,
  network: "hedera:testnet",
  paymentAsset: "0.0.0",
  defaultBudgetTinybars: DEFAULT_AGENT_V2_LIMITS.budgetTinybars,
  defaultBudgetHbar: "0.005",
  modelCanFetchArbitraryUrls: false,
  modelCanAuthorizePayments: false,
  note: "Discovery and ranking are advisory; deterministic policy and the spending firewall authorize every payment.",
});
