import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendAuditEvent, verifyAuditTrail } from "./audit-trail.js";

test("audit trail appends linked records and verifies the hash chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "heder1-audit-"));
  const path = join(dir, "audit.jsonl");
  const previous = process.env.HEDERA_AUDIT_LOG_PATH;
  process.env.HEDERA_AUDIT_LOG_PATH = path;
  try {
    const first = await appendAuditEvent({ event: "authorization.grant_issued", outcome: "accepted", details: { account: "0xabc", singleUse: true } });
    const second = await appendAuditEvent({ event: "payment.settled", outcome: "settled", details: { transactionId: "0.0@test" } });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousHash, first.hash);
    const verification = await verifyAuditTrail(path);
    assert.equal(verification.valid, true);
    assert.equal(verification.records, 2);
    assert.equal(verification.headHash, second.hash);
  } finally {
    if (previous === undefined) delete process.env.HEDERA_AUDIT_LOG_PATH;
    else process.env.HEDERA_AUDIT_LOG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit trail detects edited records and refuses further appends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "heder1-audit-tamper-"));
  const path = join(dir, "audit.jsonl");
  const previous = process.env.HEDERA_AUDIT_LOG_PATH;
  process.env.HEDERA_AUDIT_LOG_PATH = path;
  try {
    await appendAuditEvent({ event: "payment.attempted", outcome: "started", details: { amountTinybars: 100000 } });
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace('"amountTinybars":100000', '"amountTinybars":900000'), "utf8");
    const verification = await verifyAuditTrail(path);
    assert.equal(verification.valid, false);
    await assert.rejects(appendAuditEvent({ event: "payment.rejected", outcome: "rejected" }), /integrity check failed/);
  } finally {
    if (previous === undefined) delete process.env.HEDERA_AUDIT_LOG_PATH;
    else process.env.HEDERA_AUDIT_LOG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
