import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { getX402Configuration } from "./x402.js";
import { appendAuditEvent } from "./audit-trail.js";
import { claimPaymentProof, databaseConfigured, finishPaymentProof } from "./database.js";

type JsonRecord = Record<string, unknown>;
type ServiceDefinition = {
  path: string;
  resource: string;
  description: string;
  amountTinybars: string;
  message: string;
};

const FULL_REPORT: ServiceDefinition = {
  path: "/api/x402/paid-resource",
  resource: "heder1-demo-report",
  description: "Access to the heder1 demo report; fixed testnet price 0.001 HBAR.",
  amountTinybars: "100000",
  message: "Access granted after x402 payment verification and settlement.",
};
const SHORT_SUMMARY: ServiceDefinition = {
  path: "/api/x402/summary",
  resource: "heder1-short-summary",
  description: "Access to the heder1 short summary; fixed testnet price 0.0005 HBAR.",
  amountTinybars: "50000",
  message: "Short report: the least expensive approved heder1 test service returned this summary after settlement.",
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
  const accepted = isRecord(parsed) && isRecord(parsed.accepted) ? parsed.accepted : null;
  if (!isRecord(parsed) || parsed.x402Version !== 2 || !accepted ||
      accepted.scheme !== "exact" || accepted.network !== "hedera:testnet") {
    throw new Error("Payment proof must use x402 v2 with accepted exact requirements on hedera:testnet.");
  }
  return parsed;
}

