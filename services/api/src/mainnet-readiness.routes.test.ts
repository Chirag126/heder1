import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
const { app } = await import("./server.js");

test("network API keeps testnet as the only enabled payment network", async () => {
  const response = await app.inject({ method: "GET", url: "/api/networks" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.enabledNetworks, ["hedera:testnet"]);
  assert.equal(body.mainnet.paymentExecutionEnabled, false);
});

test("mainnet readiness endpoints are disabled by default", async () => {
  const prior = process.env.HEDERA_MAINNET_READINESS_ENABLED;
  delete process.env.HEDERA_MAINNET_READINESS_ENABLED;
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/mainnet/readiness/check",
      payload: {
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
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().paymentExecutionEnabled, false);
  } finally {
    if (prior === undefined) delete process.env.HEDERA_MAINNET_READINESS_ENABLED;
    else process.env.HEDERA_MAINNET_READINESS_ENABLED = prior;
  }
});

test("readiness API rejects testnet as a mainnet quote before any payment can run", async () => {
  const priorEnabled = process.env.HEDERA_MAINNET_READINESS_ENABLED;
  const priorFacilitator = process.env.HEDERA_MAINNET_FACILITATOR_URL;
  const priorFetch = globalThis.fetch;
  process.env.HEDERA_MAINNET_READINESS_ENABLED = "true";
  process.env.HEDERA_MAINNET_FACILITATOR_URL = "https://facilitator.example";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/supported")) return new Response(JSON.stringify({ kinds: [{ scheme: "exact", network: "hedera:mainnet" }] }), { status: 200 });
    if (url.endsWith("/api/v1/accounts/0.0.1001")) return new Response(JSON.stringify({ account: "0.0.1001", balance: { balance: 250000 } }), { status: 200 });
    if (url.endsWith("/api/v1/accounts/0.0.1002")) return new Response(JSON.stringify({ account: "0.0.1002" }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/mainnet/readiness/check",
      payload: {
        account: "0x0000000000000000000000000000000000000001",
        explicitOptIn: true,
        network: "hedera:testnet",
        scheme: "exact",
        asset: "0.0.0",
        assetDecimals: 8,
        amount: "50000",
        maximumExposure: "100000",
        payerAccountId: "0.0.1001",
        destinationAccountId: "0.0.1002",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().readyForReadinessApproval, false);
    assert.equal(response.json().paymentExecutionEnabled, false);
    assert.ok(response.json().blockers.some((item: string) => item.includes("exactly hedera:mainnet")));
  } finally {
    globalThis.fetch = priorFetch;
    if (priorEnabled === undefined) delete process.env.HEDERA_MAINNET_READINESS_ENABLED;
    else process.env.HEDERA_MAINNET_READINESS_ENABLED = priorEnabled;
    if (priorFacilitator === undefined) delete process.env.HEDERA_MAINNET_FACILITATOR_URL;
    else process.env.HEDERA_MAINNET_FACILITATOR_URL = priorFacilitator;
    await app.close();
  }
});
