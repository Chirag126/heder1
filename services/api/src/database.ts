import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

// PostgreSQL is only needed when DATABASE_URL is configured. Loading the driver
// lazily lets local JSON-mode tests run even before optional database packages
// have been installed, while database-backed operations still fail closed.
const require = createRequire(import.meta.url);

interface QueryResult {
  rowCount: number | null;
  rows: any[];
}
interface PgClient {
  query(text: string, values?: any[]): Promise<QueryResult>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: any[]): Promise<QueryResult>;
  on(event: "error", listener: (error: Error) => void): this;
  end(): Promise<void>;
}
let pool: PgPool | undefined;
let readyPromise: Promise<boolean> | undefined;

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/** A shared PostgreSQL pool. No database is silently fabricated when production has no DATABASE_URL. */
export function getDatabasePool() {
  if (!databaseConfigured()) return undefined;
  if (!pool) {
    let Pool: new (options: Record<string, unknown>) => PgPool;
    try {
      ({ Pool } = require("pg") as { Pool: new (options: Record<string, unknown>) => PgPool });
    } catch {
      throw new Error("The PostgreSQL driver is missing. Run 'pnpm install' from the repository root before enabling DATABASE_URL.");
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.HEDER1_DB_POOL_MAX ?? 10),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: "heder1-api",
    });
    pool.on("error", (error: Error) => {
      // Do not log connection strings or query parameters.
      console.error("heder1 PostgreSQL pool error:", error.message);
    });
  }
  return pool;
}

export async function ensureDatabaseReady(): Promise<boolean> {
  const db = getDatabasePool();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production; refusing to use process-local payment state.");
    }
    return false;
  }
  if (!readyPromise) {
    readyPromise = (async () => {
      const client = await db.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [72120412]);
        await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
        const migrationDirectory = await findMigrationDirectory();
        const migrations = (await readdir(migrationDirectory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
        for (const name of migrations) {
          const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [name]);
          if (alreadyApplied.rowCount) continue;
          const sql = await readFile(resolve(migrationDirectory, name), "utf8");
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [name]);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        return true;
      } finally {
        try { await client.query("SELECT pg_advisory_unlock($1)", [72120412]); } catch { /* connection may already be lost */ }
        client.release();
      }
    })().catch(error => {
      readyPromise = undefined;
      throw error;
    });
  }
  return readyPromise;
}

async function findMigrationDirectory(): Promise<string> {
  const candidates = [resolve(process.cwd(), "services/api/migrations"), resolve(process.cwd(), "migrations")];
  for (const candidate of candidates) {
    try { await readdir(candidate); return candidate; } catch { /* try next supported working directory */ }
  }
  throw new Error("Database migrations directory is missing; refusing to start database-backed payment operations.");
}

