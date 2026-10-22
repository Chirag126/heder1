/**
 * Phase 15: bounded, read-only Hedera Testnet account context.
 *
 * This adapter deliberately uses the fixed public Mirror Node REST API instead
 * of transaction-capable Agent Kit plugins or a general-purpose MCP client.
 * It accepts account IDs only, never arbitrary URLs, credentials, or signing
 * requests. x402 payment execution remains in the existing deterministic runner.
 */
export const HEDERA_TESTNET_MIRROR_NODE = "https://testnet.mirrornode.hedera.com/api/v1";

export type HederaAccountSnapshot = {
  network: "hedera:testnet";
  accountId: string;
  balanceTinybars: string;
  evmAddress: string | null;
  deleted: boolean;
  expiryTime: string | null;
  source: "hedera-testnet-mirror-node";
  readOnly: true;
};

type MirrorAccount = {
  account?: unknown;
  balance?: { balance?: unknown };
  evm_address?: unknown;
  deleted?: unknown;
  expiration_timestamp?: unknown;
};

export type ReadonlyToolOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function getTestnetAccountSnapshot(
  accountId: string,
  options: ReadonlyToolOptions = {},
): Promise<HederaAccountSnapshot> {
  if (!/^0\\.0\\.[1-9]\\d{0,19}$/.test(accountId)) {
    throw new Error("accountId must be a Hedera account ID in 0.0.x format.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("timeoutMs must be an integer between 100 and 10000.");
  }

  const url = `${HEDERA_TESTNET_MIRROR_NODE}/accounts/${encodeURIComponent(accountId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("Hedera Testnet account query failed or timed out.");
  }
  if (response.status === 404) throw new Error("Hedera Testnet account was not found.");
  if (!response.ok) throw new Error(`Hedera Testnet Mirror Node returned HTTP ${response.status}.`);

  let payload: MirrorAccount;
  try {
    payload = await response.json() as MirrorAccount;
  } catch {
    throw new Error("Hedera Testnet Mirror Node returned invalid JSON.");
  }
  const balance = payload.balance?.balance;
  if (payload.account !== accountId || !Number.isSafeInteger(balance) || (balance as number) < 0) {
    throw new Error("Hedera Testnet Mirror Node returned an invalid account snapshot.");
  }
  const evmAddress = typeof payload.evm_address === "string" && /^0x[0-9a-fA-F]{40}$/.test(payload.evm_address)
    ? payload.evm_address
    : null;
  const expiryTime = typeof payload.expiration_timestamp === "string" && /^\\d+(?:\\.\\d+)?$/.test(payload.expiration_timestamp)
    ? payload.expiration_timestamp
    : null;

  return {
    network: "hedera:testnet",
    accountId,
    balanceTinybars: String(balance),
    evmAddress,
    deleted: payload.deleted === true,
    expiryTime,
    source: "hedera-testnet-mirror-node",
    readOnly: true,
  };
}
