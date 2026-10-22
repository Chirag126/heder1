import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { databaseConfigured } from "./database.js";
import { listPostgresReservations, reconcilePostgresReservation, reservePostgresSpend, transitionPostgresReservation } from "./postgres-spending-ledger.js";

export type ReservationStatus = "reserved" | "submitted" | "settled" | "rejected" | "failed" | "unknown" | "ambiguous";
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
    const raw = value as { version?: number; entries?: unknown; reservations?: unknown };
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
      if (!r || typeof r.id !== "string" || typeof r.day !== "string" || !Number.isSafeInteger(r.amountTinybars) || r.amountTinybars <= 0 || !["reserved", "submitted", "settled", "rejected", "failed", "unknown", "ambiguous"].includes(r.status)) throw new Error("Spending ledger contains invalid reservation data; payments are blocked.");
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
  amountTinybars: number; receiverAccountId: string; resourceUrl: string; accountId?: string;
}, options: { path?: string; now?: Date; dailyBudgetTinybars: number; maxAttemptsPerDay: number; taskId?: string; taskBudgetTinybars?: number; maxPaidCallsPerTask?: number }) {
  if (databaseConfigured()) return reservePostgresSpend(input, options);
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for payment reservations in production; refusing to use the local JSON ledger.");
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
  if (databaseConfigured()) return listPostgresReservations(options);
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for reservation access in production.");
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
  if (databaseConfigured()) return reconcilePostgresReservation(input);
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for reservation reconciliation in production.");
  const path = pathFor(options.path);
  const now = options.now ?? new Date();
  return withLock(path, async () => {
    const ledger = await loadLedger(path);
    const reservation = ledger.reservations.find(r => r.id === input.reservationId);
    if (!reservation) return { updated: false as const, reason: "Reservation not found." };
    if (reservation.status === "settled" || reservation.status === "failed" || reservation.status === "rejected") {
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


/** Persist a conservative lifecycle transition before/after the external facilitator call. */
export async function transitionDurableReservation(input: {
  reservationId: string;
  status: ReservationStatus;
  transactionId?: string;
  note?: string;
}, options: { path?: string; now?: Date } = {}) {
  if (databaseConfigured()) return transitionPostgresReservation(input);
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for payment-state transitions in production.");
  const path = pathFor(options.path);
  const now = options.now ?? new Date();
  const allowed: Record<ReservationStatus, ReservationStatus[]> = {
    reserved: ["submitted", "settled", "rejected", "failed", "unknown", "ambiguous"],
    submitted: ["settled", "failed", "unknown", "ambiguous"],
    unknown: ["settled", "failed", "ambiguous"],
    ambiguous: ["settled", "failed"],
    settled: [], failed: [], rejected: [],
  };
  return withLock(path, async () => {
    const ledger = await loadLedger(path);
    const reservation = ledger.reservations.find(r => r.id === input.reservationId);
    if (!reservation) return { updated: false as const, reason: "Reservation not found." };
    if (reservation.status === input.status) return { updated: true as const, reservation };
    if (!allowed[reservation.status].includes(input.status)) {
      return { updated: false as const, reason: `Invalid reservation transition ${reservation.status} -> ${input.status}.` };
    }
    if (input.status === "settled" && !input.transactionId?.trim() && !reservation.transactionId) {
      return { updated: false as const, reason: "A transaction ID is required to mark a reservation settled." };
    }
    if (input.status === "failed" || input.status === "rejected") {
      const entry = ledger.entries.find(e => e.day === reservation.day);
      if (entry && entry.reservedTinybars >= reservation.amountTinybars) {
        entry.reservedTinybars -= reservation.amountTinybars;
        entry.updatedAt = now.toISOString();
      }
    }
    reservation.status = input.status;
    if (input.transactionId?.trim()) reservation.transactionId = input.transactionId.trim();
    if (input.note) reservation.note = input.note.slice(0, 500);
    reservation.updatedAt = now.toISOString();
    await persist(path, ledger);
    return { updated: true as const, reservation };
  });
}
