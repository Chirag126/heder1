import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const originalEnv = { ...process.env };
const auditDir = await mkdtemp(join(tmpdir(), "heder1-api-integration-"));
process.env.NODE_ENV = "test";
process.env.HEDERA_AGENT_ENABLED = "false";
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
