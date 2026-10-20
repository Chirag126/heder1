import "dotenv/config";
import Fastify from "fastify";
import { getX402Configuration } from "./x402.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

app.get("/api/health", async () => ({ status: "ok", service: "heder1-api", network: process.env.HEDERA_NETWORK ?? "testnet", phase: "x402-payment-proof" }));

app.get("/api", async () => ({
  name: "heder1",
  description: "Security-first autonomous x402 payments on Hedera",
  phase: "x402-payment-proof",
  paymentReady: Boolean(getX402Configuration()),
  paymentExecutionEnabled: false,
  note: "Configuration status only; this endpoint does not initiate a payment."
}));

app.get("/api/x402/status", async (_request, reply) => {
  try {
    const config = getX402Configuration();
    return {
      network: "hedera:testnet",
      sdkConfigured: Boolean(config),
      accountId: config?.accountId ?? null,
      readyForPaymentTest: false,
      reason: config ? "Credentials are configured; protected-resource handshake and settlement still need verification." : "Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env."
    };
  } catch (error) {
    reply.code(400);
    return { network: process.env.HEDERA_NETWORK ?? "testnet", sdkConfigured: false, readyForPaymentTest: false, reason: error instanceof Error ? error.message : "Invalid x402 configuration." };
  }
});

async function start() {
  try { await app.listen({ port, host }); }
  catch (error) { app.log.error(error); process.exit(1); }
}
void start();
