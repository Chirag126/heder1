import Fastify from "fastify";
import { executeTestnetDemoPayment, getX402Configuration } from "./x402.js";
import { handlePaidResource, paidResourcePolicy } from "./paid-resource.js";
import { isAgentEnabled, paymentAgentPolicy, runPaymentAgent } from "./agent.js";
import { FIREWALL_DAILY_BUDGET_TINYBARS, FIREWALL_MAX_ATTEMPTS_PER_DAY, FIREWALL_MAX_PAYMENT_TINYBARS } from "./spending-firewall.js";
import { consumeAuthorizationGrant, createAuthorizationChallenge, verifyAuthorizationChallenge } from "./authorization.js";
import { appendAuditEvent, listAuditRecords, verifyAuditTrail } from "./audit-trail.js";
import { listHcsAnchors, verifyHcsAnchor } from "./hcs-audit.js";

export const app = Fastify({ logger: true, bodyLimit: 16_384 });
const port = Number(process.env.PORT ?? 4000);
// Public hosts must bind to all interfaces; local payment testing stays loopback-only.
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const configuredOrigins = (process.env.HEDERA_CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\\/$/, ""))
  .filter(Boolean);
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]),
]);

// Exact-origin CORS allowlist. Never reflect arbitrary Origin values or enable credentials.
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (origin) {
    const normalizedOrigin = origin.replace(/\\/$/, "");
    if (!allowedOrigins.has(normalizedOrigin)) {
      return reply.code(403).send({ error: "Origin is not allowed by the API CORS policy." });
    }
    reply.header("Access-Control-Allow-Origin", normalizedOrigin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "content-type, x-heder1-authorization, payment-signature");
    reply.header("Access-Control-Max-Age", "600");
  }
  if (request.method === "OPTIONS") return reply.code(204).send();
});

app.get("/api/health", async () => ({ status: "ok", service: "heder1-api", network: process.env.HEDERA_NETWORK ?? "testnet", phase: "x402-paid-resource" }));

app.get("/api", async () => ({
  name: "heder1",
  description: "Security-first autonomous x402 payments on Hedera",
  phase: "autonomous-payment-agent",
  paymentReady: Boolean(getX402Configuration()),
  paymentExecutionEnabled: process.env.HEDERA_X402_DEMO_ENABLED === "true" && process.env.NODE_ENV !== "production",
  note: "Paid-resource endpoint is testnet-only, fixed-price, and settles through the configured facilitator."
}));

app.get("/api/x402/status", async (_request, reply) => {
  try {
    const config = getX402Configuration();
    return {
      network: "hedera:testnet",
      sdkConfigured: Boolean(config),
      accountId: config?.accountId ?? null,
      receiverAccountId: config?.receiverAccountId ?? null,
      facilitatorUrl: config?.facilitatorUrl ?? null,
      paymentExecutionEnabled: process.env.HEDERA_X402_DEMO_ENABLED === "true" && process.env.NODE_ENV !== "production",
      readyForPaymentTest: Boolean(config),
      paidResourcePolicy: { ...paidResourcePolicy, receiverAccountId: config?.receiverAccountId ?? null },
      reason: config
        ? "Payer, receiver, and facilitator configuration are available. The paid-resource route is available for local testnet testing."
        : "Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env."
    };
  } catch (error) {
    reply.code(400);
    return { network: process.env.HEDERA_NETWORK ?? "testnet", sdkConfigured: false, readyForPaymentTest: false, paymentExecutionEnabled: false, reason: error instanceof Error ? error.message : "Invalid x402 configuration." };
  }
});

/**
 * Merchant resource. Requests without a proof receive HTTP 402 and the exact
 * fixed-price requirements. The resource is returned only after facilitator
 * verification and settlement both succeed.
 */
app.get("/api/x402/paid-resource", handlePaidResource);


