import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import {
  consumeGrantRecord,
  databaseConfigured,
  saveChallengeRecord,
  saveGrantRecord,
  takeChallengeRecord,
} from "./database.js";

export const MAINNET_READINESS_SCOPE = "heder1:mainnet-readiness:quote-only";
export const HEDERA_MAINNET = "hedera:mainnet";
export const HEDERA_TESTNET = "hedera:testnet";
const DEFAULT_MIRROR_NODE = "https://mainnet.mirrornode.hedera.com";
const TTL_MS = 2 * 60 * 1000;

export type MainnetReadinessInput = {
  account: string;
  explicitOptIn: boolean;
  network: string;
  scheme: string;
  asset: string;
  assetDecimals: number;
  amount: string;
  maximumExposure: string;
  payerAccountId: string;
  destinationAccountId: string;
};

export type MainnetReadinessResult = {
  readyForReadinessApproval: boolean;
  paymentExecutionEnabled: false;
  network: typeof HEDERA_MAINNET;
  facilitatorSupportsNetwork: boolean;
  assetMetadataValidated: boolean;
  payerBalanceSufficient: boolean;
  destinationValidated: boolean;
  amount: string;
  maximumExposure: string;
  asset: string;
  assetDecimals: number;
  payerAccountId: string;
  destinationAccountId: string;
  facilitatorUrl: string;
  checks: string[];
  blockers: string[];
};

type Challenge = {
  account: string;
  nonce: string;
  message: string;
  expiresAt: number;
  quote: MainnetReadinessInput;
  result: MainnetReadinessResult;
};
type Grant = {
  account: string;
  scope: typeof MAINNET_READINESS_SCOPE;
  expiresAt: number;
  quote: MainnetReadinessInput;
  result: MainnetReadinessResult;
};

const challenges = new Map<string, Challenge>();
const grants = new Map<string, Grant>();

function prune(now = Date.now()) {
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
  for (const [key, value] of grants) if (value.expiresAt <= now) grants.delete(key);
}

function isAccountId(value: string): boolean {
  return /^0\.0\.\d+$/.test(value);
}
function isHttpsServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.hostname.endsWith(".localhost");
  } catch { return false; }
}
function positiveIntegerString(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value) && BigInt(value) > 0n;
}
function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    try { return BigInt(value); } catch { return undefined; }
  }
  return undefined;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function validateMainnetReadinessInput(input: MainnetReadinessInput, maxExposureCap = process.env.HEDERA_MAINNET_MAX_EXPOSURE_BASE_UNITS ?? "1000000"): string[] {
  const errors: string[] = [];
  if (input.explicitOptIn !== true) errors.push("Explicit mainnet opt-in is required.");
  if (input.network !== HEDERA_MAINNET) errors.push("The selected network must be exactly hedera:mainnet.");
  if (input.scheme !== "exact") errors.push("Only the x402 exact scheme is supported by this readiness gate.");
  if (!isAccountId(input.payerAccountId)) errors.push("Payer must be a Hedera account ID (0.0.x).");
  if (!isAccountId(input.destinationAccountId)) errors.push("Destination must be a Hedera account ID (0.0.x).");
  if (input.asset !== "0.0.0" && !isAccountId(input.asset)) errors.push("Asset must be HBAR (0.0.0) or a valid HTS token ID (0.0.x).");
  if (!Number.isInteger(input.assetDecimals) || input.assetDecimals < 0 || input.assetDecimals > 18) errors.push("Asset decimals must be an integer from 0 to 18.");
  if (input.asset === "0.0.0" && input.assetDecimals !== 8) errors.push("HBAR uses 8 decimals (tinybars).");
  if (!positiveIntegerString(input.amount)) errors.push("Amount must be a positive integer in the asset's smallest unit.");
  if (!positiveIntegerString(input.maximumExposure)) errors.push("Maximum exposure must be a positive integer in the asset's smallest unit.");
  if (positiveIntegerString(input.amount) && positiveIntegerString(input.maximumExposure) && BigInt(input.amount) > BigInt(input.maximumExposure)) {
    errors.push("Quoted amount exceeds the explicitly approved maximum exposure.");
  }
  if (!positiveIntegerString(maxExposureCap) || (positiveIntegerString(input.maximumExposure) && BigInt(input.maximumExposure) > BigInt(maxExposureCap))) {
    errors.push("Maximum exposure exceeds the server-configured HEDERA_MAINNET_MAX_EXPOSURE_BASE_UNITS cap.");
  }
  return errors;
}

async function jsonResponse(fetcher: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(8_000), redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = record(await response.json());
  if (!body) throw new Error("Response was not a JSON object.");
  return body;
}

/**
 * Performs read-only checks only. This function never creates or signs a Hedera transaction.
 * It checks facilitator network/scheme support, Mirror Node token metadata, account existence,
 * and the payer's current balance. Facilitator support for a network does not guarantee every
 * asset is accepted; the final live x402 quote must be revalidated before any future execution.
 */
