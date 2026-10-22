import { randomUUID } from "node:crypto";

export type RecurringPaymentDraft = {
  id: string; serviceId: string; amountTinybars: number; interval: "daily" | "weekly" | "monthly";
  maxExecutions: number; executedCount: number; expiresAt: string; createdAt: string;
  status: "draft-awaiting-onchain-approval" | "cancelled"; network: "hedera:testnet"; asset: "0.0.0"; note: string;
};
const drafts = new Map<string, RecurringPaymentDraft>();
const ALLOWED_SERVICES = new Set(["heder1-full-report", "heder1-short-summary"]);

export function createRecurringPaymentDraft(input: {
  serviceId: string; amountTinybars: number; interval: "daily" | "weekly" | "monthly"; maxExecutions: number; expiresAt: string;
}): RecurringPaymentDraft {
  if (!ALLOWED_SERVICES.has(input.serviceId)) throw new Error("Service is not on the recurring-payment allowlist.");
  if (!Number.isSafeInteger(input.amountTinybars) || input.amountTinybars < 1 || input.amountTinybars > 100_000) throw new Error("amountTinybars must be between 1 and 100000.");
  if (!Number.isSafeInteger(input.maxExecutions) || input.maxExecutions < 1 || input.maxExecutions > 30) throw new Error("maxExecutions must be between 1 and 30.");
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 90 * 86400000) throw new Error("expiresAt must be in the future and no more than 90 days away.");
  const now = new Date().toISOString();
  const draft: RecurringPaymentDraft = {
    id: randomUUID(), serviceId: input.serviceId, amountTinybars: input.amountTinybars, interval: input.interval,
    maxExecutions: input.maxExecutions, executedCount: 0, expiresAt: new Date(expiry).toISOString(), createdAt: now,
    status: "draft-awaiting-onchain-approval", network: "hedera:testnet", asset: "0.0.0",
    note: "Draft only: no Hedera Scheduled Transaction was submitted and no payment can execute from this record.",
  };
  drafts.set(draft.id, draft);
  return { ...draft };
}
export function listRecurringPaymentDrafts(): RecurringPaymentDraft[] { return [...drafts.values()].map((draft) => ({ ...draft })); }
export function cancelRecurringPaymentDraft(id: string): RecurringPaymentDraft | undefined {
  const draft = drafts.get(id); if (!draft) return undefined; draft.status = "cancelled"; return { ...draft };
}
