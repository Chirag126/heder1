import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appendAuditEvent, listAuditRecords } from "./audit-trail.js";

const previousPath = process.env.HEDERA_AUDIT_LOG_PATH;
const dir = await mkdtemp(join(tmpdir(), "heder1-audit-secrets-"));
process.env.HEDERA_AUDIT_LOG_PATH = join(dir, "audit.jsonl");
process.env.HEDERA_AUDIT_HCS_ENABLED = "false";

test("dashboard audit records omit sensitive field names but preserve useful metadata", async () => {
  await appendAuditEvent({
    event: "authorization.rejected",
    outcome: "rejected",
    details: {
      account: "0x0000000000000000000000000000000000000001",
      signature: "test-signature-must-not-be-returned",
      apiKey: "test-api-key-must-not-be-returned",
      password: "test-password-must-not-be-returned",
      authorization: "Bearer test-token-must-not-be-returned",
      cookie: "session=test-cookie",
      mnemonic: "test-seed-phrase-must-not-be-returned",
      stage: "signature-verification",
    },
  });

  const records = await listAuditRecords(10);
  assert.equal(records.length, 1);
  const details = records[0].details as Record<string, unknown>;
  assert.equal(details.account, "0x0000000000000000000000000000000000000001");
  assert.equal(details.stage, "signature-verification");
  for (const key of ["signature", "apiKey", "password", "authorization", "cookie", "mnemonic"]) {
    assert.equal(Object.hasOwn(details, key), false, `sensitive field ${key} should be filtered`);
  }
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /test-signature|test-api-key|test-password|test-token|test-cookie|test-seed-phrase/);
});

after(async () => {
  if (previousPath === undefined) delete process.env.HEDERA_AUDIT_LOG_PATH;
  else process.env.HEDERA_AUDIT_LOG_PATH = previousPath;
  await rm(dir, { recursive: true, force: true });
});
