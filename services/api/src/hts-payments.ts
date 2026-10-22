export type HtsPaymentCapability = {
  tokenId: string; symbol: string; decimals: number; network: "hedera:testnet";
  enabled: boolean; executable: boolean; reason: string;
};

/** HBAR remains the only executable x402 asset until the exact token settlement path is verified. */
export function getHtsPaymentCapabilities(): HtsPaymentCapability[] {
  const configured = (process.env.HEDERA_X402_HTS_TOKENS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return configured.map((tokenId) => ({
    tokenId, symbol: "HTS token (verify symbol and Testnet token ID)", decimals: 6,
    network: "hedera:testnet" as const, enabled: false, executable: false,
    reason: "Discovery only. The current Heder1 x402 payment path is HBAR-only; token execution is disabled until the installed scheme and facilitator pass token-specific verify/settle tests.",
  }));
}
