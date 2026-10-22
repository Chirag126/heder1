import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  claimPaymentProof, claimTaskRun, closeDatabasePool, consumeGrantRecord, ensureDatabaseReady,
  finishPaymentProof, saveChallengeRecord, saveGrantRecord, takeChallengeRecord, updateTaskRun,
} from "./database.js";
import { reservePostgresSpend, transitionPostgresReservation } from "./postgres-spending-ledger.js";

const testDatabaseUrl = process.env.HEDER1_TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;
const wallet = () => `0x${randomBytes(20).toString("hex")}`;

after(async () => {
  await closeDatabasePool();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("PostgreSQL migrations and durable state are available", { skip: !testDatabaseUrl }, async () => {
  assert.equal(await ensureDatabaseReady(), true);
});

test("concurrent reservations cannot exceed a wallet daily or task budget", { skip: !testDatabaseUrl }, async () => {
  const accountId = wallet();
  const taskId = randomUUID();
  const attempts = await Promise.all(Array.from({ length: 12 }, () => reservePostgresSpend({
    amountTinybars: 10_000,
    receiverAccountId: "0.0.11044329",
    resourceUrl: "http://127.0.0.1:4000/api/x402/summary",
    accountId,
  }, {
    dailyBudgetTinybars: 50_000,
    maxAttemptsPerDay: 50,
    taskId,
    taskBudgetTinybars: 50_000,
    maxPaidCallsPerTask: 10,
  })));
  assert.equal(attempts.filter(result => result.allowed).length, 5);
  assert.equal(attempts.filter(result => !result.allowed).length, 7);
});

test("payment state transitions preserve ambiguous outcomes until explicit reconciliation", { skip: !testDatabaseUrl }, async () => {
  const accountId = wallet();
  const reserved = await reservePostgresSpend({
    amountTinybars: 10_000,
    receiverAccountId: "0.0.11044329",
    resourceUrl: "http://127.0.0.1:4000/api/x402/summary",
    accountId,
  }, { dailyBudgetTinybars: 100_000, maxAttemptsPerDay: 20 });
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;
  assert.equal((await transitionPostgresReservation({ reservationId: reserved.reservationId, status: "submitted" })).updated, true);
  assert.equal((await transitionPostgresReservation({ reservationId: reserved.reservationId, status: "unknown", note: "Simulated timeout; reconcile before retry." })).updated, true);
  assert.equal((await transitionPostgresReservation({ reservationId: reserved.reservationId, status: "settled" })).updated, false);
  assert.equal((await transitionPostgresReservation({ reservationId: reserved.reservationId, status: "settled", transactionId: "0.0.123@1234567890.000000001" })).updated, true);
  assert.equal((await transitionPostgresReservation({ reservationId: reserved.reservationId, status: "failed" })).updated, false);
});

test("authorization challenges and hashed one-time grants survive pool restart but cannot replay", { skip: !testDatabaseUrl }, async () => {
  const accountId = wallet();
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 60_000;
  const challenge = { account: accountId, nonce, expiresAt, message: "test challenge", scope: "heder1:test" };
  await saveChallengeRecord("authorization", nonce, accountId, challenge, expiresAt);
  const token = randomBytes(32).toString("base64url");
  await saveGrantRecord("authorization", token, accountId, { account: accountId, scope: "heder1:test", expiresAt }, expiresAt);
  await closeDatabasePool(); // Simulate an API process restart; state must remain in PostgreSQL.
  const restored = await takeChallengeRecord<typeof challenge>("authorization", nonce);
  assert.equal(restored?.message, "test challenge");
  assert.equal(await takeChallengeRecord("authorization", nonce), undefined);
  const grant = await consumeGrantRecord<{ account: string; scope: string }>("authorization", token, "heder1:test");
  assert.equal(grant?.account, accountId.toLowerCase());
  assert.equal(await consumeGrantRecord("authorization", token, "heder1:test"), undefined);
});

test("task run IDs and idempotency keys are unique across process restarts", { skip: !testDatabaseUrl }, async () => {
  const accountId = wallet();
  const runId = randomUUID();
  const claim = { runId, walletAddress: accountId, idempotencyKey: runId, requestHash: "a".repeat(64) };
  assert.equal(await claimTaskRun(claim), true);
  await updateTaskRun(runId, accountId, "unknown", undefined, "simulated_timeout");
  await closeDatabasePool();
  assert.equal(await claimTaskRun(claim), false);
});


test("payment proof replay is blocked across restart and unknown outcomes are never resubmitted", { skip: !testDatabaseUrl }, async () => {
  const proofHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  assert.deepEqual(await claimPaymentProof(proofHash, "/api/x402/summary"), { claimed: true });
  const duplicate = await claimPaymentProof(proofHash, "/api/x402/summary");
  assert.equal(duplicate.claimed, false);
  if (!duplicate.claimed) assert.equal(duplicate.status, "processing");
  assert.equal(await finishPaymentProof({ proofHash, status: "unknown", errorCode: "simulated_timeout" }), true);
  await closeDatabasePool();
  const afterRestart = await claimPaymentProof(proofHash, "/api/x402/summary");
  assert.equal(afterRestart.claimed, false);
  if (!afterRestart.claimed) assert.equal(afterRestart.status, "unknown");
  assert.equal(await finishPaymentProof({ proofHash, status: "settled", transactionId: "0.0.123@1234567890.000000001" }), true);
  const settled = await claimPaymentProof(proofHash, "/api/x402/summary");
  assert.equal(settled.claimed, false);
  if (!settled.claimed) {
    assert.equal(settled.status, "settled");
    if (settled.status === "settled") assert.equal(settled.transactionId, "0.0.123@1234567890.000000001");
  }
});
