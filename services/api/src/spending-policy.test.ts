import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USER_SPENDING_POLICY, simulateSpendingPolicy, validateUserSpendingPolicy, type UserSpendingPolicy, type PolicyQuote } from "./spending-policy.js";

const now = 1_800_000_000_000;
const policy = (overrides: Partial<UserSpendingPolicy> = {}): UserSpendingPolicy => ({
  ...DEFAULT_USER_SPENDING_POLICY,
  expiresAt: now + 60_000,
  ...overrides,
});
const quote = (overrides: Partial<PolicyQuote> = {}): PolicyQuote => ({
  serviceId: "heder1-short-summary",
  network: "hedera:testnet",
  asset: "0.0.0",
  amountTinybars: 50_000,
  now,
  ...overrides,
});

test("valid bounded policy permits an eligible autonomous quote", () => {
  assert.deepEqual(validateUserSpendingPolicy(policy()), []);
  assert.deepEqual(simulateSpendingPolicy(policy(), quote()), {
    allowed: true,
    requiresApproval: false,
    reason: "Quote satisfies the configured spending policy.",
    mode: "autonomous",
  });
});

test("policy simulation rejects a quote above the per-payment cap", () => {
  const result = simulateSpendingPolicy(policy({ maxPaymentTinybars: 40_000 }), quote());
  assert.equal(result.allowed, false);
  assert.match(result.reason, /per-payment cap/);
});

test("policy simulation rejects task and daily budget overspend", () => {
  assert.match(simulateSpendingPolicy(policy({ taskBudgetTinybars: 60_000 }), quote({ taskSpentTinybars: 20_001 })).reason, /task budget/);
  assert.match(simulateSpendingPolicy(policy({ dailyBudgetTinybars: 60_000 }), quote({ dailyReservedTinybars: 20_001 })).reason, /daily reserved budget/);
});

test("policy simulation rejects unapproved services, assets, networks, expiry, and kill switch", () => {
  assert.match(simulateSpendingPolicy(policy(), quote({ serviceId: "unknown" })).reason, /allowlist/);
  assert.match(simulateSpendingPolicy(policy(), quote({ asset: "USDC" })).reason, /asset allowlist/);
  assert.match(simulateSpendingPolicy(policy(), quote({ network: "hedera:mainnet" } as Partial<PolicyQuote> & { network: string })).reason, /network/);
  assert.match(simulateSpendingPolicy(policy({ expiresAt: now }), quote()).reason, /expired/);
  assert.match(simulateSpendingPolicy(policy(), quote(), true).reason, /kill switch/);
});

test("preview mode never permits payment and approval mode pauses before payment", () => {
  const preview = simulateSpendingPolicy(policy({ mode: "preview" }), quote());
  assert.equal(preview.allowed, false);
  assert.match(preview.reason, /never signs/);
  const approval = simulateSpendingPolicy(policy({ mode: "approval-required" }), quote());
  assert.equal(approval.allowed, false);
  assert.equal(approval.requiresApproval, true);
  const threshold = simulateSpendingPolicy(policy({ approvalThresholdTinybars: 25_000 }), quote());
  assert.equal(threshold.requiresApproval, true);
});

test("per-task and daily paid-call limits are enforced", () => {
  assert.match(simulateSpendingPolicy(policy({ maxPaidCallsPerTask: 1 }), quote({ paidCallsThisTask: 1 })).reason, /Per-task paid-call/);
  assert.match(simulateSpendingPolicy(policy({ maxPaidCallsPerDay: 2 }), quote({ paidCallsToday: 2 })).reason, /Daily paid-call/);
});

test("policy rejects mainnet, unsupported assets, unapproved service IDs, and values above hard ceilings", () => {
  assert.ok(validateUserSpendingPolicy(policy({ network: "hedera:mainnet" })).length > 0);
  assert.ok(validateUserSpendingPolicy(policy({ allowedAssets: ["USDC"] })).length > 0);
  assert.ok(validateUserSpendingPolicy(policy({ allowedServiceIds: ["https://evil.example"] })).length > 0);
  assert.ok(validateUserSpendingPolicy(policy({ maxPaymentTinybars: 100_001 })).length > 0);
});
