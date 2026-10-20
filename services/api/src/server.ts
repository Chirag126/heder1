import Fastify from "fastify";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

app.get("/api/health", async () => ({
  status: "ok",
  service: "heder1-api",
  network: process.env.HEDERA_NETWORK ?? "testnet",
  note: "Foundation scaffold only; no payment has been executed.",
}));

app.get("/api", async () => ({
  name: "heder1",
  description: "Security-first autonomous x402 payments on Hedera",
  phase: "foundation",
  paymentReady: false,
}));

async function start() {
  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
