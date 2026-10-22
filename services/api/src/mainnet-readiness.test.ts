import assert from "node:assert/strict";
import test from "node:test";
import { checkMainnetReadiness, validateMainnetReadinessInput, type MainnetReadinessInput } from "./mainnet-readiness.js";

const input: MainnetReadinessInput = {
  account: "0x0000000000000000000000000000000000000001",
  explicitOptIn: true,
  network: "hedera:mainnet",
  scheme: "exact",
  asset: "0.0.0",
  assetDecimals: 8,
  amount: "50000",
  maximumExposure: "100000",
  payerAccountId: "0.0.1001",
  destinationAccountId: "0.0.1002",
};

function mockFetch(url: string): Response {
  if (url.endsWith("/supported")) {
    return new Response(JSON.stringify({ kinds: [{ scheme: "exact", network: "hedera:mainnet" }] }), { status: 200 });
  }
  if (url.endsWith("/api/v1/accounts/0.0.1001")) {
    return new Response(JSON.stringify({ account: "0.0.1001", balance: { balance: 250000 } }), { status: 200 });
  }
  if (url.endsWith("/api/v1/accounts/0.0.1002")) {
    return new Response(JSON.stringify({ account: "0.0.1002", balance: { balance: 0 } }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 404 });
}

const deps = {
  facilitatorUrl: "https://facilitator.example",
  mirrorNodeUrl: "https://mirror.example",
  maxExposureCap: "1000000",
  fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => mockFetch(String(input))) as typeof fetch,
};

test("mainnet readiness validates network, exact scheme, HBAR units and exposure", () => {
  assert.deepEqual(validateMainnetReadinessInput(input, "1000000"), []);
  assert.ok(validateMainnetReadinessInput({ ...input, network: "hedera:testnet" }, "1000000").some(error => /exactly hedera:mainnet/.test(error)));
  assert.ok(validateMainnetReadinessInput({ ...input, assetDecimals: 6 }, "1000000").some(error => /HBAR uses 8 decimals/.test(error)));
  assert.ok(validateMainnetReadinessInput({ ...input, amount: "100001" }, "1000000").some(error => /exceeds the explicitly approved maximum exposure/.test(error)));
  assert.ok(validateMainnetReadinessInput({ ...input, explicitOptIn: false }, "1000000").some(error => /Explicit mainnet opt-in/.test(error)));
});

test("readiness check is read-only and never enables payment execution", async () => {
  const result = await checkMainnetReadiness(input, deps);
  assert.equal(result.readyForReadinessApproval, true);
  assert.equal(result.paymentExecutionEnabled, false);
  assert.equal(result.facilitatorSupportsNetwork, true);
  assert.equal(result.assetMetadataValidated, true);
  assert.equal(result.payerBalanceSufficient, true);
  assert.equal(result.destinationValidated, true);
});

test("readiness rejects a facilitator that does not advertise hedera:mainnet", async () => {
  const fetcher = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/supported")) return new Response(JSON.stringify({ kinds: [{ scheme: "exact", network: "hedera:testnet" }] }), { status: 200 });
    return mockFetch(String(url));
  }) as typeof fetch;
  const result = await checkMainnetReadiness(input, { ...deps, fetcher });
  assert.equal(result.readyForReadinessApproval, false);
  assert.equal(result.facilitatorSupportsNetwork, false);
  assert.ok(result.blockers.some(error => /does not advertise/.test(error)));
});

test("HTS asset metadata and decimals must match Mirror Node", async () => {
  const tokenInput = { ...input, asset: "0.0.777", assetDecimals: 6 };
  const fetcher = (async (url: RequestInfo | URL) => {
    const value = String(url);
    if (value.endsWith("/supported")) return new Response(JSON.stringify({ kinds: [{ scheme: "exact", network: "hedera:mainnet" }] }), { status: 200 });
    if (value.endsWith("/api/v1/tokens/0.0.777")) return new Response(JSON.stringify({ token_id: "0.0.777", type: "FUNGIBLE_COMMON", deleted: false, decimals: "6" }), { status: 200 });
    if (value.endsWith("/api/v1/accounts/0.0.1001")) return new Response(JSON.stringify({ account: "0.0.1001", balance: { balance: 250000 } }), { status: 200 });
    if (value.includes("/api/v1/accounts/0.0.1001/tokens")) return new Response(JSON.stringify({ tokens: [{ token_id: "0.0.777", balance: "250000" }] }), { status: 200 });
    if (value.endsWith("/api/v1/accounts/0.0.1002")) return new Response(JSON.stringify({ account: "0.0.1002" }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
  const result = await checkMainnetReadiness(tokenInput, { ...deps, fetcher });
  assert.equal(result.assetMetadataValidated, true);
  assert.equal(result.payerBalanceSufficient, true);
  assert.equal(result.readyForReadinessApproval, true);
});