export async function withDatabaseTransaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
  if (!await ensureDatabaseReady()) throw new Error("A configured PostgreSQL database is required for this operation.");
  const db = getDatabasePool();
  if (!db) throw new Error("PostgreSQL is not configured.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureUser(walletAddress: string): Promise<string> {
  const normalized = walletAddress.toLowerCase();
  const ready = await ensureDatabaseReady();
  const db = getDatabasePool();
  if (!ready || !db) return normalized;
  await db.query(
    "INSERT INTO users(wallet_address) VALUES ($1) ON CONFLICT(wallet_address) DO UPDATE SET updated_at = now()",
    [normalized],
  );
  return normalized;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function savePolicyVersion(walletAddress: string, policy: unknown): Promise<void> {
  const normalized = await ensureUser(walletAddress);
  const serialized = JSON.stringify(policy);
  const policyHash = createHash("sha256").update(serialized).digest("hex");
  const db = getDatabasePool();
  if (!db) return;
  await db.query(
    "INSERT INTO policy_versions(wallet_address, policy_hash, policy) VALUES ($1,$2,$3::jsonb) ON CONFLICT(wallet_address, policy_hash) DO NOTHING",
    [normalized, policyHash, serialized],
  );
}


export type AuthStateKind = "authorization" | "payment-approval";

export async function saveChallengeRecord(kind: AuthStateKind, nonce: string, walletAddress: string, payload: unknown, expiresAt: number): Promise<void> {
  const wallet = await ensureUser(walletAddress);
  const db = getDatabasePool();
  if (!db) throw new Error("PostgreSQL is required to persist authorization challenges.");
  await db.query(
    "INSERT INTO auth_challenges(kind,nonce,wallet_address,payload,expires_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(kind,nonce) DO NOTHING",
    [kind, nonce, wallet, JSON.stringify(payload), new Date(expiresAt)],
  );
}

export async function takeChallengeRecord<T>(kind: AuthStateKind, nonce: string): Promise<T | undefined> {
  return withDatabaseTransaction(async client => {
    const result = await client.query(
      "DELETE FROM auth_challenges WHERE kind=$1 AND nonce=$2 AND expires_at > now() RETURNING payload",
      [kind, nonce],
    );
    return result.rowCount ? result.rows[0].payload as T : undefined;
  });
}

export async function saveGrantRecord(kind: AuthStateKind, token: string, walletAddress: string, payload: unknown, expiresAt: number): Promise<void> {
  const wallet = await ensureUser(walletAddress);
  const db = getDatabasePool();
  if (!db) throw new Error("PostgreSQL is required to persist authorization grants.");
  await db.query(
    "INSERT INTO auth_grants(kind,token_hash,wallet_address,payload,expires_at) VALUES($1,$2,$3,$4::jsonb,$5)",
    [kind, hashOpaqueToken(token), wallet, JSON.stringify(payload), new Date(expiresAt)],
  );
}

export async function consumeGrantRecord<T>(kind: AuthStateKind, token: string, expectedScope?: string): Promise<T | undefined> {
  return withDatabaseTransaction(async client => {
    const tokenHash = hashOpaqueToken(token);
    const result = await client.query(
      "SELECT payload,expires_at FROM auth_grants WHERE kind=$1 AND token_hash=$2 FOR UPDATE",
      [kind, tokenHash],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      await client.query("DELETE FROM auth_grants WHERE kind=$1 AND token_hash=$2", [kind, tokenHash]);
      return undefined;
    }
    const payload = row.payload as T;
    // A scope mismatch does not consume a valid grant; the caller still cannot use it on this endpoint.
    if (expectedScope && (payload as { scope?: string }).scope !== expectedScope) return undefined;
    await client.query("DELETE FROM auth_grants WHERE kind=$1 AND token_hash=$2", [kind, tokenHash]);
    return payload;
  });
}

export async function revokeGrantRecord(kind: AuthStateKind, token: string): Promise<boolean> {
  await ensureDatabaseReady();
  const db = getDatabasePool();
  if (!db) throw new Error("PostgreSQL is required to persist authorization grants.");
  const result = await db.query("DELETE FROM auth_grants WHERE kind=$1 AND token_hash=$2 RETURNING token_hash", [kind, hashOpaqueToken(token)]);
  return Boolean(result.rowCount);
}

export async function claimTaskRun(input: { runId: string; walletAddress: string; idempotencyKey: string; requestHash: string }): Promise<boolean> {
  const wallet = await ensureUser(input.walletAddress);
  const db = getDatabasePool();
  if (!db) return true;
  const result = await db.query(
    `INSERT INTO task_runs(run_id, wallet_address, idempotency_key, request_hash, status)
     VALUES ($1,$2,$3,$4,'quoted')
     ON CONFLICT DO NOTHING RETURNING run_id`,
    [input.runId, wallet, input.idempotencyKey, input.requestHash],
  );
  return Boolean(result.rowCount);
}

export async function updateTaskRun(runId: string, walletAddress: string, status: "quoted"|"reserved"|"submitted"|"settled"|"rejected"|"failed"|"unknown", response?: unknown, errorCode?: string): Promise<void> {
  const wallet = await ensureUser(walletAddress);
  const db = getDatabasePool();
  if (!db) return;
  await db.query(
    "UPDATE task_runs SET status=$3, response=$4::jsonb, error_code=$5, updated_at=now() WHERE run_id=$1 AND wallet_address=$2",
    [runId, wallet, status, response === undefined ? null : JSON.stringify(response), errorCode ?? null],
  );
}

export async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const normalizedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  if (databaseConfigured()) {
    await ensureDatabaseReady();
    const db = getDatabasePool()!;
    const result = await db.query(
      `INSERT INTO api_rate_limits(bucket_key, window_started_at, request_count)
       VALUES ($1, now(), 1)
       ON CONFLICT(bucket_key) DO UPDATE SET
         request_count = CASE WHEN api_rate_limits.window_started_at <= now() - ($2 * interval '1 second') THEN 1 ELSE api_rate_limits.request_count + 1 END,
         window_started_at = CASE WHEN api_rate_limits.window_started_at <= now() - ($2 * interval '1 second') THEN now() ELSE api_rate_limits.window_started_at END,
         updated_at = now()
       RETURNING request_count, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (window_started_at + ($2 * interval '1 second') - now())))::integer) AS retry_after_seconds`,
      [key, windowSeconds],
    );
    const count = Number(result.rows[0].request_count);
    const retryAfterSeconds = Number(result.rows[0].retry_after_seconds);
    return { allowed: count <= normalizedLimit, remaining: Math.max(0, normalizedLimit - count), retryAfterSeconds };
  }
  // Development/test fallback only. Production requires PostgreSQL above.
  const now = Date.now();
  const entry = localRateLimits.get(key);
  const current = !entry || now - entry.startedAt >= windowMs ? { startedAt: now, count: 0 } : entry;
  current.count += 1;
  localRateLimits.set(key, current);
  return { allowed: current.count <= normalizedLimit, remaining: Math.max(0, normalizedLimit - current.count), retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + windowMs - now) / 1000)) };
}
const localRateLimits = new Map<string, { startedAt: number; count: number }>();



