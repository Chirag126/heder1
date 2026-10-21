import "dotenv/config";
import Fastify from "fastify";
import { executeTestnetDemoPayment, getX402Configuration } from "./x402.js";
import { handlePaidResource, paidResourcePolicy } from "./paid-resource.js";
import { isAgentEnabled, paymentAgentPolicy, runPaymentAgent } from "./agent.js";
import { FIREWALL_DAILY_BUDGET_TINYBARS, FIREWALL_MAX_ATTEMPTS_PER_DAY, FIREWALL_MAX_PAYMENT_TINYBARS } from "./spending-firewall.js";
import { consumeAuthorizationGrant, createAuthorizationChallenge, verifyAuthorizationChallenge } from "./authorization.js";

const app = Fastify({ logger: true, bodyLimit: 16_384 });
const port = Number(process.env.PORT ?? 4000);
// Bind to localhost by default because the opt-in demo endpoint can transfer testnet HBAR.
const host = process.env.HOST ?? "127.0.0.1";

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
  try { return createAuthorizationChallenge(request.body.account); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid wallet account." }); }
});

/** Verify an EIP-191 personal_sign signature and issue a short-lived, single-use grant. */
app.post<{ Body: { nonce?: string; signature?: string } }>("/api/authorization/verify", async (request, reply) => {
  if (typeof request.body?.nonce !== "string" || typeof request.body?.signature !== "string") {
    return reply.code(400).send({ error: "Challenge nonce and wallet signature are required." });
  }
  try { return await verifyAuthorizationChallenge({ nonce: request.body.nonce, signature: request.body.signature }); }
  catch (error) { return reply.code(401).send({ error: error instanceof Error ? error.message : "Wallet authorization failed." }); }
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
    return reply.code(401).send({ error: authorization.reason, hint: "Connect a Hedera Testnet wallet and approve one agent invocation in the dashboard." });
  }
  try {
    const result = await runPaymentAgent();
    return reply.code(result.response.status).send({ ...result, authorization: { account: authorization.account, scope: authorization.scope, consumed: true } });
  } catch (error) {
    request.log.error({ err: error }, "autonomous x402 payment agent failed");
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
void start();
