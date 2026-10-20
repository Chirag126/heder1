import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { handlePaidResource } from "./paid-resource.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRequest(paymentHeader?: string) {
  return {
    headers: paymentHeader ? { "payment-signature": paymentHeader } : {},
    log: { error() {} },
  } as unknown as FastifyRequest;
}

function makeReply() {
  const state: { statusCode: number; headers: Record<string, string>; body: unknown } = {
    statusCode: 200,
    headers: {},
    body: undefined,
  };
  const reply = {
    code(statusCode: number) {
      state.statusCode = statusCode;
      return reply;
    },
    header(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function supportedResponse() {
  return {
    kinds: [{ scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.99" } }],
    signers: {},
  };
}

function validPaymentHeader(network = "hedera:testnet") {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: "exact", network },
    payload: {},
  })).toString("base64");
}

beforeEach(() => {
  process.env.HEDERA_NETWORK = "testnet";
  process.env.HEDERA_CLIENT_ACCOUNT_ID = "0.0.123";
  process.env.HEDERA_CLIENT_PRIVATE_KEY = "test-only-placeholder";
  process.env.HEDERA_RECEIVER_ACCOUNT_ID = "0.0.11044329";
  process.env.HEDERA_X402_FACILITATOR_URL = "https://facilitator.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
});

test("requests without payment receive a 402 challenge with fixed testnet terms", async () => {
  globalThis.fetch = async () => jsonResponse(supportedResponse());
  const { reply, state } = makeReply();

  await handlePaidResource(makeRequest(), reply);

  assert.equal(state.statusCode, 402);
  assert.equal((state.body as any).x402Version, 2);
  assert.equal((state.body as any).accepts[0].network, "hedera:testnet");
  assert.equal((state.body as any).accepts[0].amount, "100000");
  assert.equal((state.body as any).accepts[0].payTo, "0.0.11044329");
  assert.equal(state.headers["payment-required"] !== undefined, true);
});

test("malformed payment proofs are rejected without calling verify or settle", async () => {
  let facilitatorCalls = 0;
  globalThis.fetch = async (input) => {
    facilitatorCalls += 1;
    assert.match(String(input), /\/supported$/);
    return jsonResponse(supportedResponse());
  };
  const { reply, state } = makeReply();

  await handlePaidResource(makeRequest("not-base64-json"), reply);

  assert.equal(state.statusCode, 400);
  assert.equal(facilitatorCalls, 1);
  assert.match((state.body as any).error, /base64-encoded/);
});

test("wrong-network payment proofs are rejected", async () => {
  globalThis.fetch = async () => jsonResponse(supportedResponse());
  const { reply, state } = makeReply();

  await handlePaidResource(makeRequest(validPaymentHeader("hedera:mainnet")), reply);

  assert.equal(state.statusCode, 400);
  assert.match((state.body as any).error, /hedera:testnet/);
});

test("facilitator verification failure withholds the protected resource", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/supported")) return jsonResponse(supportedResponse());
    if (url.endsWith("/verify")) return jsonResponse({ isValid: false, invalidReason: "invalid proof" });
    throw new Error("Settlement must not be called after failed verification");
  };
  const { reply, state } = makeReply();

  await handlePaidResource(makeRequest(validPaymentHeader()), reply);

  assert.equal(state.statusCode, 402);
  assert.equal((state.body as any).resource, undefined);
  assert.match((state.body as any).error, /invalid proof/);
  assert.match((state.body as any).note, /withheld/);
});

test("settlement failure withholds the protected resource", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/supported")) return jsonResponse(supportedResponse());
    if (url.endsWith("/verify")) return jsonResponse({ isValid: true });
    if (url.endsWith("/settle")) return jsonResponse({ success: false, errorReason: "settlement rejected" });
    throw new Error("Unexpected facilitator request");
  };
  const { reply, state } = makeReply();

  await handlePaidResource(makeRequest(validPaymentHeader()), reply);

  assert.equal(state.statusCode, 402);
  assert.equal((state.body as any).resource, undefined);
  assert.match((state.body as any).error, /settlement rejected/);
});

test("successful verification and settlement return the protected resource and transaction ID", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/supported")) return jsonResponse(supportedResponse());
    if (url.endsWith("/verify")) return jsonResponse({ isValid: true });
    if (url.endsWith("/settle")) return jsonResponse({
      success: true,
      transaction: "0.0.123@1234567890.000000001",
    });
    throw new Error("Unexpected facilitator request");
  };
  const { reply, state } = makeReply();

  await handlePaidResource(makeRequest(validPaymentHeader()), reply);

  assert.equal(state.statusCode, 200);
  assert.equal((state.body as any).resource, "heder1-demo-report");
  assert.equal((state.body as any).payment.status, "settled");
  assert.equal((state.body as any).payment.transaction, "0.0.123@1234567890.000000001");
  assert.equal(state.headers["payment-response"] !== undefined, true);
});
