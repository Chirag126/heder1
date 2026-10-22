import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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


function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "a";
  const hex = bytes.join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/**
 * One-time, conservative import of the previous local JSON ledger. Source files
 * are never deleted. Unknown-wallet balances become global holds so a database
 * cutover cannot silently reset already reserved spending.
 */
async function importLegacyJsonLedger(): Promise<void> {
  await ensureDatabaseReady();
  const sourcePath = resolve(process.env.HEDERA_FIREWALL_LEDGER_PATH ?? "./data/spending-firewall.json");
  let rawText: string;
  try { rawText = await readFile(sourcePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const digest = createHash("sha256").update(rawText).digest("hex");
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); }
  catch { throw new Error("Legacy spending ledger is not valid JSON; database cutover is blocked to prevent lost reservations."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Legacy spending ledger is malformed; database cutover is blocked.");
  const ledger = parsed as { version?: number; entries?: Array<{day:string;reservedTinybars:number;attempts:number;updatedAt?:string}>; reservations?: Array<Record<string, unknown>> };
  if (![1,2].includes(Number(ledger.version)) || !Array.isArray(ledger.entries) || (ledger.version === 2 && !Array.isArray(ledger.reservations))) {
    throw new Error("Legacy spending ledger has an unsupported schema; database cutover is blocked.");
  }
  for (const entry of ledger.entries) {
    if (!entry || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) ||
        !Number.isSafeInteger(entry.reservedTinybars) || entry.reservedTinybars < 0 ||
        !Number.isSafeInteger(entry.attempts) || entry.attempts < 0) {
      throw new Error("Legacy spending ledger contains invalid daily totals; database cutover is blocked.");
    }
  }
  await ensureUser("legacy-unassigned");
  await withDatabaseTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`heder1-legacy-import:${sourcePath}`]);
    const already = await client.query("SELECT 1 FROM legacy_ledger_imports WHERE source_path=$1", [sourcePath]);
    if (already.rowCount) return;
    await client.query("INSERT INTO legacy_ledger_imports(source_path,content_sha256) VALUES($1,$2)", [sourcePath, digest]);
    const importedByDay = new Map<string, { reserved: number; attempts: number }>();
    if (ledger.version === 2) {
      for (const item of ledger.reservations ?? []) {
        if (typeof item.id !== "string" || typeof item.day !== "string" ||
            !Number.isSafeInteger(item.amountTinybars) || Number(item.amountTinybars) <= 0 ||
            typeof item.receiverAccountId !== "string" || typeof item.resourceUrl !== "string" ||
            typeof item.status !== "string") {
          throw new Error("Legacy reservation record is invalid; database cutover is blocked.");
        }
        const originalStatus = item.status as ReservationStatus;
        if (!["reserved","submitted","settled","rejected","failed","unknown","ambiguous"].includes(originalStatus)) {
          throw new Error("Legacy reservation status is unsupported; database cutover is blocked.");
        }
        const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
          ? item.id : stableUuid(`${sourcePath}:${item.id}`);
        const status: ReservationStatus = originalStatus === "reserved" || originalStatus === "submitted"
          ? "unknown"
          : originalStatus === "settled" && typeof item.transactionId !== "string" ? "ambiguous" : originalStatus;
        const transactionId = status === "settled" ? String(item.transactionId) : (typeof item.transactionId === "string" ? item.transactionId : null);
        await client.query(
          `INSERT INTO payment_reservations(id,wallet_address,day,amount_tinybars,receiver_account_id,resource_url,task_id,status,transaction_id,note,created_at,updated_at)
           VALUES($1::uuid,'legacy-unassigned',$2::date,$3,$4,$5,NULL,$6,$7,$8,COALESCE($9::timestamptz,now()),now())
           ON CONFLICT(id) DO NOTHING`,
          [id, item.day, Number(item.amountTinybars), item.receiverAccountId, item.resourceUrl, status, transactionId, "Imported from local JSON ledger; wallet attribution is unknown. Reconcile before releasing.", typeof item.createdAt === "string" ? item.createdAt : null],
        );
        const entry = importedByDay.get(item.day) ?? { reserved: 0, attempts: 0 };
        if (!["failed","rejected"].includes(status)) entry.reserved += Number(item.amountTinybars);
        entry.attempts += 1;
        importedByDay.set(item.day, entry);
      }
    }
    for (const entry of ledger.entries) {
      const imported = importedByDay.get(entry.day) ?? { reserved: 0, attempts: 0 };
      const extraReserved = Math.max(0, entry.reservedTinybars - imported.reserved);
      const extraAttempts = Math.max(0, entry.attempts - imported.attempts);
      if (extraReserved > 0 || extraAttempts > 0) {
        await client.query(
          "INSERT INTO legacy_spending_holds(source_path,day,reserved_tinybars,attempts) VALUES($1,$2::date,$3,$4)",
          [sourcePath, entry.day, extraReserved, extraAttempts],
        );
      }
    }
  });
}

