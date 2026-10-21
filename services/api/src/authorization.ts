import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";

export const AUTHORIZATION_TTL_MS = 2 * 60 * 1000;
export const AUTHORIZATION_CHAIN_ID = 296;
export const AUTHORIZATION_SCOPE = "heder1:agent-run:single-payment";

type Challenge = { account: string; nonce: string; expiresAt: number; message: string };
type Grant = { account: string; expiresAt: number; scope: typeof AUTHORIZATION_SCOPE };

const challenges = new Map<string, Challenge>();
const grants = new Map<string, Grant>();

function prune(now = Date.now()) {
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
  for (const [key, value] of grants) if (value.expiresAt <= now) grants.delete(key);
}

export function createAuthorizationChallenge(accountInput: string, now = Date.now()) {
  prune(now);
  let account: string;
  try { account = getAddress(accountInput); }
  catch { throw new Error("A valid EVM wallet address is required."); }
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = now + AUTHORIZATION_TTL_MS;
  const message = [
    "heder1 one-time payment authorization",
    "Domain: heder1 local API",
    "Network: Hedera Testnet",
    "Chain ID: 296",
    `Wallet: ${account}`,
    `Scope: ${AUTHORIZATION_SCOPE}`,
    `Maximum payment: 100000 tinybars (0.001 HBAR)`,
    "Resource: /api/x402/paid-resource",
    `Nonce: ${nonce}`,
    `Issued at: ${new Date(now).toISOString()}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,
    "This approval authorizes one agent invocation only. It does not grant private-key access.",
  ].join("\n");
  challenges.set(nonce, { account, nonce, expiresAt, message });
  return { nonce, message, expiresAt: new Date(expiresAt).toISOString(), chainId: AUTHORIZATION_CHAIN_ID, scope: AUTHORIZATION_SCOPE };
}

export async function verifyAuthorizationChallenge(input: { nonce: string; signature: string; now?: number }) {
  const now = input.now ?? Date.now();
  prune(now);
  const challenge = challenges.get(input.nonce);
  if (!challenge) throw new Error("Authorization challenge is missing, expired, or already used.");
  // Burn before cryptographic verification to prevent concurrent replay attempts.
  challenges.delete(input.nonce);
  let recovered: string;
  try { recovered = getAddress(await verifyMessage(challenge.message, input.signature)); }
  catch { throw new Error("Wallet signature is invalid."); }
  if (recovered !== challenge.account) throw new Error("Wallet signature does not match the challenged account.");
  const token = randomBytes(32).toString("base64url");
  grants.set(token, { account: challenge.account, expiresAt: now + AUTHORIZATION_TTL_MS, scope: AUTHORIZATION_SCOPE });
  return { authorizationToken: token, account: challenge.account, scope: AUTHORIZATION_SCOPE, expiresAt: new Date(now + AUTHORIZATION_TTL_MS).toISOString(), singleUse: true };
}

export function consumeAuthorizationGrant(token: string | undefined, now = Date.now()) {
  prune(now);
  if (!token) return { allowed: false as const, reason: "A wallet-signed one-time authorization is required." };
  const grant = grants.get(token);
  if (!grant) return { allowed: false as const, reason: "Authorization is invalid, expired, or already used." };
  grants.delete(token);
  if (grant.expiresAt <= now || grant.scope !== AUTHORIZATION_SCOPE) return { allowed: false as const, reason: "Authorization expired or scope is invalid." };
  return { allowed: true as const, account: grant.account, scope: grant.scope };
}
