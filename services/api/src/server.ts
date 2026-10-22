import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { executeTestnetDemoPayment, getX402Configuration } from "./x402.js";
import { handlePaidResource, handleShortSummaryResource, paidResourcePolicy } from "./paid-resource.js";
import { isAgentEnabled, paymentAgentPolicy, runPaymentAgent } from "./agent.js";
import { agentV2Policy, getApprovedServiceRegistry } from "./agent-v2.js";
import { isAgentV2Enabled, previewAgentV2Plan, runAgentV2Task, type AgentV2TaskInput } from "./agent-v2-runner.js";
import { FIREWALL_DAILY_BUDGET_TINYBARS, FIREWALL_MAX_ATTEMPTS_PER_DAY, FIREWALL_MAX_PAYMENT_TINYBARS } from "./spending-firewall.js";
import { listDurableReservations, reconcileDurableReservation, recoverStaleDurableReservations } from "./spending-ledger.js";
import { consumePaymentApproval, createPaymentApprovalChallenge, verifyPaymentApproval, type ApprovedPaymentQuote } from "./payment-approval.js";
import { AUTHORIZATION_SCOPE_V2, consumeAuthorizationGrant, createAuthorizationChallenge, revokeAuthorizationGrant, verifyAuthorizationChallenge } from "./authorization.js";
import { appendAuditEvent, listAuditRecords, verifyAuditTrail } from "./audit-trail.js";
import { listHcsAnchors, verifyHcsAnchor } from "./hcs-audit.js";
import { DEFAULT_USER_SPENDING_POLICY, simulateSpendingPolicy, validateUserSpendingPolicy, type UserSpendingPolicy } from "./spending-policy.js";
import { claimTaskRun, consumeRateLimit, databaseConfigured, updateTaskRun } from "./database.js";

export const app = Fastify({
  logger: {
    redact: {
      paths: [
        "req.headers.authorization", "req.headers.cookie",
        "req.headers.x-heder1-authorization", "req.headers.x-heder1-payment-approval",
        "req.headers.x-heder1-reconciliation-token", "req.headers.payment-signature",
      ],
      censor: "[REDACTED]",
    },
  },
  bodyLimit: 16_384,
});
const port = Number(process.env.PORT ?? 4000);
// Public hosts must bind to all interfaces; local payment testing stays loopback-only.
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const configuredOrigins = (process.env.HEDERA_CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]),
]);


const userSpendingPolicyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode","network","maxPaymentTinybars","taskBudgetTinybars","dailyBudgetTinybars","maxPaidCallsPerTask","maxPaidCallsPerDay","allowedServiceIds","allowedAssets","expiresAt","approvalThresholdTinybars"],
  properties: {
    mode: { type: "string", enum: ["preview","autonomous","approval-required"] },
    network: { type: "string", const: "hedera:testnet" },
    maxPaymentTinybars: { type: "integer", minimum: 1, maximum: 100000 },
    taskBudgetTinybars: { type: "integer", minimum: 1, maximum: 500000 },
    dailyBudgetTinybars: { type: "integer", minimum: 1, maximum: 1000000 },
    maxPaidCallsPerTask: { type: "integer", minimum: 1, maximum: 3 },
    maxPaidCallsPerDay: { type: "integer", minimum: 1, maximum: 10 },
    allowedServiceIds: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["heder1-full-report","heder1-short-summary"] } },
    allowedAssets: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", const: "0.0.0" } },
    expiresAt: { type: "integer", minimum: 1 },
    approvalThresholdTinybars: { type: "integer", minimum: 0, maximum: 100000 },
  },
} as const;


