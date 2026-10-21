import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Wallet } from "ethers";
import { AUTHORIZATION_SCOPE_V2, createAuthorizationChallenge, verifyAuthorizationChallenge } from "./authorization.js";

const originalEnv = { ...process.env };
const auditDir = await mkdtemp(join(tmpdir(), "heder1-api-integration-"));
process.env.NODE_ENV = "test";
process.env.HEDERA_AGENT_ENABLED = "false";
process.env.HEDERA_AGENT_V2_ENABLED = "false";
process.env.HEDERA_X402_DEMO_ENABLED = "false";
process.env.HEDERA_AUDIT_HCS_ENABLED = "false";
process.env.HEDERA_AUDIT_LOG_PATH = join(auditDir, "audit.jsonl");
const { app } = await import("./server.js");

test("health route returns service status through Fastify injection", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "ok");
  assert.equal(response.json().service, "heder1-api");
});

test("configured frontend origin receives strict CORS headers", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(response.headers["access-control-allow-credentials"], undefined);
});

test("unknown browser origins are rejected", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(response.statusCode, 403);
});

test("CORS preflight is answered without running a payment route", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/authorization/challenge",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
});

test("audit history rejects an out-of-range limit", async () => {
  const response = await app.inject({ method: "GET", url: "/api/audit/records?limit=101" });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /integer from 1 to 100/);
});

test("agent execution remains disabled and does not require a wallet grant", async () => {
  const response = await app.inject({ method: "POST", url: "/api/agent/run" });
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /disabled/);
});


test("Phase 10 registry exposes only two explicit approved testnet services", async () => {
  const response = await app.inject({ method: "GET", url: "/api/agent/v2/services" });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.services.length, 2);
  assert.deepEqual(payload.services.map((service: { id: string }) => service.id), [
    "heder1-full-report",
    "heder1-short-summary",
  ]);
  assert.equal(payload.services.every((service: { trust: string; allowed: boolean }) => service.trust === "approved" && service.allowed), true);
  assert.match(payload.note, /actual HTTP 402 requirements/);
});

test("Phase 10 status and run remain disabled by default", async () => {
  const status = await app.inject({ method: "GET", url: "/api/agent/v2/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().enabled, false);
  const run = await app.inject({ method: "POST", url: "/api/agent/v2/run", payload: { goal: "Find the cheapest short report" } });
  assert.equal(run.statusCode, 403);
  assert.match(run.json().error, /disabled/);
});


test("Phase 10 stops through the API without paying when every 402 quote exceeds budget", async () => {
  const previousFetch = globalThis.fetch;
  const wallet = new Wallet("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  process.env.HEDERA_AGENT_V2_ENABLED = "true";
  process.env.HEDERA_NETWORK = "testnet";
  process.env.HEDERA_CLIENT_ACCOUNT_ID = "0.0.123";
  process.env.HEDERA_CLIENT_PRIVATE_KEY = "dummy-key-not-used-with-no-eligible-service";
  process.env.HEDERA_RECEIVER_ACCOUNT_ID = "0.0.11044329";
  process.env.HEDERA_X402_FACILITATOR_URL = "https://facilitator.test";
  let fetchCalls = 0;
  globalThis.fetch = async (input) => {
    fetchCalls += 1;
    assert.equal(String(input).startsWith("http://127.0.0.1:4000/api/x402/"), true);
    const challenge = {
      x402Version: 2,
      resource: { url: String(input), description: "test service" },
      accepts: [{
        scheme: "exact",
        network: "hedera:testnet",
        amount: "600000",
        asset: "0.0.0",
        payTo: "0.0.11044329",
        maxTimeoutSeconds: 300,
      }],
      extensions: {},
    };
    return new Response(JSON.stringify(challenge), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") },
    });
  };
  try {
    const challenge = createAuthorizationChallenge(wallet.address, Date.now(), AUTHORIZATION_SCOPE_V2);
    const signature = await wallet.signMessage(challenge.message);
    const grant = await verifyAuthorizationChallenge({ nonce: challenge.nonce, signature });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/v2/run",
      headers: { "x-heder1-authorization": grant.authorizationToken },
      payload: { runId: "00000000-0000-4000-8000-000000000123", goal: "Find the cheapest approved short report", budgetTinybars: 500000, maxPaidCalls: 3 },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().status, "stopped-safely");
    assert.equal(response.json().paymentAttempted, false);
    assert.match(response.json().error, /No approved service advertises/);
    assert.equal(fetchCalls, 2, "only the two unpaid discovery requests should run; no paid retry or facilitator call");
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of ["HEDERA_AGENT_V2_ENABLED", "HEDERA_NETWORK", "HEDERA_CLIENT_ACCOUNT_ID", "HEDERA_CLIENT_PRIVATE_KEY", "HEDERA_RECEIVER_ACCOUNT_ID", "HEDERA_X402_FACILITATOR_URL"]) {
      if (key in originalEnv) process.env[key] = originalEnv[key]!;
      else delete process.env[key];
    }
  }
});

test("Phase 10 cancellation rejects unknown run IDs", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/v2/cancel",
    payload: { runId: "00000000-0000-4000-8000-000000000000" },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().cancelled, false);
});

test("direct demo payment stays disabled without explicit opt-in", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/x402/demo-payment",
    payload: { confirmPayment: true },
  });
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /disabled/);
});

after(async () => {
  await app.close();
  await rm(auditDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});
