import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { evaluateAgentTarget, extractSettlementReceipt, isAgentEnabled, paymentAgentPolicy } from "./agent.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

test("agent approves only the exact local paid-resource endpoint", () => {
  const decision = evaluateAgentTarget("http://127.0.0.1:4000/api/x402/paid-resource");
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.maxAmountTinybars, "100000");
    assert.equal(new URL(decision.url).pathname, "/api/x402/paid-resource");
  }
});

test("agent blocks remote targets and non-resource paths", () => {
  for (const url of [
    "https://example.com/api/x402/paid-resource",
    "http://127.0.0.1:4000/admin",
    "http://127.0.0.1:4000/api/x402/paid-resource?url=https://example.com",
    "http://user:password@127.0.0.1:4000/api/x402/paid-resource",
    "not a url",
  ]) {
    const decision = evaluateAgentTarget(url);
    assert.equal(decision.allowed, false, url);
  }
});

test("agent is disabled by default and in production", () => {
  delete process.env.HEDERA_AGENT_ENABLED;
  process.env.HEDERA_NETWORK = "testnet";
  process.env.NODE_ENV = "development";
  assert.equal(isAgentEnabled(), false);

  process.env.HEDERA_AGENT_ENABLED = "true";
  assert.equal(isAgentEnabled(), true);

  process.env.NODE_ENV = "production";
  assert.equal(isAgentEnabled(), false);

  process.env.NODE_ENV = "development";
  process.env.HEDERA_NETWORK = "mainnet";
  assert.equal(isAgentEnabled(), false);
});

test("agent policy advertises a fixed tinybars cap and blocks remote targets", () => {
  assert.equal(paymentAgentPolicy.enabledByDefault, false);
  assert.equal(paymentAgentPolicy.maxAmountTinybars, "100000");
  assert.equal(paymentAgentPolicy.remoteTargetsAllowed, false);
});

test("agent accepts a 2xx protected-resource response only with a settled transaction receipt", () => {
  assert.deepEqual(extractSettlementReceipt(200, {
    resource: "heder1-demo-report",
    payment: { status: "settled", transaction: "0.0.123@1760000000.000000001", settledAt: "2026-10-22T00:00:00.000Z" },
  }), {
    transactionId: "0.0.123@1760000000.000000001",
    settledAt: "2026-10-22T00:00:00.000Z",
    resource: "heder1-demo-report",
  });
});

test("agent does not treat HTTP success without a settlement receipt as payment success", () => {
  assert.throws(() => extractSettlementReceipt(200, { resource: "hello" }), /settlement receipt/);
  assert.throws(() => extractSettlementReceipt(200, {
    resource: "heder1-demo-report",
    payment: { status: "pending", transaction: "0.0.123@1760000000.000000001" },
  }), /did not confirm settlement/);
  assert.throws(() => extractSettlementReceipt(200, {
    payment: { status: "settled", transaction: "0.0.123@1760000000.000000001" },
  }), /protected resource was missing/);
});

test("agent refuses to claim a paid delivery on non-2xx responses", () => {
  assert.throws(() => extractSettlementReceipt(402, {
    error: "Facilitator rejected payment",
  }), /HTTP 402/);
});