/** Create a short-lived wallet-signing challenge. This endpoint never requests a transaction. */
app.post<{ Body: { account?: string; chainId?: number } }>("/api/authorization/challenge", async (request, reply) => {
  if (request.body?.chainId !== 296) return reply.code(400).send({ error: "Hedera Testnet (chain ID 296) is required." });
  if (typeof request.body?.account !== "string") return reply.code(400).send({ error: "Wallet account is required." });
  try {
    const challenge = createAuthorizationChallenge(request.body.account);
    await appendAuditEvent({ event: "authorization.challenge_issued", outcome: "accepted", details: { account: request.body.account, chainId: 296, nonce: challenge.nonce, expiresAt: challenge.expiresAt } });
    return challenge;
  } catch (error) {
    await appendAuditEvent({ event: "authorization.rejected", outcome: "rejected", details: { stage: "challenge", reason: error instanceof Error ? error.message : "Invalid wallet account." } });
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid wallet account." });
  }
});

/** Verify an EIP-191 personal_sign signature and issue a short-lived, single-use grant. */
app.post<{ Body: { nonce?: string; signature?: string } }>("/api/authorization/verify", async (request, reply) => {
  if (typeof request.body?.nonce !== "string" || typeof request.body?.signature !== "string") {
    return reply.code(400).send({ error: "Challenge nonce and wallet signature are required." });
  }
  try {
    const grant = await verifyAuthorizationChallenge({ nonce: request.body.nonce, signature: request.body.signature });
    await appendAuditEvent({ event: "authorization.grant_issued", outcome: "accepted", details: { account: grant.account, scope: grant.scope, expiresAt: grant.expiresAt, singleUse: true } });
    return grant;
  } catch (error) {
    await appendAuditEvent({ event: "authorization.rejected", outcome: "rejected", details: { stage: "signature-verification", reason: error instanceof Error ? error.message : "Wallet authorization failed." } });
    return reply.code(401).send({ error: error instanceof Error ? error.message : "Wallet authorization failed." });
  }
});

/** Local audit integrity summary; does not expose payment proofs or wallet signatures. */
app.get("/api/audit/status", async (_request, reply) => {
  try {
    const verification = await verifyAuditTrail();
    if (!verification.valid) return reply.code(500).send({ ...verification, ledger: "local-jsonl-hash-chain", independentlyAnchored: false });
    return { ...verification, ledger: "local-jsonl-hash-chain", independentlyAnchored: false, note: "Local hash-chain validation only. This is not an HCS anchor or proof against deletion by the host." };
  } catch (error) {
    return reply.code(500).send({ valid: false, error: error instanceof Error ? error.message : "Could not verify audit trail." });
  }
});

/** Sanitized, bounded audit history for the product dashboard. */
app.get<{ Querystring: { limit?: string } }>("/api/audit/records", async (request, reply) => {
  const requested = Number(request.query.limit ?? 25);
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    return reply.code(400).send({ error: "limit must be an integer from 1 to 100." });
  }
  try {
    const records = await listAuditRecords(requested);
    return { records };
  } catch (error) {
    return reply.code(500).send({
      error: error instanceof Error ? error.message : "Could not read audit history.",
    });
  }
});

/** Return locally indexed HCS references so callers can independently open Mirror Node evidence. */
app.get("/api/audit/anchors", async (_request, reply) => {
  try {
    const anchors = await listHcsAnchors();
    return { enabled: process.env.HEDERA_AUDIT_HCS_ENABLED === "true", anchors };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not read HCS anchor index." });
  }
});

/** Verify an audit-record hash against a specific public Hedera Testnet HCS message. */
app.get<{ Querystring: { topicId?: string; sequenceNumber?: string; auditHash?: string } }>("/api/audit/verify-hcs", async (request, reply) => {
  const sequenceNumber = Number(request.query.sequenceNumber);
  try {
    const result = await verifyHcsAnchor({
      topicId: request.query.topicId ?? "",
      sequenceNumber,
      expectedAuditHash: request.query.auditHash ?? "",
    });
    return reply.code(result.valid ? 200 : 404).send(result);
  } catch (error) {
    return reply.code(400).send({ valid: false, error: error instanceof Error ? error.message : "HCS verification failed." });
  }
});

/** Phase 2 agent status: reports policy/config only; never initiates a payment. */
app.get("/api/agent/status", async () => ({
  enabled: isAgentEnabled(),
  policy: paymentAgentPolicy,
  targetConfigured: Boolean(process.env.HEDERA_X402_PAID_RESOURCE_URL),
  spendingFirewall: {
    maxPaymentTinybars: String(FIREWALL_MAX_PAYMENT_TINYBARS),
    dailyBudgetTinybars: String(FIREWALL_DAILY_BUDGET_TINYBARS),
    maxAttemptsPerUtcDay: FIREWALL_MAX_ATTEMPTS_PER_DAY,
    ledger: "persistent-local-json",
    multiInstanceSafe: false,
  },
}));

