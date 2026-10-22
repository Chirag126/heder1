import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { getX402Configuration } from "./x402.js";
import { reserveAgentSpend } from "./spending-firewall.js";

const DEFAULT_RESOURCE_URL = "http://127.0.0.1:4000/api/x402/paid-resource";
const RESOURCE_PATH = "/api/x402/paid-resource";
const EXPECTED_RESOURCE_ID = "heder1-demo-report";
const MAX_AMOUNT_TINYBARS = 100_000;

type JsonRecord = Record<string, unknown>;

export type AgentPolicyDecision =
  | { allowed: true; reason: "approved-resource"; url: string; maxAmountTinybars: string }
  | { allowed: false; reason: string };

export type SettlementReceipt = {
  transactionId: string;
  settledAt?: string;
  resource: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A successful HTTP status alone is not proof that an x402 resource was paid.
 * The heder1 demo resource must include its explicit settlement receipt.
 */
export function extractSettlementReceipt(status: number, body: unknown): SettlementReceipt {
  if (status < 200 || status >= 300) {
    throw new Error(`Paid resource returned HTTP ${status}; no successful resource delivery is claimed.`);
  }
  if (!isRecord(body) || !isRecord(body.payment)) {
    throw new Error("Resource response did not include a verifiable settlement receipt.");
  }
  const payment = body.payment;
  if (payment.status !== "settled" || typeof payment.transaction !== "string" || !payment.transaction.trim()) {
    throw new Error("Resource response did not confirm settlement with a transaction ID.");
  }
  if (body.resource !== EXPECTED_RESOURCE_ID) {
    throw new Error("Settlement receipt did not identify the expected protected resource.");
  }
  return {
    transactionId: payment.transaction.trim(),
    ...(typeof payment.settledAt === "string" ? { settledAt: payment.settledAt } : {}),
    resource: body.resource,
  };
}

export function evaluateAgentTarget(rawUrl: string): AgentPolicyDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Target must be a valid URL." };
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) ||
      url.pathname !== RESOURCE_PATH || url.search || url.hash || url.username || url.password) {
    return {
      allowed: false,
      reason: "Phase 2 only permits the exact local paid-resource endpoint; remote targets are blocked.",
    };
  }

  return {
    allowed: true,
    reason: "approved-resource",
    url: url.toString(),
    maxAmountTinybars: String(MAX_AMOUNT_TINYBARS),
  };
}

export function isAgentEnabled(): boolean {
  return process.env.HEDERA_AGENT_ENABLED === "true" &&
    process.env.NODE_ENV !== "production" &&
    process.env.HEDERA_NETWORK === "testnet";
}

/**
 * Runs one bounded autonomous task. The agent discovers the configured local
 * resource, evaluates it against a strict allowlist, then lets x402 handle the
 * 402 challenge/retry. The x402 client's policy is the final spending boundary.
 */
export async function runPaymentAgent(accountId?: string) {
  if (!isAgentEnabled()) {
    throw new Error("Agent is disabled. Set HEDERA_AGENT_ENABLED=true for local Hedera testnet development only.");
  }

  const config = getX402Configuration();
  if (!config) {
    throw new Error("Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env.");
  }

  const requestedUrl = process.env.HEDERA_X402_PAID_RESOURCE_URL ?? DEFAULT_RESOURCE_URL;
  const decision = evaluateAgentTarget(requestedUrl);
  if (!decision.allowed) throw new Error(decision.reason);

  const reservation = await reserveAgentSpend({
    amountTinybars: decision.maxAmountTinybars,
    receiverAccountId: config.receiverAccountId,
    resourceUrl: decision.url,
  }, { accountId });
  if (!reservation.allowed) throw new Error(reservation.reason);

  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromStringECDSA(config.privateKey),
    { network: config.network },
  );
  const client = new x402Client()
    .register("hedera:*", new ExactHederaScheme(signer))
    // The installed Hedera scheme requires this preliminary gate; the strict
    // policy below remains the actual authorization boundary.
    .setSpendControls({ allowedAssets: true })
    .registerPolicy((_version, accepts) =>
      accepts.filter((item) =>
        item.network === "hedera:testnet" &&
        item.scheme === "exact" &&
        item.asset === "0.0.0" &&
        item.payTo === config.receiverAccountId &&
        item.amount === decision.maxAmountTinybars
      )
    );

  const paidFetch = wrapFetchWithPayment(fetch, client);
  const response = await paidFetch(decision.url, { method: "GET", signal: AbortSignal.timeout(45_000) });
  const body: unknown = await response.json().catch(() => null);
  const receipt = extractSettlementReceipt(response.status, body);

  return {
    agent: "heder1-autonomous-payment-agent",
    decision: "approved",
    policy: {
      network: "hedera:testnet",
      receiverAccountId: config.receiverAccountId,
      maxAmountTinybars: decision.maxAmountTinybars,
      maxAmountHbar: "0.001",
      allowedResource: RESOURCE_PATH,
    },
    settlement: {
      status: "settled" as const,
      transactionId: receipt.transactionId,
      settledAt: receipt.settledAt ?? null,
      explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(receipt.transactionId)}`,
    },
    response: { status: response.status, ok: response.ok, body },
  };
}

export const paymentAgentPolicy = {
  enabledByDefault: false,
  network: "hedera:testnet",
  maxAmountTinybars: String(MAX_AMOUNT_TINYBARS),
  maxAmountHbar: "0.001",
  allowedResource: RESOURCE_PATH,
  remoteTargetsAllowed: false,
  note: "One invocation may automatically pay for the single allowlisted resource. It does not run as a background service.",
};