export async function checkMainnetReadiness(
  input: MainnetReadinessInput,
  deps: { fetcher?: typeof fetch; facilitatorUrl?: string; mirrorNodeUrl?: string; maxExposureCap?: string } = {},
): Promise<MainnetReadinessResult> {
  const fetcher = deps.fetcher ?? fetch;
  const facilitatorUrl = (deps.facilitatorUrl ?? process.env.HEDERA_MAINNET_FACILITATOR_URL ?? "").replace(/\/+$/, "");
  const mirrorNodeUrl = (deps.mirrorNodeUrl ?? process.env.HEDERA_MAINNET_MIRROR_NODE_URL ?? DEFAULT_MIRROR_NODE).replace(/\/+$/, "");
  const blockers = validateMainnetReadinessInput(input, deps.maxExposureCap);
  const checks: string[] = [];
  let facilitatorSupportsNetwork = false;
  let assetMetadataValidated = false;
  let payerBalanceSufficient = false;
  let destinationValidated = false;

  if (!process.env.HEDERA_MAINNET_READINESS_ENABLED && !deps.facilitatorUrl) {
    blockers.push("Mainnet readiness checks are disabled. Set HEDERA_MAINNET_READINESS_ENABLED=true to enable read-only checks; this does not enable payments.");
  } else if (process.env.HEDERA_MAINNET_READINESS_ENABLED === "false" && !deps.facilitatorUrl) {
    blockers.push("Mainnet readiness checks are disabled.");
  }
  if (!facilitatorUrl || !isHttpsServiceUrl(facilitatorUrl)) {
    blockers.push("Configure a valid HTTPS HEDERA_MAINNET_FACILITATOR_URL.");
  }
  if (!isHttpsServiceUrl(mirrorNodeUrl)) blockers.push("Mirror Node URL must use HTTPS.");

  if (facilitatorUrl && isHttpsServiceUrl(facilitatorUrl)) {
    try {
      const supported = await jsonResponse(fetcher, `${facilitatorUrl}/supported`);
      const kinds = Array.isArray(supported.kinds) ? supported.kinds.map(record).filter(Boolean) : [];
      facilitatorSupportsNetwork = kinds.some(kind => kind?.network === HEDERA_MAINNET && kind?.scheme === input.scheme);
      if (facilitatorSupportsNetwork) checks.push("Facilitator advertises exact hedera:mainnet support.");
      else blockers.push("Selected facilitator does not advertise the exact hedera:mainnet scheme.");
    } catch {
      blockers.push("Could not verify the selected facilitator's /supported endpoint.");
    }
  }

  if (isHttpsServiceUrl(mirrorNodeUrl) && input.asset === "0.0.0" && input.assetDecimals === 8) {
    assetMetadataValidated = true;
    checks.push("HBAR unit metadata validated (8 decimals).");
  } else if (isHttpsServiceUrl(mirrorNodeUrl) && isAccountId(input.asset) && input.asset !== "0.0.0") {
    try {
      const token = await jsonResponse(fetcher, `${mirrorNodeUrl}/api/v1/tokens/${encodeURIComponent(input.asset)}`);
      assetMetadataValidated = token.token_id === input.asset &&
        token.type === "FUNGIBLE_COMMON" &&
        token.deleted !== true &&
        String(token.decimals) === String(input.assetDecimals);
      if (assetMetadataValidated) checks.push("HTS fungible token metadata and decimals match the selected asset.");
      else blockers.push("HTS token is not an active fungible token or its decimals do not match Mirror Node metadata.");
    } catch {
      blockers.push("Could not validate the HTS token metadata through Mirror Node.");
    }
  }

  if (isHttpsServiceUrl(mirrorNodeUrl) && isAccountId(input.payerAccountId)) {
    try {
      const payer = await jsonResponse(fetcher, `${mirrorNodeUrl}/api/v1/accounts/${encodeURIComponent(input.payerAccountId)}`);
      const balance = record(payer.balance);
      if (payer.account === input.payerAccountId && input.asset === "0.0.0") {
        const currentBalance = asBigInt(balance?.balance);
        payerBalanceSufficient = currentBalance !== undefined && positiveIntegerString(input.amount) && currentBalance >= BigInt(input.amount);
      } else if (payer.account === input.payerAccountId && input.asset !== "0.0.0") {
        const tokenResult = await jsonResponse(fetcher, `${mirrorNodeUrl}/api/v1/accounts/${encodeURIComponent(input.payerAccountId)}/tokens?token.id=${encodeURIComponent(input.asset)}`);
        const tokens = Array.isArray(tokenResult.tokens) ? tokenResult.tokens.map(record).filter(Boolean) : [];
        const token = tokens.find(item => item?.token_id === input.asset);
        const currentBalance = asBigInt(token?.balance);
        payerBalanceSufficient = currentBalance !== undefined && positiveIntegerString(input.amount) && currentBalance >= BigInt(input.amount);
      }
      if (payerBalanceSufficient) checks.push("Payer currently holds at least the quoted asset amount.");
      else blockers.push("Payer account does not exist or its current asset balance is insufficient.");
    } catch {
      blockers.push("Could not verify payer account and current asset balance through Mirror Node.");
    }
  }

  if (isHttpsServiceUrl(mirrorNodeUrl) && isAccountId(input.destinationAccountId)) {
    try {
      const destination = await jsonResponse(fetcher, `${mirrorNodeUrl}/api/v1/accounts/${encodeURIComponent(input.destinationAccountId)}`);
      destinationValidated = destination.account === input.destinationAccountId;
      if (destinationValidated) checks.push("Destination account exists on Hedera Mainnet.");
      else blockers.push("Destination account was not found on Hedera Mainnet.");
    } catch {
      blockers.push("Could not validate the destination account through Mirror Node.");
    }
  }

  if (!facilitatorSupportsNetwork || !assetMetadataValidated || !payerBalanceSufficient || !destinationValidated) {
    // These are required readiness checks, not optional warnings.
  }
  return {
    readyForReadinessApproval: blockers.length === 0,
    paymentExecutionEnabled: false,
    network: HEDERA_MAINNET,
    facilitatorSupportsNetwork,
    assetMetadataValidated,
    payerBalanceSufficient,
    destinationValidated,
    amount: input.amount,
    maximumExposure: input.maximumExposure,
    asset: input.asset,
    assetDecimals: input.assetDecimals,
    payerAccountId: input.payerAccountId,
    destinationAccountId: input.destinationAccountId,
    facilitatorUrl,
    checks,
    blockers,
  };
}

