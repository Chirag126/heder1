import { randomUUID } from "node:crypto";
import { ensureDatabaseReady, ensureUser, getDatabasePool, withDatabaseTransaction } from "./database.js";
import type { DurableReservation, ReservationStatus } from "./spending-ledger.js";

function mapReservation(row: Record<string, unknown>): DurableReservation {
  return {
    id: String(row.id),
    day: String(row.day).slice(0, 10),
    amountTinybars: Number(row.amount_tinybars),
    receiverAccountId: String(row.receiver_account_id),
    resourceUrl: String(row.resource_url),
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    status: String(row.status) as ReservationStatus,
    ...(row.transaction_id ? { transactionId: String(row.transaction_id) } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    ...(row.note ? { note: String(row.note) } : {}),
  };
}

export async function reservePostgresSpend(input: {
  amountTinybars: number; receiverAccountId: string; resourceUrl: string; accountId?: string;
}, options: { now?: Date; dailyBudgetTinybars: number; maxAttemptsPerDay: number; taskId?: string; taskBudgetTinybars?: number; maxPaidCallsPerTask?: number }) {
  await ensureDatabaseReady();
  const wallet = await ensureUser(input.accountId ?? "legacy-unassigned");
  const now = options.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  return withDatabaseTransaction(async client => {
    // Serializes spend decisions per wallet/day across processes and hosts.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`heder1-spend:${wallet}:${day}`]);
    const daily = await client.query(
      `SELECT COALESCE(SUM(amount_tinybars) FILTER (WHERE status NOT IN ('failed','rejected')),0)::text AS reserved,
              COUNT(*)::integer AS attempts
       FROM payment_reservations WHERE wallet_address=$1 AND day=$2::date`,
      [wallet, day],
    );
    const reservedToday = Number(daily.rows[0].reserved);
    const attemptsToday = Number(daily.rows[0].attempts);
    if (attemptsToday >= options.maxAttemptsPerDay) return { allowed: false as const, reason: "Daily payment-attempt limit reached." };
    if (reservedToday + input.amountTinybars > options.dailyBudgetTinybars) return { allowed: false as const, reason: "Daily spending budget would be exceeded." };
    if (options.taskId) {
      const task = await client.query(
        `SELECT COALESCE(SUM(amount_tinybars) FILTER (WHERE status NOT IN ('failed','rejected')),0)::text AS spent,
                COUNT(*) FILTER (WHERE status <> 'rejected')::integer AS calls
         FROM payment_reservations WHERE wallet_address=$1 AND task_id=$2::uuid`,
        [wallet, options.taskId],
      );
      if (options.taskBudgetTinybars !== undefined && Number(task.rows[0].spent) + input.amountTinybars > options.taskBudgetTinybars) {
        return { allowed: false as const, reason: "Task spending budget would be exceeded." };
      }
      if (options.maxPaidCallsPerTask !== undefined && Number(task.rows[0].calls) >= options.maxPaidCallsPerTask) {
        return { allowed: false as const, reason: "Per-task paid-call limit reached." };
      }
    }
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO payment_reservations(id,wallet_address,day,amount_tinybars,receiver_account_id,resource_url,task_id,status,created_at,updated_at)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7::uuid,'reserved',$8,$8)
       RETURNING id,day,amount_tinybars,receiver_account_id,resource_url,task_id,status,transaction_id,note,created_at,updated_at`,
      [id, wallet, day, input.amountTinybars, input.receiverAccountId, input.resourceUrl, options.taskId ?? null, now],
    );
    return {
      allowed: true as const,
      reservationId: id,
      day,
      amountTinybars: String(input.amountTinybars),
      reservedTodayTinybars: String(reservedToday + input.amountTinybars),
      attemptsToday: attemptsToday + 1,
      dailyBudgetTinybars: String(options.dailyBudgetTinybars),
      reservation: mapReservation(result.rows[0]),
    };
  });
}

export async function listPostgresReservations(options: { limit?: number } = {}) {
  await ensureDatabaseReady();
  const db = getDatabasePool()!;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const result = await db.query(
    "SELECT id,day,amount_tinybars,receiver_account_id,resource_url,task_id,status,transaction_id,note,created_at,updated_at FROM payment_reservations ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return result.rows.map((row: Record<string, unknown>) => mapReservation(row));
}

const allowedTransitions: Record<ReservationStatus, ReservationStatus[]> = {
  reserved: ["submitted","settled","rejected","failed","unknown","ambiguous"],
  submitted: ["settled","failed","unknown","ambiguous"],
  unknown: ["settled","failed","ambiguous"],
  ambiguous: ["settled","failed"],
  settled: [],
  failed: [],
  rejected: [],
};

export async function transitionPostgresReservation(input: {
  reservationId: string; status: ReservationStatus; transactionId?: string; note?: string;
}) {
  await ensureDatabaseReady();
  return withDatabaseTransaction(async client => {
    const current = await client.query(
      "SELECT id,day,amount_tinybars,receiver_account_id,resource_url,task_id,status,transaction_id,note,created_at,updated_at FROM payment_reservations WHERE id=$1::uuid FOR UPDATE",
      [input.reservationId],
    );
    if (!current.rowCount) return { updated: false as const, reason: "Reservation not found." };
    const reservation = mapReservation(current.rows[0]);
    if (reservation.status === input.status) return { updated: true as const, reservation };
    if (!allowedTransitions[reservation.status].includes(input.status)) {
      return { updated: false as const, reason: `Invalid reservation transition ${reservation.status} -> ${input.status}.` };
    }
    if (input.status === "settled" && !input.transactionId?.trim() && !reservation.transactionId) {
      return { updated: false as const, reason: "A transaction ID is required to mark a reservation settled." };
    }
    const txId = input.transactionId?.trim() ?? reservation.transactionId ?? null;
    await client.query(
      "UPDATE payment_reservations SET status=$2, transaction_id=$3, note=$4, updated_at=now() WHERE id=$1::uuid",
      [input.reservationId, input.status, txId, input.note?.slice(0,500) ?? reservation.note ?? null],
    );
    const updated = await client.query(
      "SELECT id,day,amount_tinybars,receiver_account_id,resource_url,task_id,status,transaction_id,note,created_at,updated_at FROM payment_reservations WHERE id=$1::uuid",
      [input.reservationId],
    );
    return { updated: true as const, reservation: mapReservation(updated.rows[0]) };
  });
}

export async function reconcilePostgresReservation(input: {
  reservationId: string; outcome: "settled"|"failed"|"ambiguous"; transactionId?: string; note: string;
}) {
  if (input.outcome === "ambiguous") return transitionPostgresReservation({ reservationId: input.reservationId, status: "ambiguous", transactionId: input.transactionId, note: input.note });
  return transitionPostgresReservation({ reservationId: input.reservationId, status: input.outcome, transactionId: input.transactionId, note: input.note });
}