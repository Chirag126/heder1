import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { handlePaidResource } from "./paid-resource.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const temporaryDirs: string[] = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function makeReply() {
  const state: { statusCode: number; headers: Record<string, string>; body: unknown } = {
    statusCode: 200, headers: {}, body: undefined,
  };
  const reply = {
    code(statusCode: number) { state.statusCode = statusCode; return reply; },
    header(name: string, value: string) { state.headers[name.toLowerCase()] = value; return reply; },
    send(body: unknown) { state.body = body; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function makeRequest(paymentHeader: string) {
  return {
    headers: { "payment-signature": paymentHeader },
    log: { error() {} },
  } as unknown as FastifyRequest;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("identical concurrent payment proofs verify and settle only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "heder1-duplicate-payment-"));
  temporaryDirs.push(dir);
  process.env.HEDERA_NETWORK = "testnet";
  process.env.HEDERA_CLIENT_ACCOUNT_ID = "0.0.123";
  process.env.HEDERA_CLIENT_PRIVATE_KEY = "test-only-placeholder";
  process.env.HEDERA_RECEIVER_ACCOUNT_ID = "0.0.11044329";
  process.env.HEDERA_X402_FACILITATOR_URL = "https://facilitator.test";
  process.env.HEDERA_AUDIT_HCS_ENABLED = "false";
  process.env.HEDERA_AUDIT_LOG_PATH = join(dir, "audit.jsonl");

  let verifyCalls = 0;
  let settleCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/supported")) {
      return jsonResponse({ kinds: [{ scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.99" } }], signers: {} });
    }
    if (url.endsWith("/verify")) {
      verifyCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return jsonResponse({ isValid: true });
    }
    if (url.endsWith("/settle")) {
      settleCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return jsonResponse({ success: true, transaction: "0.0.123@1234567890.000000001" });
    }
    throw new Error("Unexpected facilitator request");
  };

  const proof = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: "exact", network: "hedera:testnet", amount: "100000", payTo: "0.0.11044329", asset: "0.0.0" },
    payload: { testNonce: randomUUID() },
  })).toString("base64");
  const first = makeReply();
  const second = makeReply();

  await Promise.all([
    handlePaidResource(makeRequest(proof), first.reply),
    handlePaidResource(makeRequest(proof), second.reply),
  ]);

  assert.equal(first.state.statusCode, 200);
  assert.equal(second.state.statusCode, 200);
  assert.equal((first.state.body as any).payment.transaction, (second.state.body as any).payment.transaction);
  assert.equal(verifyCalls, 1);
  assert.equal(settleCalls, 1);
});
