import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ReservationStatus = "reserved" | "settled" | "failed" | "ambiguous";
export type DurableReservation = {
  id: string;
  day: string;
  amountTinybars: number;
  receiverAccountId: string;
  resourceUrl: string;
  taskId?: string;
  status: ReservationStatus;
  transactionId?: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
};
type DayEntry = { day: string; reservedTinybars: number; attempts: number; updatedAt: string };
type Ledger = { version: 2; entries: DayEntry[]; reservations: DurableReservation[] };

function pathFor(path?: string) {
  return resolve(path ?? process.env.HEDERA_FIREWALL_LEDGER_PATH ?? "./data/spending-firewall.json");
}
function dayOf(now: Date) { return now.toISOString().slice(0, 10); }
async function loadLedger(path: string): Promise<Ledger> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") throw new Error("Spending ledger is malformed; payments are blocked.");
    const raw = value as Partial<Ledger> & { version?: number };
    if (raw.version === 1 && Array.isArray(raw.entries)) {
      // Preserve every legacy reservation as a conservative, unreconciled balance.
      const entries = raw.entries as DayEntry[];
      for (const e of entries) if (!e || typeof e.day !== "string" || !Number.isSafeInteger(e.reservedTinybars) || e.reservedTinybars < 0 || !Number.isSafeInteger(e.attempts) || e.attempts < 0) throw new Error("Legacy spending ledger is invalid; payments are blocked.");
      const reservations: DurableReservation[] = entries.filter(e => e.reservedTinybars > 0).map(e => ({
        id: `legacy-${e.day}`, day: e.day, amountTinybars: e.reservedTinybars,
        receiverAccountId: "unknown", resourceUrl: "legacy",
        status: "ambiguous", createdAt: e.updatedAt, updatedAt: e.updatedAt,
        note: "Migrated aggregate from version 1; manually reconcile before releasing.",
      }));
      return { version: 2, entries, reservations };
    }
    if (raw.version !== 2 || !Array.isArray(raw.entries) || !Array.isArray(raw.reservations)) throw new Error("Spending ledger has an unsupported format; payments are blocked.");
    for (const r of raw.reservations) {
      if (!r || typeof r.id !== "string" || typeof r.day !== "string" || !Number.isSafeInteger(r.amountTinybars) || r.amountTinybars <= 0 || !["reserved", "settled", "failed", "ambiguous"].includes(r.status)) throw new Error("Spending ledger contains invalid reservation data; payments are blocked.");
    }
    return raw as Ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, entries: [], reservations: [] };
    throw error;
  }
}
async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  let acquired = false;
  for (let i = 0; i < 250; i++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  }
  if (!acquired) throw new Error("Could not acquire spending-ledger lock; refusing payment to avoid concurrent overspend.");
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
async function persist(path: string, ledger: Ledger) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(ledger, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, path);
}

export async function reserveDurableSpend(input: {
  amountTinybars: number; receiverAccountId: string; resourceUrl: string;
}, options: { path?: string; now?: Date; dailyBudgetTinybars: number; maxAttemptsPerDay: number; taskId?: string; taskBudgetTinybars?: number; maxPaidCallsPerTask?: number }) {
  const path = pathFor(options.path);
  const now = options.now ?? new Date();
  const day = dayOf(now);
  return withLock(path, async () => {
    const ledger = await loadLedger(path);
    const today = ledger.entries.find(e => e.day === day) ?? { day, reservedTinybars: 0, attempts: 0, updatedAt: now.toISOString() };
    if (today.attempts >= options.maxAttemptsPerDay) return { allowed: false as const, reason: "Daily payment-attempt limit reached." };
    if (today.reservedTinybars + input.amountTinybars > options.dailyBudgetTinybars) return { allowed: false as const, reason: "Daily spending budget would be exceeded." };
    const taskReservations = options.taskId ? ledger.reservations.filter(r => r.taskId === options.taskId && r.status !== "failed") : [];
    const taskSpent = taskReservations.reduce((sum, r) => sum + r.amountTinybars, 0);
    if (options.taskBudgetTinybars !== undefined && taskSpent + input.amountTinybars > options.taskBudgetTinybars) return { allowed: false as const, reason: "Task spending budget would be exceeded." };
    if (options.maxPaidCallsPerTask !== undefined && taskReservations.length >= options.maxPaidCallsPerTask) return { allowed: false as const, reason: "Per-task paid-call limit reached." };
    const reservation: DurableReservation = {
      id: randomUUID(), day, amountTinybars: input.amountTinybars,
      receiverAccountId: input.receiverAccountId, resourceUrl: input.resourceUrl,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      status: "reserved", createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    today.reservedTinybars += input.amountTinybars;
    today.attempts += 1;
    today.updatedAt = now.toISOString();
    ledger.entries = [...ledger.entries.filter(e => e.day !== day), today];
    ledger.reservations.push(reservation);
    await persist(path, ledger);
    return { allowed: true as const, reservationId: reservation.id, day, amountTinybars: String(input.amountTinybars), reservedTodayTinybars: String(today.reservedTinybars), attemptsToday: today.attempts, dailyBudgetTinybars: String(options.dailyBudgetTinybars) };
  });
}

export async function listDurableReservations(options: { path?: string; limit?: number } = {}) {
  const path = pathFor(options.path);
  return withLock(path, async () => {
    const ledger = await loadLedger(path);
    return ledger.reservations.slice(-Math.max(1, Math.min(options.limit ?? 100, 500))).reverse();
  });
}

/** Only an operator-confirmed failed settlement releases budget. Ambiguous stays reserved. */
export async function reconcileDurableReservation(input: {
  reservationId: string; outcome: "settled" | "failed" | "ambiguous";
  transactionId?: string; note: string;
}, options: { path?: string; now?: Date } = {}) {
  const path = pathFor(options.path);
  const now = options.now ?? new Date();
  return withLock(path, async () => {
    const ledger = await loadLedger(path);
    const reservation = ledger.reservations.find(r => r.id === input.reservationId);
    if (!reservation) return { updated: false as const, reason: "Reservation not found." };
    if (reservation.status === "settled" || reservation.status === "failed") {
      if (reservation.status === input.outcome) return { updated: true as const, reservation };
      return { updated: false as const, reason: "Terminal reservation status cannot be changed." };
    }
    if (input.outcome === "settled" && !input.transactionId?.trim()) return { updated: false as const, reason: "A transaction ID is required to mark a reservation settled." };
    if (input.outcome === "failed") {
      const entry = ledger.entries.find(e => e.day === reservation.day);
      if (!entry || entry.reservedTinybars < reservation.amountTinybars) throw new Error("Ledger balance mismatch; refusing to release reservation.");
      entry.reservedTinybars -= reservation.amountTinybars;
      entry.updatedAt = now.toISOString();
    }
    reservation.status = input.outcome;
    reservation.transactionId = input.transactionId?.trim();
    reservation.note = input.note.slice(0, 500);
    reservation.updatedAt = now.toISOString();
    await persist(path, ledger);
    return { updated: true as const, reservation };
  });
}
