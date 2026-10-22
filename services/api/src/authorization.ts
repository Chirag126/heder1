import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { DEFAULT_USER_SPENDING_POLICY, validateUserSpendingPolicy, type UserSpendingPolicy } from "./spending-policy.js";
import { consumeGrantRecord, databaseConfigured, revokeGrantRecord, saveChallengeRecord, savePolicyVersion, saveGrantRecord, takeChallengeRecord } from "./database.js";

export const AUTHORIZATION_TTL_MS = 2 * 60 * 1000;
export const AUTHORIZATION_CHAIN_ID = 296;
export const AUTHORIZATION_SCOPE = "heder1:agent-run:single-payment";
export const AUTHORIZATION_SCOPE_V2 = "heder1:agent-v2:bounded-task";
type AuthorizationScope = typeof AUTHORIZATION_SCOPE | typeof AUTHORIZATION_SCOPE_V2;

type Challenge = { account: string; nonce: string; expiresAt: number; message: string; scope: AuthorizationScope; policy: UserSpendingPolicy };
type Grant = { account: string; expiresAt: number; scope: AuthorizationScope; policy: UserSpendingPolicy };

const challenges = new Map<string, Challenge>();
const grants = new Map<string, Grant>();

function prune(now = Date.now()) {
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
  for (const [key, value] of grants) if (value.expiresAt <= now) grants.delete(key);
}

export async function createAuthorizationChallenge(
  accountInput: string,
  now = Date.now(),
  requestedScope: string = AUTHORIZATION_SCOPE,
  requestedPolicy?: UserSpendingPolicy,
) {
  prune(now);
  let account: string;
  try { account = getAddress(accountInput); }
  catch { throw new Error("A valid EVM wallet address is required."); }
  if (requestedScope !== AUTHORIZATION_SCOPE && requestedScope !== AUTHORIZATION_SCOPE_V2) {
    throw new Error("Requested authorization scope is not supported.");
  }
  const scope = requestedScope as AuthorizationScope;
  const expiresAt = now + AUTHORIZATION_TTL_MS;
  const policy: UserSpendingPolicy = { ...DEFAULT_USER_SPENDING_POLICY, ...requestedPolicy, expiresAt: Math.min(requestedPolicy?.expiresAt ?? expiresAt, expiresAt) };
  const policyErrors = validateUserSpendingPolicy(policy);
  if (policyErrors.length) throw new Error(policyErrors.join(" "));
  const nonce = randomBytes(32).toString("hex");
  const phaseTwo = scope === AUTHORIZATION_SCOPE_V2;
  const message = [
    phaseTwo ? "heder1 bounded autonomous agent v2 authorization" : "heder1 one-time payment authorization",
    "Domain: heder1 local API",
    "Network: Hedera Testnet",
    "Chain ID: 296",
    `Wallet: ${account}`,
    `Scope: ${scope}`,
    phaseTwo ? "Maximum task budget: 500000 tinybars (0.005 HBAR)" : "Maximum payment: 100000 tinybars (0.001 HBAR)",
    phaseTwo ? "Maximum single payment: 100000 tinybars (0.001 HBAR)" : "Resource: /api/x402/paid-resource",
    phaseTwo ? "Resources: explicitly registered heder1 testnet services only" : "",
    `Nonce: ${nonce}`,
    `Issued at: ${new Date(now).toISOString()}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,
    `User spending policy: ${JSON.stringify(policy)}`,
    "This approval authorizes one agent invocation only. It does not grant private-key access.",
  ].filter(Boolean).join("\n");
  const challenge: Challenge = { account, nonce, expiresAt, message, scope, policy };
  if (databaseConfigured()) {
    await savePolicyVersion(account, policy);
    await saveChallengeRecord("authorization", nonce, account, challenge, expiresAt);
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable authorization state in production.");
    challenges.set(nonce, challenge);
  }
  return { nonce, message, expiresAt: new Date(expiresAt).toISOString(), chainId: AUTHORIZATION_CHAIN_ID, scope };
}

export async function verifyAuthorizationChallenge(input: { nonce: string; signature: string; now?: number }) {
  const now = input.now ?? Date.now();
  prune(now);
  const challenge = databaseConfigured()
    ? await takeChallengeRecord<Challenge>("authorization", input.nonce)
    : challenges.get(input.nonce);
  if (!challenge) throw new Error("Authorization challenge is missing, expired, or already used.");
  if (!databaseConfigured()) challenges.delete(input.nonce);
  let recovered: string;
  try { recovered = getAddress(await verifyMessage(challenge.message, input.signature)); }
  catch { throw new Error("Wallet signature is invalid."); }
  if (recovered !== challenge.account) throw new Error("Wallet signature does not match the challenged account.");
  const token = randomBytes(32).toString("base64url");
  const grant: Grant = { account: challenge.account, expiresAt: Math.min(now + AUTHORIZATION_TTL_MS, challenge.expiresAt), scope: challenge.scope, policy: challenge.policy };
  if (databaseConfigured()) await saveGrantRecord("authorization", token, grant.account, grant, grant.expiresAt);
  else {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable authorization state in production.");
    grants.set(token, grant);
  }
  return { authorizationToken: token, account: challenge.account, scope: challenge.scope, policy: challenge.policy, expiresAt: new Date(grant.expiresAt).toISOString(), singleUse: true };
}

/** The caller must specify the scope it intends to consume; scopes cannot cross endpoints. */
export async function consumeAuthorizationGrant(
  token: string | undefined,
  now = Date.now(),
  expectedScope: AuthorizationScope = AUTHORIZATION_SCOPE,
) {
  prune(now);
  if (!token) return { allowed: false as const, reason: "A wallet-signed one-time authorization is required." };
  const grant = databaseConfigured()
    ? await consumeGrantRecord<Grant>("authorization", token, expectedScope)
    : grants.get(token);
  if (!grant) return { allowed: false as const, reason: "Authorization is invalid, expired, or already used." };
  if (grant.expiresAt <= now) {
    grants.delete(token);
    return { allowed: false as const, reason: "Authorization expired or scope is invalid for this endpoint." };
  }
  if (grant.scope !== expectedScope) {
    return { allowed: false as const, reason: "Authorization expired or scope is invalid for this endpoint." };
  }
  if (!databaseConfigured()) grants.delete(token);
  return { allowed: true as const, account: grant.account, scope: grant.scope, policy: grant.policy };
}

/** Revoke an unconsumed single-use grant. Consumed grants are no longer reusable; active runs use the cancellation endpoint. */
export async function revokeAuthorizationGrant(token: string | undefined) {
  if (!token) return { revoked: false as const, reason: "Authorization token is required." };
  const revoked = databaseConfigured() ? await revokeGrantRecord("authorization", token) : grants.delete(token);
  if (!databaseConfigured() && process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable authorization state in production.");
  return revoked ? { revoked: true as const } : { revoked: false as const, reason: "Grant is invalid, expired, already consumed, or already revoked." };
}
