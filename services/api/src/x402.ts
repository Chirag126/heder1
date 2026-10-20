import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";

const DEFAULT_RECEIVER_ACCOUNT_ID = "0.0.11044329";
const DEFAULT_FACILITATOR_URL = "https://api.testnet.blocky402.com";
const DEMO_AMOUNT_TINYBARS = "100000"; // 0.001 HBAR; intentionally fixed and capped.

type JsonRecord = Record<string, unknown>;

async function readJson(response: Response, label: string): Promise<JsonRecord> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} failed (HTTP ${response.status}). Check facilitator availability and configuration.`);
  }
  return value as JsonRecord;
}

export function getX402Configuration() {
  const accountId = process.env.HEDERA_CLIENT_ACCOUNT_ID?.trim();
  const privateKey = process.env.HEDERA_CLIENT_PRIVATE_KEY?.trim();
  const receiverAccountId = (process.env.HEDERA_RECEIVER_ACCOUNT_ID ?? DEFAULT_RECEIVER_ACCOUNT_ID).trim();
  const network = process.env.HEDERA_NETWORK ?? "testnet";
  const facilitatorUrl = (process.env.HEDERA_X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL).trim();

  if (network !== "testnet") throw new Error("Phase 1 supports Hedera testnet only.");
  if (!/^0\.0\.\d+$/.test(receiverAccountId)) {
    throw new Error("HEDERA_RECEIVER_ACCOUNT_ID must be a Hedera account ID such as 0.0.12345.");
  }
  if (!/^https:\/\//.test(facilitatorUrl)) {
    throw new Error("HEDERA_X402_FACILITATOR_URL must be an HTTPS URL.");
  }
  if (!accountId || !privateKey) return null;
  return { network: "hedera:testnet" as const, accountId, privateKey, receiverAccountId, facilitatorUrl };
}

export function createHederaX402Client() {
  const config = getX402Configuration();
  if (!config) throw new Error("Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env.");
  const signer = createClientHederaSigner(config.accountId, PrivateKey.fromStringECDSA(config.privateKey), { network: config.network });
  return new x402Client().register("hedera:*", new ExactHederaScheme(signer));
}

/**
 * Executes one explicitly requested, fixed-size Hedera testnet payment through a
 * facilitator. Callers must opt in with confirmPayment=true at the HTTP route.
 * Never expose this function to a public unauthenticated production endpoint.
 */
export async function executeTestnetDemoPayment() {
  const config = getX402Configuration();
  if (!config) throw new Error("Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env.");

  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromStringECDSA(config.privateKey),
    { network: config.network },
  );
  const scheme = new ExactHederaScheme(signer);
  const baseUrl = config.facilitatorUrl.replace(/\/+$/, "");

  const supportedResponse = await fetch(`${baseUrl}/supported`, { signal: AbortSignal.timeout(10_000) });
  const supported = await readJson(supportedResponse, "Facilitator supported-networks query");
  const kinds = Array.isArray(supported.kinds) ? supported.kinds as JsonRecord[] : [];
  const hederaKind = kinds.find((kind) => kind.network === "hedera:testnet" && kind.scheme === "exact");
  if (!hederaKind) throw new Error("Configured facilitator does not advertise the exact hedera:testnet scheme.");

  const kindExtra = hederaKind.extra && typeof hederaKind.extra === "object" ? hederaKind.extra as JsonRecord : {};
  const signers = supported.signers && typeof supported.signers === "object" ? supported.signers as JsonRecord : {};
  const hederaSigners = Array.isArray(signers["hedera:*"]) ? signers["hedera:*"] as unknown[] : [];
  const feePayer = typeof kindExtra.feePayer === "string" ? kindExtra.feePayer : hederaSigners.find((value): value is string => typeof value === "string");
  if (!feePayer) throw new Error("Facilitator does not advertise a Hedera fee payer; refusing to construct a payment.");

  const paymentRequirements = {
    scheme: "exact" as const,
    network: "hedera:testnet" as const,
    amount: DEMO_AMOUNT_TINYBARS,
    payTo: config.receiverAccountId,
    maxTimeoutSeconds: 300,
    asset: "0.0.0",
    extra: { feePayer },
  };

  const signed = await scheme.createPaymentPayload(2, paymentRequirements);
  const paymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: "hedera:testnet",
    accepted: paymentRequirements,
    payload: signed.payload,
  };
  const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });
  const requestOptions = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  };

  const verificationResponse = await fetch(`${baseUrl}/verify`, requestOptions);
  const verification = await readJson(verificationResponse, "Facilitator verification");
  if (verification.isValid !== true) {
    const reason = typeof verification.invalidReason === "string" ? verification.invalidReason : "Facilitator rejected the payment payload.";
    throw new Error(reason);
  }

  const settlementResponse = await fetch(`${baseUrl}/settle`, requestOptions);
  const settlement = await readJson(settlementResponse, "Facilitator settlement");
  if (settlement.success !== true) {
    const reason = typeof settlement.errorReason === "string" ? settlement.errorReason : "Facilitator did not confirm settlement.";
    throw new Error(reason);
  }

  const transaction = typeof settlement.transaction === "string" ? settlement.transaction : null;
  if (!transaction) throw new Error("Facilitator reported success without a transaction ID; refusing to report a verified payment.");

  return {
    network: "hedera:testnet",
    payerAccountId: config.accountId,
    receiverAccountId: config.receiverAccountId,
    asset: "HBAR",
    amountTinybars: DEMO_AMOUNT_TINYBARS,
    amountHbar: "0.001",
    transaction,
    facilitatorUrl: baseUrl,
  };
}