// Exact-origin CORS allowlist. Never reflect arbitrary Origin values or enable credentials.
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (origin) {
    const normalizedOrigin = origin.replace(/\/$/, "");
    if (!allowedOrigins.has(normalizedOrigin)) {
      return reply.code(403).send({ error: "Origin is not allowed by the API CORS policy." });
    }
    reply.header("Access-Control-Allow-Origin", normalizedOrigin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "content-type, x-heder1-authorization, x-heder1-payment-approval, x-heder1-reconciliation-token, payment-signature");
    reply.header("Access-Control-Max-Age", "600");
  }
  if (request.method === "OPTIONS") return reply.code(204).send();
});

const localRateBuckets = new Map<string, { start: number; count: number }>();
app.addHook("onRequest", async (request, reply) => {
  if (request.method === "OPTIONS" || request.url.startsWith("/api/health")) return;
  const path = request.url.split("?")[0] ?? "/";
  const sensitive = path.startsWith("/api/authorization/") || path.startsWith("/api/agent/v2/approval/");
  const limit = sensitive ? 10 : request.method === "POST" ? 30 : 120;
  const windowMs = 60_000;
  const key = `${request.ip}:${path}`;
  try {
    let result: { allowed: boolean; remaining: number; retryAfterSeconds: number };
    if (databaseConfigured()) {
      result = await consumeRateLimit(key, limit, windowMs);
    } else {
      const now = Date.now();
      const current = localRateBuckets.get(key);
      const bucket = !current || now - current.start >= windowMs ? { start: now, count: 0 } : current;
      bucket.count += 1;
      localRateBuckets.set(key, bucket);
      result = { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000)) };
    }
    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      reply.header("Retry-After", String(result.retryAfterSeconds));
      return reply.code(429).send({ error: "API rate limit exceeded. Retry after the indicated delay." });
    }
  } catch {
    // If shared rate-limit storage is configured but unavailable, fail closed.
    if (databaseConfigured()) return reply.code(503).send({ error: "Shared API rate limiter is unavailable; request blocked." });
  }
});

app.get("/api/health", async () => ({
  status: "ok",
  service: "heder1-api",
  network: process.env.HEDERA_NETWORK ?? "testnet",
  phase: "phase-12-durable-payment-infrastructure",
  storage: databaseConfigured() ? "postgresql-configured" : process.env.NODE_ENV === "production" ? "postgresql-missing" : "local-development-only",
}));

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
app.get("/api/x402/summary", handleShortSummaryResource);


/** Create a short-lived wallet-signing challenge. This endpoint never requests a transaction. */
app.post<{ Body: { account?: string; chainId?: number; scope?: string; policy?: UserSpendingPolicy } }>("/api/authorization/challenge", {
  schema: { body: {
    type: "object", additionalProperties: false, required: ["account","chainId"],
    properties: {
      account: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      chainId: { type: "integer", const: 296 },
      scope: { type: "string", enum: [AUTHORIZATION_SCOPE_V2, "heder1:agent-run:single-payment"] },
      policy: userSpendingPolicyJsonSchema,
    },
  } },
}, async (request, reply) => {
  if (request.body?.chainId !== 296) return reply.code(400).send({ error: "Hedera Testnet (chain ID 296) is required." });
  if (typeof request.body?.account !== "string") return reply.code(400).send({ error: "Wallet account is required." });
  try {
    const challenge = await createAuthorizationChallenge(request.body.account, Date.now(), request.body.scope, request.body.policy);
    await appendAuditEvent({ event: "authorization.challenge_issued", outcome: "accepted", details: { account: request.body.account, chainId: 296, nonce: challenge.nonce, expiresAt: challenge.expiresAt } });
    return challenge;
  } catch (error) {
    await appendAuditEvent({ event: "authorization.rejected", outcome: "rejected", details: { stage: "challenge", reason: error instanceof Error ? error.message : "Invalid wallet account." } });
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid wallet account." });
  }
});