export type PaymentProofClaim =
  | { claimed: true }
  | { claimed: false; status: "settled"; transactionId: string; settledAt: string }
  | { claimed: false; status: "processing" | "rejected" | "unknown" };

export async function claimPaymentProof(proofHash: string, servicePath: string): Promise<PaymentProofClaim> {
  await ensureDatabaseReady();
  const db = getDatabasePool()!;
  const inserted = await db.query(
    "INSERT INTO payment_proofs(proof_hash,service_path,status) VALUES($1,$2,'processing') ON CONFLICT(proof_hash) DO NOTHING RETURNING proof_hash",
    [proofHash, servicePath],
  );
  if (inserted.rowCount) return { claimed: true };
  const existing = await db.query("SELECT status,transaction_id,settled_at FROM payment_proofs WHERE proof_hash=$1", [proofHash]);
  if (!existing.rowCount) throw new Error("Payment-proof state changed unexpectedly; refusing duplicate settlement.");
  const row = existing.rows[0];
  if (row.status === "settled" && typeof row.transaction_id === "string" && row.transaction_id) {
    return { claimed: false, status: "settled", transactionId: row.transaction_id, settledAt: row.settled_at ? new Date(String(row.settled_at)).toISOString() : new Date().toISOString() };
  }
  return { claimed: false, status: row.status as "processing" | "rejected" | "unknown" };
}

export async function finishPaymentProof(input: {
  proofHash: string; status: "settled" | "rejected" | "unknown"; transactionId?: string; settledAt?: string; errorCode?: string; response?: unknown;
}): Promise<boolean> {
  await ensureDatabaseReady();
  const db = getDatabasePool()!;
  const result = await db.query(
    `UPDATE payment_proofs SET status=$2, transaction_id=COALESCE($3,transaction_id),
       settled_at=COALESCE($4::timestamptz,settled_at), response=$5::jsonb, error_code=$6, updated_at=now()
     WHERE proof_hash=$1 AND status IN ('processing','unknown')`,
    [input.proofHash, input.status, input.transactionId ?? null, input.settledAt ?? null, input.response === undefined ? null : JSON.stringify(input.response), input.errorCode ?? null],
  );
  return Boolean(result.rowCount);
}

export async function storeAuditMetadata(input: { walletAddress?: string; eventType: string; entityId?: string; metadata?: Record<string, unknown> }): Promise<void> {
  if (!databaseConfigured()) return;
  await ensureDatabaseReady();
  const db = getDatabasePool()!;
  const wallet = input.walletAddress ? input.walletAddress.toLowerCase() : null;
  if (wallet) await ensureUser(wallet);
  const safeMetadata = Object.fromEntries(Object.entries(input.metadata ?? {})
    .filter(([key]) => !/(nonce|signature|token|private.?key|seed|proof|secret|credential|password|api.?key|authorization|cookie|mnemonic)/i.test(key))
    .map(([key, value]) => [key, typeof value === "string"
      ? value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]").replace(/0x[0-9a-f]{128}/gi, "[REDACTED_SIGNATURE]")
      : value]));
  await db.query(
    "INSERT INTO audit_metadata(wallet_address,event_type,entity_id,metadata) VALUES($1,$2,$3,$4::jsonb)",
    [wallet, input.eventType.slice(0,120), input.entityId?.slice(0,200) ?? null, JSON.stringify(safeMetadata)],
  );
}

export async function closeDatabasePool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
  readyPromise = undefined;
}