export async function createMainnetReadinessChallenge(input: MainnetReadinessInput, result: MainnetReadinessResult, now = Date.now()) {
  if (!result.readyForReadinessApproval) throw new Error("Mainnet readiness blockers must be resolved before requesting a wallet approval.");
  let account: string;
  try { account = getAddress(input.account); } catch { throw new Error("A valid EVM wallet address is required."); }
  const expiresAt = now + TTL_MS;
  const nonce = randomBytes(32).toString("hex");
  const message = [
    "heder1 mainnet readiness acknowledgement (NOT payment authorization)",
    "Network: hedera:mainnet",
    `Wallet: ${account}`,
    `Asset: ${input.asset}`,
    `Asset decimals: ${input.assetDecimals}`,
    `Amount (smallest unit): ${input.amount}`,
    `Maximum exposure (smallest unit): ${input.maximumExposure}`,
    `Payer: ${input.payerAccountId}`,
    `Destination: ${input.destinationAccountId}`,
    `Facilitator: ${result.facilitatorUrl}`,
    `Nonce: ${nonce}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,
    "This signature acknowledges the exact readiness review only. It does not authorize or execute a transaction.",
  ].join("\n");
  const challenge: Challenge = { account, nonce, message, expiresAt, quote: input, result };
  if (databaseConfigured()) await saveChallengeRecord("authorization", nonce, account, challenge, expiresAt);
  else {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable mainnet readiness grants in production.");
    challenges.set(nonce, challenge);
  }
  return { nonce, message, account, expiresAt: new Date(expiresAt).toISOString(), scope: MAINNET_READINESS_SCOPE };
}

export async function verifyMainnetReadinessChallenge(input: { nonce: string; signature: string; now?: number }) {
  const now = input.now ?? Date.now();
  prune(now);
  const challenge = databaseConfigured()
    ? await takeChallengeRecord<Challenge>("authorization", input.nonce)
    : challenges.get(input.nonce);
  if (!challenge || challenge.expiresAt <= now) throw new Error("Mainnet readiness challenge is missing, expired, or already used.");
  if (!databaseConfigured()) challenges.delete(input.nonce);
  let recovered: string;
  try { recovered = getAddress(await verifyMessage(challenge.message, input.signature)); }
  catch { throw new Error("Mainnet readiness signature is invalid."); }
  if (recovered !== challenge.account) throw new Error("Mainnet readiness signature does not match the challenged wallet.");
  const token = randomBytes(32).toString("base64url");
  const grant: Grant = { account: challenge.account, scope: MAINNET_READINESS_SCOPE, expiresAt: challenge.expiresAt, quote: challenge.quote, result: challenge.result };
  if (databaseConfigured()) await saveGrantRecord("authorization", token, grant.account, grant, grant.expiresAt);
  else {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable mainnet readiness grants in production.");
    grants.set(token, grant);
  }
  return { readinessGrant: token, account: grant.account, scope: grant.scope, expiresAt: new Date(grant.expiresAt).toISOString(), singleUse: true, paymentExecutionEnabled: false };
}

export async function consumeMainnetReadinessGrant(token: string | undefined, now = Date.now()) {
  prune(now);
  if (!token) return { allowed: false as const, reason: "A separate wallet-signed mainnet readiness grant is required." };
  const grant = databaseConfigured()
    ? await consumeGrantRecord<Grant>("authorization", token, MAINNET_READINESS_SCOPE)
    : grants.get(token);
  if (!grant || grant.expiresAt <= now) return { allowed: false as const, reason: "Mainnet readiness grant is invalid, expired, or already used." };
  if (!databaseConfigured()) grants.delete(token);
  if (!databaseConfigured() && process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for durable mainnet readiness grants in production.");
  return { allowed: true as const, ...grant, paymentExecutionEnabled: false as const };
}
