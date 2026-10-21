import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { reserveAgentSpend } from "./spending-firewall.js";

const dir = await mkdtemp(join(tmpdir(), "heder1-firewall-bypass-"));
const path = join(dir, "ledger.json");
const valid = {
  amountTinybars: "100000",
  receiverAccountId: "0.0.11044329",
  resourceUrl: "http://127.0.0.1:4000/api/x402/paid-resource",
};

test("firewall rejects URL and recipient policy bypass variants", async () => {
  const bypasses = [
    { ...valid, resourceUrl: "https://127.0.0.1:4000/api/x402/paid-resource" },
    { ...valid, resourceUrl: "http://127.0.0.1:4000/api/x402/paid-resource/" },
    { ...valid, resourceUrl: "http://127.0.0.1:4000/api/x402/paid-resource?next=/admin" },
    { ...valid, resourceUrl: "http://127.0.0.1:4000/api/x402/paid-resource#fragment" },
    { ...valid, resourceUrl: "http://user:pass@127.0.0.1:4000/api/x402/paid-resource" },
    { ...valid, resourceUrl: "http://127.0.0.1:4000@evil.example/api/x402/paid-resource" },
    { ...valid, resourceUrl: "http://127.0.0.1:4000/api%2Fx402%2Fpaid-resource" },
    { ...valid, resourceUrl: "http://192.168.1.10:4000/api/x402/paid-resource" },
    { ...valid, receiverAccountId: "0.0.11044329.evil" },
  ];

  for (const input of bypasses) {
    const result = await reserveAgentSpend(input, { path, now: new Date("2026-10-21T12:00:00.000Z") });
    assert.equal(result.allowed, false, `expected policy to reject ${input.resourceUrl} / ${input.receiverAccountId}`);
  }
});

test("firewall rejects non-integer, zero, negative, and over-limit amounts", async () => {
  for (const amountTinybars of ["0", "-1", "100001", "100000.5", "NaN", "Infinity", ""]) {
    const result = await reserveAgentSpend({ ...valid, amountTinybars }, { path, now: new Date("2026-10-21T12:00:00.000Z") });
    assert.equal(result.allowed, false, `expected amount ${JSON.stringify(amountTinybars)} to be rejected`);
  }
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});