function makeRequirements(receiverAccountId: string, feePayer: string, service: ServiceDefinition) {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    amount: service.amountTinybars,
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

async function settleOnce(key: string, paymentPayload: JsonRecord, requirements: ReturnType<typeof makeRequirements>, baseUrl: string, servicePath: string) {
  const existing = settled.get(key);
  if (existing) return existing;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    let durableClaim = false;
    let terminalRecorded = false;
    if (databaseConfigured()) {
      const claim = await claimPaymentProof(key, servicePath);
      if (!claim.claimed) {
        if (claim.status === "settled") return { transaction: claim.transactionId, settledAt: claim.settledAt };
        throw new Error(`This payment proof is already ${claim.status}; it will not be submitted again. Reconcile the existing outcome before retrying.`);
      }
      durableClaim = true;
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required for durable x402 proof replay protection in production.");
    }
    try {
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
      const reason = typeof verification.invalidReason === "string" ? verification.invalidReason : "Facilitator rejected the payment proof.";
      if (durableClaim) {
        await finishPaymentProof({ proofHash: key, status: "rejected", errorCode: "facilitator_rejected_proof" });
        terminalRecorded = true;
      }
      throw new Error(reason);
    }

    const settleResponse = await fetch(`${baseUrl}/settle`, options);
    const settlement = await readFacilitatorJson(settleResponse, "Facilitator settlement");
    if (settlement.success !== true || typeof settlement.transaction !== "string" || !settlement.transaction) {
      throw new Error(typeof settlement.errorReason === "string" ? settlement.errorReason : "Facilitator did not confirm settlement with a transaction ID.");
    }
    const result = { transaction: settlement.transaction, settledAt: new Date().toISOString() };
    if (durableClaim) {
      await finishPaymentProof({
        proofHash: key,
        status: "settled",
        transactionId: result.transaction,
        settledAt: result.settledAt,
        response: { servicePath, transactionId: result.transaction },
      });
      terminalRecorded = true;
    }
    settled.set(key, result);
    return result;
    } catch (error) {
      if (durableClaim && !terminalRecorded) {
        try { await finishPaymentProof({ proofHash: key, status: "unknown", errorCode: "facilitator_outcome_uncertain" }); } catch { /* recovery sweep will classify the stale claim; never retry automatically */ }
      }
      throw error;
    }
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

function makeHandler(service: ServiceDefinition) {
  return async function handleService(request: FastifyRequest, reply: FastifyReply) {
    let config;
    try {
      if (process.env.NODE_ENV === "production" && !databaseConfigured()) {
      return reply.code(503).send({ error: "DATABASE_URL is required for durable payment-proof replay protection; payment is blocked." });
    }
    config = getX402Configuration();
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Invalid payment configuration." });
    }
    if (!config) return reply.code(503).send({ error: "Hedera testnet payer is not configured." });

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
    if (!feePayer) return reply.code(503).send({ error: "Facilitator does not advertise an exact Hedera fee payer." });

    const requirements = makeRequirements(config.receiverAccountId, feePayer, service);
    const challenge = {
      x402Version: 2,
      resource: {
        url: service.path,
        description: service.description,
        mimeType: "application/json",
        serviceName: "heder1",
      },
      accepts: [requirements],
      extensions: {},
    };
    const paymentHeader = request.headers["payment-signature"] ?? request.headers["x-payment"];
    if (typeof paymentHeader !== "string" || !paymentHeader) {
      const encoded = Buffer.from(JSON.stringify(challenge)).toString("base64");
      return reply.code(402).header("payment-required", encoded).header("cache-control", "no-store").send(challenge);
    }

    let paymentPayload: JsonRecord;
    try {
      paymentPayload = decodePaymentHeader(paymentHeader);
      const accepted = paymentPayload.accepted as JsonRecord;
      if (accepted.amount !== requirements.amount || accepted.payTo !== requirements.payTo ||
          accepted.asset !== requirements.asset || accepted.network !== requirements.network ||
          accepted.scheme !== requirements.scheme) {
        throw new Error("Payment payload does not match this service's exact advertised requirements.");
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid payment proof." });
    }

    const key = createHash("sha256").update(service.path).update("\0").update(paymentHeader).digest("hex");
    await appendAuditEvent({ event: "payment.attempted", outcome: "started", details: { proofHash: key, service: service.resource, amountTinybars: service.amountTinybars, receiverAccountId: config.receiverAccountId, network: "hedera:testnet" } });
    try {
      const result = await settleOnce(key, paymentPayload, requirements, baseUrl, service.path);
      await appendAuditEvent({ event: "payment.settled", outcome: "settled", details: { proofHash: key, service: service.resource, transactionId: result.transaction, settledAt: result.settledAt, amountTinybars: service.amountTinybars, receiverAccountId: config.receiverAccountId, network: "hedera:testnet" } });
      return reply.header("payment-response", Buffer.from(JSON.stringify({ success: true, transaction: result.transaction, network: "hedera:testnet" })).toString("base64"))
        .header("cache-control", "no-store")
        .send({
          resource: service.resource,
          message: service.message,
          network: "hedera:testnet",
          amountTinybars: service.amountTinybars,
          amountHbar: Number(service.amountTinybars) / 100_000_000,
          payment: { status: "settled", transaction: result.transaction, settledAt: result.settledAt },
          explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(result.transaction)}`,
        });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Payment verification or settlement failed.";
      await appendAuditEvent({ event: "payment.rejected", outcome: "rejected", details: { proofHash: key, service: service.resource, reason, amountTinybars: service.amountTinybars, receiverAccountId: config.receiverAccountId, network: "hedera:testnet" } });
      request.log.error({ err: error }, "x402 paid-resource payment failed");
      return reply.code(402).send({ ...challenge, error: reason, note: "Resource withheld because successful settlement was not confirmed." });
    }
  };
}

export const handlePaidResource = makeHandler(FULL_REPORT);
export const handleShortSummaryResource = makeHandler(SHORT_SUMMARY);

export const paidResourcePolicy = {
  network: "hedera:testnet",
  asset: "HBAR",
  amountTinybars: FULL_REPORT.amountTinybars,
  amountHbar: "0.001",
  receiverAccountId: "configured-by-HEDERA_RECEIVER_ACCOUNT_ID",
  productionEnabled: false,
  replayProtection: "PostgreSQL atomic proof claims in production; in-memory idempotency is development-only",
};