export async function reservePostgresSpend(input: {
  amountTinybars: number; receiverAccountId: string; resourceUrl: string; accountId?: string;
}, options: { now?: Date; dailyBudgetTinybars: number; maxAttemptsPerDay: number; taskId?: string; taskBudgetTinybars?: number; maxPaidCallsPerTask?: number }) {
  await importLegacyJsonLedger();
  const wallet = await ensureUser(input.accountId ?? "legacy-unassigned");
  const now = options.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  return withDatabaseTransaction(async client => {
    // Serializes spend decisions per wallet/day across processes and hosts.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`heder1-spend:${wallet}:${day}`]);
    const daily = await client.query(
      `SELECT
         ((SELECT COALESCE(SUM(amount_tinybars),0) FROM payment_reservations
            WHERE wallet_address IN ($1,'legacy-unassigned') AND day=$2::date AND status NOT IN ('failed','rejected'))
          + (SELECT COALESCE(SUM(reserved_tinybars),0) FROM legacy_spending_holds WHERE day=$2::date))::text AS reserved,
         ((SELECT COUNT(*) FROM payment_reservations WHERE wallet_address IN ($1,'legacy-unassigned') AND day=$2::date)
          + (SELECT COALESCE(SUM(attempts),0) FROM legacy_spending_holds WHERE day=$2::date))::integer AS attempts`,
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
  await importLegacyJsonLedger();
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
  await importLegacyJsonLedger();
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

/** Recovery sweep: stale in-flight states become unknown, never automatically retried or released. */
export async function recoverStalePostgresPayments(staleAfterMs = 120_000): Promise<{ reservationsMarkedUnknown: number; tasksMarkedUnknown: number; proofsMarkedUnknown: number }> {
  await importLegacyJsonLedger();
  const minutes = Math.max(1, Math.ceil(staleAfterMs / 60_000));
  return withDatabaseTransaction(async client => {
    const reservations = await client.query(
      `UPDATE payment_reservations
       SET status='unknown', note='Recovery sweep found a stale in-flight state; verify Mirror Node/HashScan before reconciliation.', updated_at=now()
       WHERE status IN ('reserved','submitted') AND updated_at < now() - ($1 * interval '1 minute')
       RETURNING id`,
      [minutes],
    );
    const tasks = await client.query(
      `UPDATE task_runs
       SET status='unknown', error_code='stale_run_requires_reconciliation', updated_at=now()
       WHERE status IN ('reserved','submitted') AND updated_at < now() - ($1 * interval '1 minute')
       RETURNING run_id`,
      [minutes],
    );
    const proofs = await client.query(
      `UPDATE payment_proofs
       SET status='unknown', error_code='stale_facilitator_call_requires_reconciliation', updated_at=now()
       WHERE status='processing' AND updated_at < now() - ($1 * interval '1 minute')
       RETURNING proof_hash`,
      [minutes],
    );
    return { reservationsMarkedUnknown: reservations.rowCount ?? 0, tasksMarkedUnknown: tasks.rowCount ?? 0, proofsMarkedUnknown: proofs.rowCount ?? 0 };
  });
}
