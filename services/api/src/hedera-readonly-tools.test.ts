import assert from "node:assert/strict";
import test from "node:test";
import { getTestnetAccountSnapshot, HEDERA_TESTNET_MIRROR_NODE } from "./hedera-readonly-tools.js";

const snapshot = {
  account: "0.0.12345",
  balance: { balance: 123456, timestamp: "1234567890.000000000" },
  evm_address: "0x1234567890123456789012345678901234567890",
  deleted: false,
  expiration_timestamp: "1893456000.000000000",
};

test("read-only account tool returns a sanitized Testnet snapshot from the fixed Mirror Node", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const result = await getTestnetAccountSnapshot("0.0.12345", {
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(requestedUrl, `${HEDERA_TESTNET_MIRROR_NODE}/accounts/0.0.12345`);
  assert.equal(requestedInit?.method, "GET");
  assert.equal(result.network, "hedera:testnet");
  assert.equal(result.balanceTinybars, "123456");
  assert.equal(result.evmAddress, snapshot.evm_address);
  assert.equal(result.readOnly, true);
  assert.equal(result.source, "hedera-testnet-mirror-node");
  assert.equal("privateKey" in result, false);
});

test("rejects malformed IDs before making a network request", async () => {
  let called = false;
  await assert.rejects(
    getTestnetAccountSnapshot("https://example.com", { fetchImpl: async () => { called = true; return new Response("{}"); } }),
    /accountId must be a Hedera account ID/,
  );
  assert.equal(called, false);
});

test("handles not-found, upstream failure and malformed mirror responses", async () => {
  await assert.rejects(getTestnetAccountSnapshot("0.0.12345", { fetchImpl: async () => new Response("{}", { status: 404 }) }), /account was not found/);
  await assert.rejects(getTestnetAccountSnapshot("0.0.12345", { fetchImpl: async () => new Response("{}", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(getTestnetAccountSnapshot("0.0.12345", { fetchImpl: async () => new Response(JSON.stringify({ account: "0.0.99999", balance: { balance: -1 } }), { status: 200 }) }), /invalid account snapshot/);
});

test("rejects an unsafe timeout override", async () => {
  await assert.rejects(getTestnetAccountSnapshot("0.0.12345", { timeoutMs: 60 }), /timeoutMs must be an integer/);
});
