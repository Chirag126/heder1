import assert from "node:assert/strict";
import test from "node:test";
import {
  agentV2Policy,
  DEFAULT_AGENT_V2_LIMITS,
  getApprovedServiceRegistry,
  parseX402Requirements,
  selectCheapestEligibleService,
  summarizeTaskPlan,
  validateAgentV2Limits,
  type ApprovedService,
  type PaymentRequirement,
} from "./agent-v2.js";

const services: ApprovedService[] = [
  { id: "report-a", url: "http://127.0.0.1:4000/api/x402/paid-resource", description: "Demo report", networks: ["hedera:testnet"], assetTypes: ["HBAR"], trust: "approved", allowed: true },
  { id: "report-b", url: "http://localhost:4000/api/x402/summary", description: "Short summary", networks: ["hedera:testnet"], assetTypes: ["HBAR"], trust: "approved", allowed: true },
];
const requirement = (amount: string, payTo = "0.0.11044329"): PaymentRequirement => ({
  scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount, payTo,
});

test("default plan is bounded to 0.005 HBAR, three paid calls and finite runtime", () => {
  assert.equal(DEFAULT_AGENT_V2_LIMITS.budgetTinybars, 500_000);
  assert.equal(DEFAULT_AGENT_V2_LIMITS.maxPaidCalls, 3);
  assert.equal(validateAgentV2Limits(DEFAULT_AGENT_V2_LIMITS).length, 0);
  assert.equal(agentV2Policy.enabledByDefault, false);
});


test("registry contains two distinct approved service manifests with informational prices", () => {
  const registry = getApprovedServiceRegistry();
  assert.equal(registry.length, 2);
  assert.notEqual(registry[0]!.url, registry[1]!.url);
  assert.equal(registry[0]!.priceMetadata?.amountTinybars, "100000");
  assert.equal(registry[1]!.priceMetadata?.amountTinybars, "50000");
  assert.ok(registry.every((service) => service.trust === "approved" && service.allowed));
  assert.ok(registry.every((service) => service.networks.includes("hedera:testnet") && service.assetTypes.includes("HBAR")));
});

test("Phase 10 hard caps cannot be expanded by request input", () => {
  assert.ok(validateAgentV2Limits({ ...DEFAULT_AGENT_V2_LIMITS, budgetTinybars: 500001 }).length > 0);
  assert.ok(validateAgentV2Limits({ ...DEFAULT_AGENT_V2_LIMITS, maxPaidCalls: 4 }).length > 0);
  assert.ok(validateAgentV2Limits({ ...DEFAULT_AGENT_V2_LIMITS, maxSteps: 9 }).length > 0);
});

test("planner rejects unbounded or excessive limits", () => {
  assert.ok(validateAgentV2Limits({ ...DEFAULT_AGENT_V2_LIMITS, maxPaidCalls: 100 }).length > 0);
  assert.ok(validateAgentV2Limits({ ...DEFAULT_AGENT_V2_LIMITS, maxRuntimeMs: 999_999 }).length > 0);
  assert.equal(summarizeTaskPlan(" ", DEFAULT_AGENT_V2_LIMITS).accepted, false);
});

test("parses actual x402 v2 accepts and ignores malformed requirements", () => {
  assert.deepEqual(parseX402Requirements({
    x402Version: 2,
    accepts: [
      requirement("50000"),
      { scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "not-a-number", payTo: "0.0.1" },
    ],
  }), [requirement("50000")]);
  assert.deepEqual(parseX402Requirements({ x402Version: 1, accepts: [requirement("50000")] }), []);
});

test("selects cheapest eligible service using advertised 402 prices, not registry hints", () => {
  const result = selectCheapestEligibleService({
    services,
    requirementsByService: new Map([
      ["report-a", [requirement("100000")]],
      ["report-b", [requirement("50000")]],
    ]),
    budgetTinybars: 500_000,
    allowedReceiverIds: ["0.0.11044329"],
  });
  assert.equal(result.selected?.service.id, "report-b");
  assert.equal(result.selected?.amountTinybars, 50_000);
  assert.equal(result.eligible.length, 2);
});

test("rejects candidates over budget, wrong receiver, wrong network and outside allowlist", () => {
  const result = selectCheapestEligibleService({
    services,
    requirementsByService: new Map([
      ["report-a", [requirement("600000")]],
      ["report-b", [requirement("50000", "0.0.999")]],
    ]),
    budgetTinybars: 500_000,
    allowedReceiverIds: ["0.0.11044329"],
    allowedServiceIds: ["report-a", "report-b"],
  });
  assert.equal(result.selected, null);
  assert.equal(result.rejected.length, 2);
});

test("blocks remote, HTTPS, credentialed and query-bearing service URLs", () => {
  const unsafe: ApprovedService = { ...services[0]!, url: "https://example.com/report" };
  const result = selectCheapestEligibleService({
    services: [unsafe],
    requirementsByService: new Map([[unsafe.id, [requirement("50000")]]]),
    budgetTinybars: 500_000,
  });
  assert.equal(result.selected, null);
  assert.match(result.rejected[0]!.reason, /URL/);
});
