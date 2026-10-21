import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  FIREWALL_DAILY_BUDGET_TINYBARS,
  FIREWALL_MAX_ATTEMPTS_PER_DAY,
  reserveAgentSpend,
  reserveAgentV2Spend,
} from "./spending-firewall.js";

const dirs: string[] = [];
async function ledgerPath() {
  const dir = await mkdtemp(join(tmpdir(), "heder1-firewall-"));
  dirs.push(dir);
  return join(dir, "ledger.json");
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const valid = {
  amountTinybars: "100000",
  receiverAccountId: "0.0.11044329",
  resourceUrl: "http://127.0.0.1:4000/api/x402/paid-resource",
};
const now = new Date("2026-10-21T12:00:00.000Z");

test("firewall reserves an allowed payment persistently before signing", async () => {
  const path = await ledgerPath();
  const result = await reserveAgentSpend(valid, { path, now });
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.equal(result.reservedTodayTinybars, "100000");
    assert.equal(result.attemptsToday, 1);
  }
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.entries[0].reservedTinybars, 100000);
});


test("Phase 10 firewall reserves the lower-priced approved summary endpoint", async () => {
  const path = await ledgerPath();
  const result = await reserveAgentV2Spend({
    amountTinybars: "50000",
    receiverAccountId: "0.0.11044329",
    resourceUrl: "http://127.0.0.1:4000/api/x402/summary",
  }, { path, now });
  assert.equal(result.allowed, true);
  if (result.allowed) assert.equal(result.amountTinybars, "50000");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.entries[0].reservedTinybars, 50000);
});

test("Phase 10 firewall rejects remote or unregistered service paths", async () => {
  const path = await ledgerPath();
  for (const resourceUrl of [
    "https://example.com/api/x402/summary",
    "http://127.0.0.1:4000/api/x402/not-registered",
    "http://127.0.0.1:4000/api/x402/summary?url=http://example.com",
  ]) {
    const result = await reserveAgentV2Spend({
      amountTinybars: "50000",
      receiverAccountId: "0.0.11044329",
      resourceUrl,
    }, { path, now });
    assert.equal(result.allowed, false, resourceUrl);
  }
});

test("firewall rejects amounts above the per-payment cap", async () => {
  const result = await reserveAgentSpend({ ...valid, amountTinybars: "100001" }, { path: await ledgerPath(), now });
  assert.equal(result.allowed, false);
});

test("firewall rejects non-allowlisted resources and invalid recipients", async () => {
  const path = await ledgerPath();
  for (const input of [
    { ...valid, resourceUrl: "https://example.com/api/x402/paid-resource" },
    { ...valid, resourceUrl: "http://127.0.0.1:4000/admin" },
    { ...valid, receiverAccountId: "0.0.invalid" },
  ]) {
    const result = await reserveAgentSpend(input, { path, now });
    assert.equal(result.allowed, false);
  }
});

test("firewall enforces daily budget and attempt count across calls", async () => {
  const path = await ledgerPath();
  for (let i = 0; i < FIREWALL_MAX_ATTEMPTS_PER_DAY; i++) {
    const result = await reserveAgentSpend(valid, { path, now });
    assert.equal(result.allowed, true);
  }
  const blocked = await reserveAgentSpend(valid, { path, now });
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.match(blocked.reason, /attempt limit/);

  assert.equal(FIREWALL_DAILY_BUDGET_TINYBARS, 1_000_000);
});

test("firewall fails closed if the persisted ledger is corrupt", async () => {
  const path = await ledgerPath();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, "{broken", "utf8");
  await assert.rejects(() => reserveAgentSpend(valid, { path, now }));
});
