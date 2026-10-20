import "dotenv/config";
import Fastify from "fastify";
import { executeTestnetDemoPayment, getX402Configuration } from "./x402.js";

const app = Fastify({ logger: true, bodyLimit: 16_384 });
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

app.get("/api/health", async () => ({ status: "ok", service: "heder1-api", network: process.env.HEDERA_NETWORK ?? "testnet", phase: "x402-payment-proof" }));

app.get("/api", async () => ({
  name: "heder1",
  description: "Security-first autonomous x402 payments on Hedera",
  phase: "x402-payment-proof",
  paymentReady: Boolean(getX402Configuration()),
  paymentExecutionEnabled: process.env.HEDERA_X402_DEMO_ENABLED === "true" && process.env.NODE_ENV !== "production",
  note: "Payment execution is opt-in for local testnet demos only."
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
      readyForPaymentTest: false,
      reason: config
        ? "Payer, receiver, and facilitator configuration are available. Run a small explicit testnet payment only after opting in locally."
        : "Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env."
    };
  } catch (error) {
    reply.code(400);
    return { network: process.env.HEDERA_NETWORK ?? "testnet", sdkConfigured: false, readyForPaymentTest: false, paymentExecutionEnabled: false, reason: error instanceof Error ? error.message : "Invalid x402 configuration." };
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
