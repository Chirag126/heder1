import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { simulateSpendingPolicy, validateUserSpendingPolicy, type UserSpendingPolicy } from "./spending-policy.js";

export type ApprovedPaymentQuote = {
  serviceId: string;
  network: string;
  asset: string;
  amountTinybars: number;
  receiverAccountId: string;
  expiresAt: number;
};
type Challenge = { account: string; nonce: string; message: string; expiresAt: number; policy: UserSpendingPolicy; quote: ApprovedPaymentQuote };
type Approval = { account: string; policy: UserSpendingPolicy; quote: ApprovedPaymentQuote; expiresAt: number };
const challenges = new Map<string, Challenge>();
const approvals = new Map<string, Approval>();

function prune(now = Date.now()) {
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
  for (const [key, value] of approvals) if (value.expiresAt <= now) approvals.delete(key);
}

/** Create a wallet message binding approval to the exact policy and exact quote. */
export function createPaymentApprovalChallenge(input: {
  account: string; policy: UserSpendingPolicy;
  quote: Omit<ApprovedPaymentQuote, "expiresAt">; now?: number;
}) {
  const now = input.now ?? Date.now();
  prune(now);
  let account: string;
  try { account = getAddress(input.account); } catch { throw new Error("A valid EVM wallet address is required."); }
  const errors = validateUserSpendingPolicy(input.policy);
  if (errors.length) throw new Error(errors.join(" "));
  if (input.policy.mode === "preview") throw new Error("Preview mode cannot approve or execute payments.");
  if (input.policy.expiresAt <= now) throw new Error("Spending policy has expired.");
  if (!input.policy.allowedServiceIds.includes(input.quote.serviceId)) throw new Error("Service is outside the signed service allowlist.");
  const quote: ApprovedPaymentQuote = { ...input.quote, expiresAt: Math.min(input.policy.expiresAt, now + 120_000) };
  const checkPolicy: UserSpendingPolicy = {
    ...input.policy,
    mode: "autonomous",
    approvalThresholdTinybars: Math.max(input.policy.approvalThresholdTinybars, quote.amountTinybars),
  };
  const decision = simulateSpendingPolicy(checkPolicy, {
    serviceId: quote.serviceId, network: quote.network, asset: quote.asset,
    amountTinybars: quote.amountTinybars, now,
  });
  if (!decision.allowed) throw new Error(decision.reason);
  const nonce = randomBytes(32).toString("hex");
  const message = [
    "heder1 explicit payment approval",
    "Network: Hedera Testnet",
    `Wallet: ${account}`,
    `Service ID: ${quote.serviceId}`,
    `Network: ${quote.network}`,
    `Asset: ${quote.asset}`,
    `Amount: ${quote.amountTinybars} tinybars`,
    `Receiver: ${quote.receiverAccountId}`,
    `Policy: ${JSON.stringify(input.policy)}`,
    `Nonce: ${nonce}`,
    `Expires at: ${new Date(quote.expiresAt).toISOString()}`,
    "This signature approves only the exact quote above. It is not a transaction signature and cannot change the quote.",
  ].join("\n");
  challenges.set(nonce, { account, nonce, message, expiresAt: quote.expiresAt, policy: input.policy, quote });
  return { nonce, message, account, quote, expiresAt: new Date(quote.expiresAt).toISOString() };
}

export async function verifyPaymentApproval(input: { nonce: string; signature: string; now?: number }) {
  const now = input.now ?? Date.now();
  prune(now);
  const challenge = challenges.get(input.nonce);
  if (!challenge) throw new Error("Payment approval challenge is missing, expired, or already used.");
  challenges.delete(input.nonce);
  let recovered: string;
  try { recovered = getAddress(await verifyMessage(challenge.message, input.signature)); }
  catch { throw new Error("Payment approval signature is invalid."); }
  if (recovered !== challenge.account) throw new Error("Payment approval signature does not match the challenged wallet.");
  const token = randomBytes(32).toString("base64url");
  approvals.set(token, { account: challenge.account, policy: challenge.policy, quote: challenge.quote, expiresAt: challenge.quote.expiresAt });
  return { approvalToken: token, account: challenge.account, policy: challenge.policy, quote: challenge.quote, expiresAt: new Date(challenge.quote.expiresAt).toISOString(), singleUse: true };
}

/** Consume once; runner must still rediscover and exactly match the quote before signing. */
export function consumePaymentApproval(token: string | undefined, now = Date.now()) {
  prune(now);
  if (!token) return { allowed: false as const, reason: "A wallet-signed quote-specific approval is required." };
  const approval = approvals.get(token);
  if (!approval) return { allowed: false as const, reason: "Payment approval is invalid, expired, or already used." };
  approvals.delete(token);
  if (approval.expiresAt <= now) return { allowed: false as const, reason: "Payment approval expired." };
  return { allowed: true as const, ...approval };
}
