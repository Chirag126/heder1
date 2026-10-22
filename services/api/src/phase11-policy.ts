export type AgentMode = "preview" | "autonomous" | "approval-required";

export type UserSpendingPolicy = {
  mode: AgentMode;
  network: "hedera:testnet";
  maxPaymentTinybars: number;
  taskBudgetTinybars: number;
  dailyBudgetTinybars: number;
  maxPaidCallsPerTask: number;
  maxPaidCallsPerDay: number;
  allowedServiceIds: string[];
  allowedAssets: string[];
  expiresAt: number;
  approvalThresholdTinybars: number;
};

export type PolicyQuote = {
  serviceId: string;
  network: string;
  asset: string;
  amountTinybars: number;
  taskSpentTinybars?: number;
  dailyReservedTinybars?: number;
  paidCallsThisTask?: number;
  paidCallsToday?: number;
  now?: number;
};

export const DEFAULT_USER_SPENDING_POLICY: Readonly<UserSpendingPolicy> = Object.freeze({
  mode: "autonomous",
  network: "hedera:testnet",
  maxPaymentTinybars: 100_000,
  taskBudgetTinybars: 500_000,
  dailyBudgetTinybars: 1_000_000,
  maxPaidCallsPerTask: 1,
  maxPaidCallsPerDay: 10,
  allowedServiceIds: ["heder1-full-report", "heder1-short-summary"],
  allowedAssets: ["0.0.0"],
  expiresAt: 0,
  approvalThresholdTinybars: 50_000,
});

export function validateUserSpendingPolicy(policy: UserSpendingPolicy): string[] {
  const errors: string[] = [];
  if (!["preview", "autonomous", "approval-required"].includes(policy.mode)) errors.push("Unknown agent mode.");
  if (policy.network !== "hedera:testnet") errors.push("Only Hedera Testnet is enabled; mainnet is not supported.");
  const bounds: Array<[keyof UserSpendingPolicy, number, number]> = [
    ["maxPaymentTinybars", 1, 100_000],
    ["taskBudgetTinybars", 1, 500_000],
    ["dailyBudgetTinybars", 1, 1_000_000],
    ["maxPaidCallsPerTask", 1, 3],
    ["maxPaidCallsPerDay", 1, 10],
    ["approvalThresholdTinybars", 0, 100_000],
  ];
  for (const [key, min, max] of bounds) {
    const value = policy[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      errors.push(`${key} must be a safe integer between ${min} and ${max}.`);
    }
  }
  if (!Array.isArray(policy.allowedServiceIds) || policy.allowedServiceIds.length === 0 ||
      policy.allowedServiceIds.some((id) => !["heder1-full-report", "heder1-short-summary"].includes(id)) ||
      new Set(policy.allowedServiceIds).size !== policy.allowedServiceIds.length) {
    errors.push("Service allowlist must contain unique IDs from the approved registry.");
  }
  if (!Array.isArray(policy.allowedAssets) || policy.allowedAssets.length !== 1 || policy.allowedAssets[0] !== "0.0.0") {
    errors.push("Only native HBAR asset 0.0.0 is currently supported.");
  }
  if (typeof policy.expiresAt !== "number" || !Number.isSafeInteger(policy.expiresAt)) errors.push("expiresAt must be a Unix timestamp in milliseconds.");
  return errors;
}

export function simulateSpendingPolicy(policy: UserSpendingPolicy, quote: PolicyQuote, killSwitch = false) {
  const errors = validateUserSpendingPolicy(policy);
  const reject = (reason: string) => ({ allowed: false, requiresApproval: false, reason, mode: policy.mode });
  if (errors.length) return reject(errors.join(" "));
  const now = quote.now ?? Date.now();
  if (killSwitch || process.env.HEDERA_AGENT_KILL_SWITCH === "true") return reject("Emergency kill switch is enabled; agent payments are stopped.");
  if (policy.expiresAt <= now) return reject("Authorization or policy has expired.");
  if (quote.network !== policy.network) return reject("Quote network is outside the signed policy.");
  if (!policy.allowedServiceIds.includes(quote.serviceId)) return reject("Service is outside the user's allowlist.");
  if (!policy.allowedAssets.includes(quote.asset)) return reject("Asset is outside the user's asset allowlist.");
  if (!Number.isSafeInteger(quote.amountTinybars) || quote.amountTinybars <= 0) return reject("Quote amount must be a positive safe integer.");
  if (quote.amountTinybars > policy.maxPaymentTinybars) return reject("Quote exceeds the user's maximum per-payment cap.");
  if ((quote.taskSpentTinybars ?? 0) + quote.amountTinybars > policy.taskBudgetTinybars) return reject("Quote would exceed the total task budget.");
  if ((quote.dailyReservedTinybars ?? 0) + quote.amountTinybars > policy.dailyBudgetTinybars) return reject("Quote would exceed the daily reserved budget.");
  if ((quote.paidCallsThisTask ?? 0) >= policy.maxPaidCallsPerTask) return reject("Per-task paid-call limit reached.");
  if ((quote.paidCallsToday ?? 0) >= policy.maxPaidCallsPerDay) return reject("Daily paid-call limit reached.");
  if (policy.mode === "preview") return { allowed: false, requiresApproval: false, reason: "Preview mode never signs or sends a payment.", mode: policy.mode };
  const requiresApproval = policy.mode === "approval-required" || quote.amountTinybars > policy.approvalThresholdTinybars;
  if (requiresApproval) return { allowed: false, requiresApproval: true, reason: "Explicit user approval is required before this payment; no payment was signed or sent.", mode: policy.mode };
  return { allowed: true, requiresApproval: false, reason: "Quote satisfies the configured spending policy.", mode: policy.mode };
}
