import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { anchorAuditRecord, type HcsAnchor } from "./hcs-audit.js";

export type AuditEvent =
  | "authorization.challenge_issued"
  | "authorization.grant_issued"
  | "authorization.rejected"
  | "agent.authorization_rejected"
  | "agent.run_started"
  | "agent.run_finished"
  | "payment.attempted"
  | "payment.rejected"
  | "payment.settled";

export type AuditInput = {
  event: AuditEvent;
  outcome: "accepted" | "rejected" | "started" | "settled" | "failed";
  details?: Record<string, string | number | boolean | null>;
  timestamp?: string;
};

type AuditRecord = AuditInput & {
  id: string;
  sequence: number;
  previousHash: string | null;
  hash: string;
};

const GENESIS_HASH = "0".repeat(64);
let queue: Promise<unknown> = Promise.resolve();

function auditPath() {
  return resolve(process.env.HEDERA_AUDIT_LOG_PATH ?? "./data/audit-trail.jsonl");
}

function recordHash(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export async function appendAuditEvent(input: AuditInput): Promise<AuditRecord & { hcsAnchor?: HcsAnchor }> {
  let release!: () => void;
  const previous = queue;
  queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous;
  try {
    const path = auditPath();
    await mkdir(dirname(path), { recursive: true });
    const integrity = await verifyAuditTrail(path);
    if (!integrity.valid) throw new Error("Audit trail integrity check failed; refusing to append.");
    let sequence = 1;
    let previousHash: string | null = null;
    try {
      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditRecord;
        if (!Number.isSafeInteger(last.sequence) || typeof last.hash !== "string" || last.hash.length !== 64) {
          throw new Error("Audit trail tail is invalid; refusing to append.");
        }
        sequence = last.sequence + 1;
        previousHash = last.hash;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const base = {
      id: randomUUID(),
      sequence,
      previousHash: previousHash ?? GENESIS_HASH,
      timestamp: input.timestamp ?? new Date().toISOString(),
      event: input.event,
      outcome: input.outcome,
      ...(input.details ? { details: input.details } : {}),
    };
    const record: AuditRecord = { ...base, hash: recordHash(base) };
    await appendFile(path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600, flag: "a" });
    await chmod(path, 0o600);
    const hcsAnchor = await anchorAuditRecord(record);
    return hcsAnchor ? { ...record, hcsAnchor } : record;
  } finally {
    release();
  }
}

/** Validate sequence, hash links, and each record hash for local audit export checks. */
export async function verifyAuditTrail(pathInput?: string): Promise<{ valid: boolean; records: number; error?: string; headHash?: string }> {
  const path = resolve(pathInput ?? process.env.HEDERA_AUDIT_LOG_PATH ?? "./data/audit-trail.jsonl");
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: true, records: 0, headHash: GENESIS_HASH };
    throw error;
  }
  let expectedSequence = 1;
  let expectedPreviousHash = GENESIS_HASH;
  let headHash = GENESIS_HASH;
  const lines = raw.split("\n").filter(Boolean);
  for (const line of lines) {
    let parsed: AuditRecord;
    try { parsed = JSON.parse(line) as AuditRecord; }
    catch { return { valid: false, records: expectedSequence - 1, error: "Invalid JSON record." }; }
    const { hash, ...base } = parsed;
    if (parsed.sequence !== expectedSequence || parsed.previousHash !== expectedPreviousHash ||
        typeof hash !== "string" || recordHash(base) !== hash) {
      return { valid: false, records: expectedSequence - 1, error: `Hash-chain validation failed at sequence ${expectedSequence}.` };
    }
    expectedSequence += 1;
    expectedPreviousHash = hash;
    headHash = hash;
  }
  return { valid: true, records: lines.length, headHash };
}
