import assert from "node:assert/strict";
import { test } from "node:test";

// server.ts does not listen when NODE_ENV=test, so Fastify can be tested in-process.
process.env.NODE_ENV = "test";
const { app } = await import("./server.js");

test("API health endpoint includes defensive security headers", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
});

test("untrusted browser origins are rejected and not reflected", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://attacker.example" } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("readiness reports local-only mode in non-production development", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health/ready" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "ready");
  assert.equal(response.json().paymentExecutionEnabled, false);
});

test("preflight from an untrusted origin is rejected", async () => {
  const response = await app.inject({ method: "OPTIONS", url: "/api/authorization/challenge", headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } });
  assert.equal(response.statusCode, 403);
});

test.after(async () => { await app.close(); });
