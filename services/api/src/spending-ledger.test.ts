import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { listDurableReservations, reconcileDurableReservation, reserveDurableSpend } from "./spending-ledger.js";

const dirs: string[] = [];
async function pathForTest() {
  const dir = await mkdtemp(join(tmpdir(), "heder1-ledger-"));
  dirs.push(dir);
  return join(dir, "ledger.json");
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const input = { amountTinybars: 50_000, receiverAccountId: "0.0.11044329", resourceUrl: "http://127.0.0.1:4000/api/x402/summary" };
const options = { now: new Date("2026-10-22T12:00:00.000Z"), dailyBudgetTinybars: 100_000, maxAttemptsPerDay: 10 };

test("durable ledger atomically reserves spend and persists a reconciliation record", async () => {
  const path = await pathForTest();
  const result = await reserveDurableSpend(input, { ...options, path });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  const rows = await listDurableReservations({ path });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, result.reservationId);
  assert.equal(rows[0]?.status, "reserved");
  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(disk.version, 2);
  assert.equal(disk.entries[0].reservedTinybars, 50_000);
});

test("concurrent reservations cannot exceed the daily budget", async () => {
  const path = await pathForTest();
  const results = await Promise.all(Array.from({ length: 4 }, () => reserveDurableSpend(input, { ...options, path })));
  assert.equal(results.filter(r => r.allowed).length, 2);
  assert.equal(results.filter(r => !r.allowed).length, 2);
});

test("task budget and per-task call count reject repeated reservations", async () => {
  const path = await pathForTest();
  const first = await reserveDurableSpend(input, { ...options, path, taskId: "task-a", taskBudgetTinybars: 75_000, maxPaidCallsPerTask: 2 });
  assert.equal(first.allowed, true);
  const overBudget = await reserveDurableSpend(input, { ...options, path, taskId: "task-a", taskBudgetTinybars: 75_000, maxPaidCallsPerTask: 2 });
  assert.equal(overBudget.allowed, false);
  if (!overBudget.allowed) assert.match(overBudget.reason, /Task spending budget/);
  const second = await reserveDurableSpend({ ...input, amountTinybars: 25_000 }, { ...options, path, taskId: "task-a", taskBudgetTinybars: 75_000, maxPaidCallsPerTask: 2 });
  assert.equal(second.allowed, true);
  const callCap = await reserveDurableSpend({ ...input, amountTinybars: 1 }, { ...options, path, taskId: "task-a", taskBudgetTinybars: 100_000, maxPaidCallsPerTask: 2 });
  assert.equal(callCap.allowed, false);
  if (!callCap.allowed) assert.match(callCap.reason, /Per-task paid-call limit/);
});

test("ambiguous settlement retains the reservation; confirmed failure releases it", async () => {
  const path = await pathForTest();
  const reserved = await reserveDurableSpend(input, { ...options, path });
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;
  const ambiguous = await reconcileDurableReservation({ reservationId: reserved.reservationId, outcome: "ambiguous", note: "Mirror Node status not yet conclusive" }, { path, now: options.now });
  assert.equal(ambiguous.updated, true);
  const afterAmbiguous = JSON.parse(await readFile(path, "utf8"));
  assert.equal(afterAmbiguous.entries[0].reservedTinybars, 50_000);
  const failed = await reconcileDurableReservation({ reservationId: reserved.reservationId, outcome: "failed", note: "Operator confirmed no settlement" }, { path, now: options.now });
  assert.equal(failed.updated, true);
  const afterFailed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(afterFailed.entries[0].reservedTinybars, 0);
});

test("settlement requires a transaction ID and terminal state cannot be overwritten", async () => {
  const path = await pathForTest();
  const reserved = await reserveDurableSpend(input, { ...options, path });
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;
  const missingTx = await reconcileDurableReservation({ reservationId: reserved.reservationId, outcome: "settled", note: "confirmed" }, { path });
  assert.equal(missingTx.updated, false);
  const settled = await reconcileDurableReservation({ reservationId: reserved.reservationId, outcome: "settled", transactionId: "0.0.123@123.000000001", note: "Verified in HashScan" }, { path });
  assert.equal(settled.updated, true);
  const change = await reconcileDurableReservation({ reservationId: reserved.reservationId, outcome: "failed", note: "conflict" }, { path });
  assert.equal(change.updated, false);
});

test("version 1 ledger migrates conservatively without releasing old reserved funds", async () => {
  const path = await pathForTest();
  await writeFile(path, JSON.stringify({ version: 1, entries: [{ day: "2026-10-22", reservedTinybars: 25_000, attempts: 1, updatedAt: options.now.toISOString() }] }));
  const rows = await listDurableReservations({ path });
  assert.equal(rows[0]?.status, "ambiguous");
  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(disk.version, 1, "read-only listing does not rewrite the ledger");
  const next = await reserveDurableSpend({ ...input, amountTinybars: 50_000 }, { ...options, path });
  assert.equal(next.allowed, true);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.entries.find((e: { day: string }) => e.day === "2026-10-22").reservedTinybars, 75_000);
});
