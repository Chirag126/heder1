import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { evaluateAgentTarget, isAgentEnabled, paymentAgentPolicy } from "./agent.js";

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
