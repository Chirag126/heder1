import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const FIREWALL_MAX_PAYMENT_TINYBARS = 100_000;
export const FIREWALL_DAILY_BUDGET_TINYBARS = 1_000_000;
export const FIREWALL_MAX_ATTEMPTS_PER_DAY = 10;
export const FIREWALL_RESOURCE_PATH = "/api/x402/paid-resource";

type LedgerEntry = {
  day: string;
  reservedTinybars: number;
  attempts: number;
  updatedAt: string;
};

type Ledger = { version: 1; entries: LedgerEntry[] };

export type FirewallReservation = {
  allowed: true;
  day: string;
  amountTinybars: string;
  reservedTodayTinybars: string;
  attemptsToday: number;
  dailyBudgetTinybars: string;
} | {
  allowed: false;
  reason: string;
};

let writeQueue: Promise<unknown> = Promise.resolve();

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function ledgerPath(path?: string): string {
  return resolve(path ?? process.env.HEDERA_FIREWALL_LEDGER_PATH ?? "./data/spending-firewall.json");
}

async function readLedger(path: string): Promise<Ledger> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" ||
        (parsed as Ledger).version !== 1 || !Array.isArray((parsed as Ledger).entries)) {
      throw new Error("Spending firewall ledger has an invalid format; refusing payment.");
    }
    const entries = (parsed as Ledger).entries;
    for (const entry of entries) {
      if (!entry || typeof entry.day !== "string" ||
          !Number.isSafeInteger(entry.reservedTinybars) || entry.reservedTinybars < 0 ||
          !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 ||
          typeof entry.updatedAt !== "string") {
        throw new Error("Spending firewall ledger contains invalid data; refusing payment.");
      }
    }
    return parsed as Ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw error;
  }
}

/**
 * Persist a conservative reservation before any x402 client signing/payment.
 * Failed/ambiguous attempts remain counted to avoid overspending on retries.
 * The serialized queue protects concurrent calls in this Node process.
 */
export async function reserveAgentSpend(
  input: { amountTinybars: string; receiverAccountId: string; resourceUrl: string },
  options: { path?: string; now?: Date } = {},
): Promise<FirewallReservation> {
  const amount = Number(input.amountTinybars);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > FIREWALL_MAX_PAYMENT_TINYBARS) {
    return { allowed: false, reason: "Payment exceeds the per-payment spending firewall limit." };
  }

  let target: URL;
  try {
    target = new URL(input.resourceUrl);
  } catch {
    return { allowed: false, reason: "Invalid payment resource URL." };
  }
  if (target.protocol !== "http:" || target.port !== "4000" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      target.pathname !== FIREWALL_RESOURCE_PATH ||
      target.search || target.hash || target.username || target.password ||
      !/^0\.0\.\d+$/.test(input.receiverAccountId)) {
    return { allowed: false, reason: "Resource or receiver is not on the spending firewall allowlist." };
  }

  const path = ledgerPath(options.path);
  const now = options.now ?? new Date();
  const day = utcDay(now);

  let release!: () => void;
  const previous = writeQueue;
  writeQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous;

  try {
    const ledger = await readLedger(path);
    const today = ledger.entries.find((entry) => entry.day === day) ?? {
      day, reservedTinybars: 0, attempts: 0, updatedAt: now.toISOString(),
    };

    if (today.attempts >= FIREWALL_MAX_ATTEMPTS_PER_DAY) {
      return { allowed: false, reason: "Daily payment-attempt limit reached." };
    }
    if (today.reservedTinybars + amount > FIREWALL_DAILY_BUDGET_TINYBARS) {
      return { allowed: false, reason: "Daily spending budget would be exceeded." };
    }

    today.reservedTinybars += amount;
    today.attempts += 1;
    today.updatedAt = now.toISOString();
    const entries = ledger.entries.filter((entry) => entry.day !== day);
    entries.push(today);
    const updated: Ledger = { version: 1, entries };
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(updated, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);

    return {
      allowed: true,
      day,
      amountTinybars: String(amount),
      reservedTodayTinybars: String(today.reservedTinybars),
      attemptsToday: today.attempts,
      dailyBudgetTinybars: String(FIREWALL_DAILY_BUDGET_TINYBARS),
    };
  } finally {
    release();
  }
}


/**
 * Phase 10 reservation for an exact code-registered local service. The task
 * budget is checked by the runner; this shared daily ledger also enforces the
 * existing per-payment and daily aggregate limits before the SDK can sign.
 */
export async function reserveAgentV2Spend(
  input: { amountTinybars: string; receiverAccountId: string; resourceUrl: string },
  options: { path?: string; now?: Date } = {},
): Promise<FirewallReservation> {
  const amount = Number(input.amountTinybars);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > FIREWALL_MAX_PAYMENT_TINYBARS) {
    return { allowed: false, reason: "Phase 10 payment exceeds the per-payment spending firewall limit." };
  }
  let target: URL;
  try { target = new URL(input.resourceUrl); }
  catch { return { allowed: false, reason: "Invalid Phase 10 service URL." }; }
  const approvedPaths = new Set(["/api/x402/paid-resource", "/api/x402/summary"]);
  if (target.protocol !== "http:" || target.port !== "4000" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      !approvedPaths.has(target.pathname) || target.search || target.hash ||
      target.username || target.password || !/^0\.0\.\d+$/.test(input.receiverAccountId)) {
    return { allowed: false, reason: "Phase 10 service or receiver is not on the explicit spending firewall allowlist." };
  }

  const path = ledgerPath(options.path);
  const now = options.now ?? new Date();
  const day = utcDay(now);
  let release!: () => void;
  const previous = writeQueue;
  writeQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous;
  try {
    const ledger = await readLedger(path);
    const today = ledger.entries.find((entry) => entry.day === day) ?? {
      day, reservedTinybars: 0, attempts: 0, updatedAt: now.toISOString(),
    };
    if (today.attempts >= FIREWALL_MAX_ATTEMPTS_PER_DAY) return { allowed: false, reason: "Daily payment-attempt limit reached." };
    if (today.reservedTinybars + amount > FIREWALL_DAILY_BUDGET_TINYBARS) return { allowed: false, reason: "Daily spending budget would be exceeded." };
    today.reservedTinybars += amount;
    today.attempts += 1;
    today.updatedAt = now.toISOString();
    const entries = ledger.entries.filter((entry) => entry.day !== day);
    entries.push(today);
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify({ version: 1, entries } satisfies Ledger, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
    return {
      allowed: true,
      day,
      amountTinybars: String(amount),
      reservedTodayTinybars: String(today.reservedTinybars),
      attemptsToday: today.attempts,
      dailyBudgetTinybars: String(FIREWALL_DAILY_BUDGET_TINYBARS),
    };
  } finally {
    release();
  }
}