/**
 * Runs one bounded agent task. It may make one 0.001 HBAR testnet payment
 * to the allowlisted local paid-resource endpoint. Disabled by default.
 */
app.post("/api/agent/run", async (request, reply) => {
  if (!isAgentEnabled()) {
    return reply.code(403).send({
      error: "Autonomous payment agent is disabled.",
      hint: "For local testnet development only, set HEDERA_AGENT_ENABLED=true and HEDERA_NETWORK=testnet.",
    });
  }
  const token = request.headers["x-heder1-authorization"];
  const authorization = consumeAuthorizationGrant(typeof token === "string" ? token : undefined);
  if (!authorization.allowed) {
    await appendAuditEvent({ event: "agent.authorization_rejected", outcome: "rejected", details: { reason: authorization.reason } });
    return reply.code(401).send({ error: authorization.reason, hint: "Connect a Hedera Testnet wallet and approve one agent invocation in the dashboard." });
  }
  await appendAuditEvent({ event: "agent.run_started", outcome: "started", details: { account: authorization.account, scope: authorization.scope } });
  try {
    const result = await runPaymentAgent();
    await appendAuditEvent({ event: "agent.run_finished", outcome: result.response.ok ? "accepted" : "failed", details: { account: authorization.account, scope: authorization.scope, httpStatus: result.response.status, decision: result.decision } });
    return reply.code(result.response.status).send({ ...result, authorization: { account: authorization.account, scope: authorization.scope, consumed: true } });
  } catch (error) {
    request.log.error({ err: error }, "autonomous x402 payment agent failed");
    await appendAuditEvent({ event: "agent.run_finished", outcome: "failed", details: { account: authorization.account, error: error instanceof Error ? error.message : "Agent task failed." } });
    return reply.code(502).send({
      agent: "heder1-autonomous-payment-agent",
      decision: "rejected-or-failed",
      error: error instanceof Error ? error.message : "Agent task failed.",
      note: "No successful payment is claimed unless the response contains a settlement transaction ID.",
    });
  }
});

/**
 * Explicit local testnet payment. This endpoint can transfer 0.001 HBAR from
 * the configured payer. It is disabled by default and refuses production mode.
 */
app.post<{ Body: { confirmPayment?: boolean } }>("/api/x402/demo-payment", async (request, reply) => {
  if (process.env.NODE_ENV === "production" || process.env.HEDERA_X402_DEMO_ENABLED !== "true") {
    return reply.code(403).send({
      error: "Demo payment endpoint is disabled.",
      hint: "For local testnet testing only, set HEDERA_X402_DEMO_ENABLED=true and do not expose this API publicly."
    });
  }
  if (request.body?.confirmPayment !== true) {
    return reply.code(400).send({
      error: "Explicit confirmation required.",
      amountHbar: "0.001",
      receiverAccountId: process.env.HEDERA_RECEIVER_ACCOUNT_ID?.trim() || "0.0.11044329",
      hint: "POST { \"confirmPayment\": true } only when you intend to send this testnet payment."
    });
  }

  try {
    const result = await executeTestnetDemoPayment();
    return reply.code(200).send({
      status: "settled",
      ...result,
      explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(result.transaction)}`,
      note: "Facilitator reported successful settlement and returned a transaction ID. Verify it on HashScan."
    });
  } catch (error) {
    request.log.error({ err: error }, "x402 testnet demo payment failed");
    return reply.code(502).send({
      status: "failed",
      error: error instanceof Error ? error.message : "Payment attempt failed.",
      paymentExecutionEnabled: true,
      note: "No successful settlement is claimed. Check the facilitator response and testnet account funding."
    });
  }
});

async function start() {
  try { await app.listen({ port, host }); }
  catch (error) { app.log.error(error); process.exit(1); }
}
// Export the Fastify instance for safe in-process integration tests.
if (process.env.NODE_ENV !== "test") void start();
