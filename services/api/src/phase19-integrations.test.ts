import assert from "node:assert/strict";
import test from "node:test";
import { createHcs14AgentId } from "./agent-identity.js";
import { parseA2aMessageRequest } from "./a2a-protocol.js";
import { createRecurringPaymentDraft, cancelRecurringPaymentDraft } from "./recurring-payments.js";
import { validateReadonlyToolCall } from "./agent-tools.js";

test("HCS-14 AID is deterministic and normalizes registry/protocol", () => {
  const input = { registry: " HEDER1 ", name: "Buyer", version: "1.0.0", protocol: "A2A", nativeId: "hedera:testnet:0.0.1", skills: [17, 0, 17] };
  assert.equal(createHcs14AgentId(input), createHcs14AgentId(input));
  assert.match(createHcs14AgentId(input), /^uaid:aid:.+;uid=0;registry=heder1;proto=a2a;/);
});
test("HCS-14 identity rejects reserved skill IDs", () => assert.throws(() => createHcs14AgentId({ registry: "x", name: "x", version: "1", protocol: "a2a", nativeId: "x", skills: [45] })));
test("A2A JSON-RPC adapter validates message/send", () => {
  assert.equal(parseA2aMessageRequest({ jsonrpc: "2.0", id: "1", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "hello" }] } } }).text, "hello");
  assert.throws(() => parseA2aMessageRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }));
});
test("recurring payment draft is bounded and cancellation is available", () => {
  const draft = createRecurringPaymentDraft({ serviceId: "heder1-short-summary", amountTinybars: 50000, interval: "weekly", maxExecutions: 3, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
  assert.equal(draft.status, "draft-awaiting-onchain-approval");
  assert.equal(cancelRecurringPaymentDraft(draft.id)?.status, "cancelled");
  assert.throws(() => createRecurringPaymentDraft({ serviceId: "unknown", amountTinybars: 1, interval: "daily", maxExecutions: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
});
test("agent tools allow only bounded read-only account lookups", () => {
  assert.deepEqual(validateReadonlyToolCall("hedera_testnet_account_context", { accountId: "0.0.123" }), { accountId: "0.0.123" });
  assert.throws(() => validateReadonlyToolCall("transfer_hbar", { to: "0.0.2" }));
  assert.throws(() => validateReadonlyToolCall("hedera_testnet_account_context", { accountId: "https://evil.example" }));
});
