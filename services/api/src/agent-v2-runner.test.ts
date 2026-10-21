import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isAgentV2Enabled, runAgentV2Task } from "./agent-v2-runner.js";

const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

test("Phase 10 runner is disabled by default and in production", () => {
  process.env.HEDERA_NETWORK = "testnet";
  process.env.NODE_ENV = "development";
  delete process.env.HEDERA_AGENT_V2_ENABLED;
  assert.equal(isAgentV2Enabled(), false);
  process.env.HEDERA_AGENT_V2_ENABLED = "true";
  assert.equal(isAgentV2Enabled(), true);
  process.env.NODE_ENV = "production";
  assert.equal(isAgentV2Enabled(), false);
});

test("disabled runner fails before config, discovery, signing, or payment", async () => {
  delete process.env.HEDERA_AGENT_V2_ENABLED;
  process.env.HEDERA_NETWORK = "testnet";
  process.env.NODE_ENV = "test";
  await assert.rejects(
    () => runAgentV2Task({ goal: "Find cheapest short report" }, { signal: new AbortController().signal }),
    /disabled/,
  );
});
