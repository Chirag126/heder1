import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";

export function getX402Configuration() {
  const accountId = process.env.HEDERA_CLIENT_ACCOUNT_ID?.trim();
  const privateKey = process.env.HEDERA_CLIENT_PRIVATE_KEY?.trim();
  const network = process.env.HEDERA_NETWORK ?? "testnet";
  if (network !== "testnet") throw new Error("Phase 1 supports Hedera testnet only.");
  if (!accountId || !privateKey) return null;
  return { network: "hedera:testnet" as const, accountId, privateKey };
}

export function createHederaX402Client() {
  const config = getX402Configuration();
  if (!config) throw new Error("Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env.");
  const signer = createClientHederaSigner(config.accountId, PrivateKey.fromStringECDSA(config.privateKey), { network: config.network });
  return new x402Client().register("hedera:*", new ExactHederaScheme(signer));
}