/** Verify an EIP-191 personal_sign signature and issue a short-lived, single-use grant. */
app.post<{ Body: { nonce?: string; signature?: string } }>("/api/authorization/verify", {
  schema: { body: { type: "object", additionalProperties: false, required: ["nonce","signature"], properties: {
    nonce: { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" },
    signature: { type: "string", minLength: 130, maxLength: 132, pattern: "^0x[0-9a-fA-F]+$" },
  } } },
}, async (request, reply) => {
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

/** Revoke a short-lived grant that has not yet been consumed. Never log the token. */
app.post<{ Body: { authorizationToken?: string } }>("/api/authorization/revoke", async (request, reply) => {
  const result = await revokeAuthorizationGrant(request.body?.authorizationToken);
  if (!result.revoked) return reply.code(404).send(result);
  await appendAuditEvent({ event: "authorization.rejected", outcome: "accepted", details: { action: "grant_revoked", revoked: true } });
  return { revoked: true };
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
    ledger: databaseConfigured() ? "postgresql-transactional" : "local-json-development-only",
    multiInstanceSafe: databaseConfigured(),
  },
}));


// Phase 10 cancellation is process-local and run IDs are unguessable UUIDs.
// Restarting the API cancels all in-flight work.
const agentV2Runs = new Map<string, AbortController>();
const agentV2CompletedRuns = new Set<string>();

app.get("/api/agent/v2/policy", async () => ({
  killSwitchEnabled: process.env.HEDERA_AGENT_KILL_SWITCH === "true",
  policy: { ...DEFAULT_USER_SPENDING_POLICY, expiresAt: Date.now() + 120_000 },
  hardCeilings: { maxPaymentTinybars: 100_000, taskBudgetTinybars: 500_000, dailyBudgetTinybars: 1_000_000, maxPaidCallsPerTask: 3, maxPaidCallsPerDay: 10 },
  supportedModes: ["preview", "autonomous", "approval-required"],
  network: "hedera:testnet",
  mainnetEnabled: false,
}));

type PolicySimulationBody = {
  policy?: UserSpendingPolicy;
  quote?: {
    serviceId?: string;
    network?: string;
    asset?: string;
    amountTinybars?: number;
    taskSpentTinybars?: number;
    dailyReservedTinybars?: number;
    paidCallsThisTask?: number;
    paidCallsToday?: number;
    now?: number;
  };
};

app.post<{ Body: PolicySimulationBody }>("/api/agent/v2/policy/simulate", async (request, reply) => {
  const policy = request.body?.policy;
  const quote = request.body?.quote;
  if (!policy || !quote || typeof quote.serviceId !== "string" || typeof quote.network !== "string" || typeof quote.asset !== "string" || typeof quote.amountTinybars !== "number") {
    return reply.code(400).send({ allowed: false, reason: "A complete policy and quote (serviceId, network, asset, amountTinybars) are required." });
  }
  const errors = validateUserSpendingPolicy(policy);
  if (errors.length) return reply.code(400).send({ allowed: false, reason: errors.join(" ") });
  return simulateSpendingPolicy(policy, {
    serviceId: quote.serviceId,
    network: quote.network,
    asset: quote.asset,
    amountTinybars: quote.amountTinybars,
    taskSpentTinybars: quote.taskSpentTinybars,
    dailyReservedTinybars: quote.dailyReservedTinybars,
    paidCallsThisTask: quote.paidCallsThisTask,
    paidCallsToday: quote.paidCallsToday,
    now: quote.now,
  });
});

app.get("/api/agent/v2/status", async () => ({
  enabled: isAgentV2Enabled(),
  policy: agentV2Policy,
  registrySize: getApprovedServiceRegistry().length,
  execution: "deterministic-local-testnet-only",
  paymentExecutionEnabled: isAgentV2Enabled() && process.env.NODE_ENV !== "production",
}));

app.get("/api/agent/v2/services", async () => ({
  services: getApprovedServiceRegistry().map((service) => ({
    id: service.id,
    url: service.url,
    description: service.description,
    networks: service.networks,
    assetTypes: service.assetTypes,
    trust: service.trust,
    allowed: service.allowed,
    priceMetadata: service.priceMetadata,
  })),
  note: "Price metadata is informational only. The runner inspects each service's actual HTTP 402 requirements before selecting.",
}));

type PreviewPlanBody = { goal?: string; policy?: UserSpendingPolicy; budgetTinybars?: number };
app.post<{ Body: PreviewPlanBody }>("/api/agent/v2/plan", async (request, reply) => {
  const body = request.body;
  if (typeof body?.goal !== "string" || !body.goal.trim() || body.goal.length > 2_000) return reply.code(400).send({ error: "goal is required and must be at most 2000 characters." });
  if (body.budgetTinybars !== undefined && (typeof body.budgetTinybars !== "number" || !Number.isSafeInteger(body.budgetTinybars) || body.budgetTinybars <= 0)) return reply.code(400).send({ error: "budgetTinybars must be a positive safe integer." });
  const policy = body.policy ?? { ...DEFAULT_USER_SPENDING_POLICY, mode: "preview" as const, expiresAt: Date.now() + 120_000 };
  try { return await previewAgentV2Plan({ goal: body.goal, policy, budgetTinybars: body.budgetTinybars }); }
  catch (error) { return reply.code(400).send({ paymentAttempted: false, error: error instanceof Error ? error.message : "Could not create a preview plan." }); }
});

type PaymentApprovalChallengeBody = {
  account?: string;
  policy?: UserSpendingPolicy;
  quote?: { serviceId?: string; network?: string; asset?: string; amountTinybars?: number; receiverAccountId?: string };
};
app.post<{ Body: PaymentApprovalChallengeBody }>("/api/agent/v2/approval/challenge", {
  schema: { body: { type: "object", additionalProperties: false, required: ["account","policy","quote"], properties: {
    account: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    policy: userSpendingPolicyJsonSchema,
    quote: { type: "object", additionalProperties: false, required: ["serviceId","network","asset","amountTinybars","receiverAccountId"], properties: {
      serviceId: { type: "string", enum: ["heder1-full-report","heder1-short-summary"] },
      network: { type: "string", const: "hedera:testnet" },
      asset: { type: "string", const: "0.0.0" },
      amountTinybars: { type: "integer", minimum: 1, maximum: 100000 },
      receiverAccountId: { type: "string", pattern: "^0\\.0\\.\\d+$" },
    } },
  } } },
}, async (request, reply) => {
  const body = request.body;
  const q = body?.quote;
  if (typeof body?.account !== "string" || !body.policy || !q ||
      typeof q.serviceId !== "string" || typeof q.network !== "string" ||
      typeof q.asset !== "string" || typeof q.amountTinybars !== "number" ||
      typeof q.receiverAccountId !== "string") {
    return reply.code(400).send({ error: "account, policy, and exact quote fields are required." });
  }
  try {
    const challenge = await createPaymentApprovalChallenge({
      account: body.account,
      policy: body.policy,
      quote: { serviceId: q.serviceId, network: q.network, asset: q.asset, amountTinybars: q.amountTinybars, receiverAccountId: q.receiverAccountId },
    });
    await appendAuditEvent({ event: "authorization.challenge_issued", outcome: "accepted", details: { action: "payment_approval_challenge", account: challenge.account, serviceId: q.serviceId, amountTinybars: q.amountTinybars, expiresAt: challenge.expiresAt } });
    return challenge;
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not create payment approval challenge." }); }
});

app.post<{ Body: { nonce?: string; signature?: string } }>("/api/agent/v2/approval/verify", {
  schema: { body: { type: "object", additionalProperties: false, required: ["nonce","signature"], properties: {
    nonce: { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" },
    signature: { type: "string", minLength: 130, maxLength: 132, pattern: "^0x[0-9a-fA-F]+$" },
  } } },
}, async (request, reply) => {
  if (typeof request.body?.nonce !== "string" || typeof request.body?.signature !== "string") return reply.code(400).send({ error: "nonce and wallet signature are required." });
  try {
    const approval = await verifyPaymentApproval({ nonce: request.body.nonce, signature: request.body.signature });
    await appendAuditEvent({ event: "authorization.grant_issued", outcome: "accepted", details: { action: "quote_specific_payment_approval", account: approval.account, serviceId: approval.quote.serviceId, amountTinybars: approval.quote.amountTinybars, expiresAt: approval.expiresAt, singleUse: true } });
    return approval;
  } catch (error) { return reply.code(401).send({ error: error instanceof Error ? error.message : "Payment approval verification failed." }); }
});

type ReconciliationBody = { reservationId?: string; outcome?: "settled" | "failed" | "ambiguous"; transactionId?: string; note?: string };
function reconciliationAuthorized(token: unknown): boolean {
  const expected = process.env.HEDERA_RECONCILIATION_TOKEN;
  if (!expected || typeof token !== "string") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Operator-only reservation ledger view. Requires HEDERA_RECONCILIATION_TOKEN. */
app.get<{ Querystring: { limit?: string } }>("/api/agent/v2/reservations", async (request, reply) => {
  if (!reconciliationAuthorized(request.headers["x-heder1-reconciliation-token"])) return reply.code(403).send({ error: "Reservation ledger access is not configured or authorized." });
  const limit = Number(request.query.limit ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return reply.code(400).send({ error: "limit must be an integer from 1 to 500." });
  try { return { reservations: await listDurableReservations({ limit }) }; }
  catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not read reservation ledger." }); }
});

/**
 * Operator-confirmed reconciliation only. Verify HashScan/Mirror Node evidence first.
 * An ambiguous outcome never releases reserved budget; only a confirmed failure does.
 */
app.post<{ Body: ReconciliationBody }>("/api/agent/v2/reservations/reconcile", {
  schema: { body: { type: "object", additionalProperties: false, required: ["reservationId","outcome","note"], properties: {
    reservationId: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9-]+$" },
    outcome: { type: "string", enum: ["settled","failed","ambiguous"] },
    transactionId: { type: "string", maxLength: 200 },
    note: { type: "string", minLength: 1, maxLength: 500 },
  } } },
}, async (request, reply) => {
  if (!reconciliationAuthorized(request.headers["x-heder1-reconciliation-token"])) return reply.code(403).send({ error: "Reservation reconciliation is not configured or authorized." });
  const body = request.body;
  if (typeof body?.reservationId !== "string" || !["settled", "failed", "ambiguous"].includes(String(body.outcome)) || typeof body.note !== "string" || !body.note.trim()) {
    return reply.code(400).send({ updated: false, error: "reservationId, outcome (settled|failed|ambiguous), and an operator note are required." });
  }
  if (body.note.length > 500) return reply.code(400).send({ updated: false, error: "note must be at most 500 characters." });
  try {
    const result = await reconcileDurableReservation({
      reservationId: body.reservationId,
      outcome: body.outcome as "settled" | "failed" | "ambiguous",
      transactionId: body.transactionId,
      note: body.note,
    });
    if (!result.updated) return reply.code(409).send(result);
    await appendAuditEvent({ event: "agent.run_finished", outcome: body.outcome === "failed" ? "failed" : "accepted", details: { phase: "11", action: "reservation_reconciled", reservationId: body.reservationId, outcome: body.outcome ?? "ambiguous", transactionId: body.transactionId ?? null } });
    return result;
  } catch (error) { return reply.code(500).send({ updated: false, error: error instanceof Error ? error.message : "Could not reconcile reservation." }); }
});

app.post<{ Body: AgentV2TaskInput & { runId?: string } }>("/api/agent/v2/run", {
  schema: { body: { type: "object", additionalProperties: false, required: ["runId","goal"], properties: {
    runId: { type: "string", format: "uuid" },
    goal: { type: "string", minLength: 1, maxLength: 2000 },
    budgetTinybars: { type: "integer", minimum: 1, maximum: 500000 },
    maxPaidCalls: { type: "integer", minimum: 1, maximum: 3 },
    allowedServiceIds: { type: "array", maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["heder1-full-report","heder1-short-summary"] } },
  } } },
}, async (request, reply) => {
  if (!isAgentV2Enabled()) {
    return reply.code(403).send({ error: "Agent v2 is disabled.", hint: "For local testnet testing only, set HEDERA_AGENT_V2_ENABLED=true and HEDERA_NETWORK=testnet. Never enable payment execution on public Render." });
  }
  const input = request.body ?? ({} as AgentV2TaskInput & { runId?: string });
  const runId = input.runId;
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) return reply.code(400).send({ error: "A client-generated UUID runId is required so the task can be cancelled while active." });
  if (agentV2Runs.has(runId) || agentV2CompletedRuns.has(runId)) return reply.code(409).send({ error: "That runId has already been used." });
  if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 2000) return reply.code(400).send({ error: "goal is required and must be at most 2000 characters." });
  if (input.budgetTinybars !== undefined && typeof input.budgetTinybars !== "number") return reply.code(400).send({ error: "budgetTinybars must be a number." });
  if (input.maxPaidCalls !== undefined && typeof input.maxPaidCalls !== "number") return reply.code(400).send({ error: "maxPaidCalls must be a number." });
  if (input.allowedServiceIds !== undefined && (!Array.isArray(input.allowedServiceIds) || !input.allowedServiceIds.every((id) => typeof id === "string"))) return reply.code(400).send({ error: "allowedServiceIds must be an array of registered service IDs." });
  const token = request.headers["x-heder1-authorization"];
  const approvalHeader = request.headers["x-heder1-payment-approval"];
  let approvedQuote: ApprovedPaymentQuote | undefined;
  let authorization: Awaited<ReturnType<typeof consumeAuthorizationGrant>>;
  if (typeof approvalHeader === "string") {
    const approved = await consumePaymentApproval(approvalHeader);
    if (!approved.allowed) authorization = approved;
    else {
      approvedQuote = approved.quote;
      authorization = { allowed: true, account: approved.account, scope: AUTHORIZATION_SCOPE_V2, policy: approved.policy };
    }
  } else {
    authorization = await consumeAuthorizationGrant(typeof token === "string" ? token : undefined, Date.now(), AUTHORIZATION_SCOPE_V2);
  }
  if (!authorization.allowed) {
    await appendAuditEvent({ event: "agent.authorization_rejected", outcome: "rejected", details: { phase: "10", reason: authorization.reason } });
    return reply.code(401).send({ error: authorization.reason, hint: "Obtain a valid wallet-signed one-time agent authorization or quote-specific payment approval first." });
  }
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const claimed = await claimTaskRun({ runId, walletAddress: authorization.account, idempotencyKey: runId, requestHash });
  if (!claimed) return reply.code(409).send({ error: "This task/run ID or idempotency key has already been used." });
  const controller = new AbortController();
  agentV2Runs.set(runId, controller);
  try {
    await updateTaskRun(runId, authorization.account, "reserved");
    await appendAuditEvent({ event: "agent.run_started", outcome: "started", details: { phase: "12", runId, account: authorization.account, scope: authorization.scope } });
    const result = await runAgentV2Task({ ...input, policy: authorization.policy }, { signal: controller.signal, runId, approvedQuote, accountId: authorization.account });
    const taskStatus = result.warnings?.length ? "unknown" : "settled";
    await updateTaskRun(runId, authorization.account, taskStatus, { paidCalls: result.expenditure.paidCalls, receipts: result.receipts.map(receipt => ({ serviceId: receipt.serviceId, transactionId: receipt.transactionId, amountTinybars: receipt.amountTinybars })), warnings: result.warnings ?? [] });
    await appendAuditEvent({ event: "agent.run_finished", outcome: "accepted", details: { phase: "12", runId, account: authorization.account, serviceId: result.selection.serviceId, paidCalls: result.expenditure.paidCalls, amountTinybars: result.expenditure.reservedTinybars, transactionId: result.receipts[0]?.transactionId ?? null } });
    return reply.code(200).send({ ...result, authorization: { account: authorization.account, scope: authorization.scope, consumed: true } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Agent v2 task failed.";
    try { await updateTaskRun(runId, authorization.account, "unknown", undefined, "payment_outcome_requires_reconciliation"); } catch { /* preserve original response; durable state remains fail-closed */ }
    await appendAuditEvent({ event: "agent.run_finished", outcome: "failed", details: { phase: "12", runId, account: authorization.account, error: reason } });
    const status = /No approved service|No registered service|budgetTinybars|maximum|allowlist|No advertised/i.test(reason) ? 422 : 502;
    return reply.code(status).send({ runId, agent: "heder1-autonomous-agent-v2", status: "stopped-safely", error: reason, paymentAttempted: /No approved service|No registered service|No advertised/i.test(reason) ? false : undefined });
  } finally {
    agentV2Runs.delete(runId);
    agentV2CompletedRuns.add(runId);
    if (agentV2CompletedRuns.size > 1000) agentV2CompletedRuns.delete(agentV2CompletedRuns.values().next().value as string);
  }
});

app.post<{ Body: { runId?: string } }>("/api/agent/v2/cancel", async (request, reply) => {
  const runId = request.body?.runId;
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) return reply.code(400).send({ cancelled: false, error: "A valid runId is required." });
  const controller = agentV2Runs.get(runId);
  if (!controller) return reply.code(404).send({ cancelled: false, error: "Run is not active or has already completed." });
  controller.abort(new Error("Cancelled by user."));
  return reply.code(202).send({ cancelled: true, runId, note: "Cancellation requested; an already submitted blockchain settlement may still complete. Check the final receipt." });
});

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
  const authorization = await consumeAuthorizationGrant(typeof token === "string" ? token : undefined);
  if (!authorization.allowed) {
    await appendAuditEvent({ event: "agent.authorization_rejected", outcome: "rejected", details: { reason: authorization.reason } });
    return reply.code(401).send({ error: authorization.reason, hint: "Connect a Hedera Testnet wallet and approve one agent invocation in the dashboard." });
  }
  await appendAuditEvent({ event: "agent.run_started", outcome: "started", details: { account: authorization.account, scope: authorization.scope } });
  try {
    const result = await runPaymentAgent(authorization.account);
    await appendAuditEvent({ event: "agent.run_finished", outcome: result.settlement.status === "settled" ? "accepted" : "failed", details: { account: authorization.account, scope: authorization.scope, httpStatus: result.response.status, decision: result.decision, settlementStatus: result.settlement.status, transactionId: result.settlement.transactionId, explorerUrl: result.settlement.explorerUrl } });
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
  try {
    if (databaseConfigured()) {
      const recovered = await recoverStaleDurableReservations(120_000);
      app.log.info({ ...recovered }, "Phase 12 startup recovery sweep completed");
      const recoveryTimer = setInterval(() => {
        void recoverStaleDurableReservations(120_000)
          .then(result => {
            if (result.reservationsMarkedUnknown || result.tasksMarkedUnknown) app.log.warn({ ...result }, "Stale payment states require reconciliation");
          })
          .catch(error => app.log.error({ err: error }, "Payment recovery sweep failed; no uncertain reservation is released"));
      }, 60_000);
      recoveryTimer.unref();
    }
    await app.listen({ port, host });
  } catch (error) { app.log.error(error); process.exit(1); }
}
// Export the Fastify instance for safe in-process integration tests.
if (process.env.NODE_ENV !== "test") void start();
