import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { getX402Configuration } from "./x402.js";
import { appendAuditEvent } from "./audit-trail.js";

type JsonRecord = Record<string, unknown>;
const AMOUNT_TINYBARS = "100000"; // Spending policy: fixed 0.001 HBAR per resource request.
const RESOURCE_BODY = {
  resource: "heder1-demo-report",
  message: "Access granted after x402 payment verification and settlement.",
  network: "hedera:testnet",
  amountHbar: "0.001",
};
const settled = new Map<string, { transaction: string; settledAt: string }>();
const inFlight = new Map<string, Promise<{ transaction: string; settledAt: string }>>();

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodePaymentHeader(value: string): JsonRecord {
  if (value.length > 16_384) throw new Error("Payment proof exceeds the 16 KiB limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("Payment proof must be a base64-encoded x402 v2 JSON payload.");
  }
  // x402 v2 puts scheme/network inside the "accepted" requirements object.
  // The v1 top-level scheme/network fields are not part of the v2 payload shape.
  const accepted = isRecord(parsed) && isRecord(parsed.accepted) ? parsed.accepted : null;
  if (!isRecord(parsed) || parsed.x402Version !== 2 || !accepted ||
      accepted.scheme !== "exact" || accepted.network !== "hedera:testnet") {
    throw new Error("Payment proof must use x402 v2 with accepted exact requirements on hedera:testnet.");
  }
  return parsed;
}

function makeRequirements(receiverAccountId: string, feePayer: string) {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    amount: AMOUNT_TINYBARS,
    payTo: receiverAccountId,
    maxTimeoutSeconds: 300,
    asset: "0.0.0",
    extra: { feePayer },
  };
}

async function readFacilitatorJson(response: Response, label: string): Promise<JsonRecord> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body)) throw new Error(`${label} failed (HTTP ${response.status}).`);
  return body;
}

async function settleOnce(key: string, paymentPayload: JsonRecord, requirements: ReturnType<typeof makeRequirements>, baseUrl: string) {
  const existing = settled.get(key);
  if (existing) return existing;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements });
    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    };
    const verifyResponse = await fetch(`${baseUrl}/verify`, options);
    const verification = await readFacilitatorJson(verifyResponse, "Facilitator verification");
    if (verification.isValid !== true) {
      throw new Error(typeof verification.invalidReason === "string" ? verification.invalidReason : "Facilitator rejected the payment proof.");
    }

    const settleResponse = await fetch(`${baseUrl}/settle`, options);
    const settlement = await readFacilitatorJson(settleResponse, "Facilitator settlement");
    if (settlement.success !== true || typeof settlement.transaction !== "string" || !settlement.transaction) {
      throw new Error(typeof settlement.errorReason === "string" ? settlement.errorReason : "Facilitator did not confirm settlement with a transaction ID.");
    }
    const result = { transaction: settlement.transaction, settledAt: new Date().toISOString() };
    settled.set(key, result);
    return result;
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

export async function handlePaidResource(request: FastifyRequest, reply: FastifyReply) {
  let config;
  try {
    config = getX402Configuration();
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : "Invalid payment configuration." });
  }
  if (!config) return reply.code(503).send({ error: "Hedera testnet payer is not configured." });

  // Spending policy is intentionally immutable for Phase 1: testnet, HBAR only,
  // 0.001 HBAR, one configured receiver, exact scheme, 5-minute timeout.
  const baseUrl = config.facilitatorUrl.replace(/\/+$/, "");
  let supported: JsonRecord;
  try {
    supported = await readFacilitatorJson(await fetch(`${baseUrl}/supported`, { signal: AbortSignal.timeout(10_000) }), "Facilitator capabilities");
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : "Facilitator unavailable." });
  }
  const kinds = Array.isArray(supported.kinds) ? supported.kinds.filter(isRecord) : [];
  const kind = kinds.find((item) => item.network === "hedera:testnet" && item.scheme === "exact");
  const extra = isRecord(kind?.extra) ? kind.extra : {};
  const signers = isRecord(supported.signers) ? supported.signers : {};
  const signerList = Array.isArray(signers["hedera:*"]) ? signers["hedera:*"] : [];
  const feePayer = typeof extra.feePayer === "string" ? extra.feePayer : signerList.find((item): item is string => typeof item === "string");
  if (!feePayer) return reply.code(503).send({ error: "Facilitator does not advertise an exact Hedera testnet fee payer." });

  const requirements = makeRequirements(config.receiverAccountId, feePayer);
  const challenge = {
    x402Version: 2,
    resource: {
      url: "/api/x402/paid-resource",
      description: "Access to the heder1 demo report; fixed testnet price 0.001 HBAR.",
      mimeType: "application/json",
      serviceName: "heder1",
    },
    accepts: [requirements],
    extensions: {},
  };
  const paymentHeader = request.headers["payment-signature"] ?? request.headers["x-payment"];
  if (typeof paymentHeader !== "string" || !paymentHeader) {
    const encoded = Buffer.from(JSON.stringify(challenge)).toString("base64");
    return reply
      .code(402)
      .header("payment-required", encoded)
      .header("cache-control", "no-store")
      .send(challenge);
  }

  let paymentPayload: JsonRecord;
  try {
    paymentPayload = decodePaymentHeader(paymentHeader);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid payment proof." });
  }

  // Enforce the advertised scheme/network; facilitator verification enforces
  // the signed amount, destination, expiry, and chain-specific proof.
  const key = createHash("sha256").update(paymentHeader).digest("hex");
  await appendAuditEvent({ event: "payment.attempted", outcome: "started", details: { proofHash: key, amountTinybars: AMOUNT_TINYBARS, receiverAccountId: config.receiverAccountId, network: "hedera:testnet" } });
  try {
    const result = await settleOnce(key, paymentPayload, requirements, baseUrl);
    await appendAuditEvent({ event: "payment.settled", outcome: "settled", details: { proofHash: key, transactionId: result.transaction, settledAt: result.settledAt, amountTinybars: AMOUNT_TINYBARS, receiverAccountId: config.receiverAccountId, network: "hedera:testnet" } });
    return reply
      .header("payment-response", Buffer.from(JSON.stringify({ success: true, transaction: result.transaction, network: "hedera:testnet" })).toString("base64"))
      .header("cache-control", "no-store")
      .send({
        ...RESOURCE_BODY,
        payment: { status: "settled", transaction: result.transaction, settledAt: result.settledAt },
        explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(result.transaction)}`,
      });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Payment verification or settlement failed.";
    await appendAuditEvent({ event: "payment.rejected", outcome: "rejected", details: { proofHash: key, reason, amountTinybars: AMOUNT_TINYBARS, receiverAccountId: config.receiverAccountId, network: "hedera:testnet" } });
    request.log.error({ err: error }, "x402 paid-resource payment failed");
    return reply.code(402).send({
      ...challenge,
      error: reason,
      note: "Resource withheld because successful settlement was not confirmed.",
    });
  }
}

export const paidResourcePolicy = {
  network: "hedera:testnet",
  asset: "HBAR",
  amountTinybars: AMOUNT_TINYBARS,
  amountHbar: "0.001",
  receiverAccountId: "configured-by-HEDERA_RECEIVER_ACCOUNT_ID",
  productionEnabled: false,
  replayProtection: "in-memory idempotency for identical payment proofs; use durable storage before deployment",
};
