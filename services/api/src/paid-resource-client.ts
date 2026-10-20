import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme, createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { getX402Configuration } from "./x402.js";

const config = getX402Configuration();
if (!config) {
  throw new Error("Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env.");
}
if (process.env.HEDERA_NETWORK !== "testnet") {
  throw new Error("The paid-resource client is testnet-only.");
}

const signer = createClientHederaSigner(
  config.accountId,
  PrivateKey.fromStringECDSA(config.privateKey),
  { network: config.network },
);
const client = new x402Client()
  .register("hedera:*", new ExactHederaScheme(signer))
  .registerPolicy((_version, accepts) =>
    accepts.filter((item) =>
      item.network === "hedera:testnet" &&
      item.scheme === "exact" &&
      item.asset === "0.0.0" &&
      item.payTo === config.receiverAccountId &&
      item.amount === "100000"
    )
  );

const paidFetch = wrapFetchWithPayment(fetch, client);
const url = process.env.HEDERA_X402_PAID_RESOURCE_URL ?? "http://127.0.0.1:4000/api/x402/paid-resource";
const response = await paidFetch(url, { method: "GET", signal: AbortSignal.timeout(45_000) });
const body: unknown = await response.json().catch(() => null);
console.log(JSON.stringify({ status: response.status, ok: response.ok, body }, null, 2));
if (!response.ok) process.exitCode = 1;
