
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyHcsAnchor } from "./hcs-audit.js";

test("Mirror Node verification validates the expected HCS audit hash", async () => {
  const expectedHash = "a".repeat(64);

  const payload = {
    schema: "heder1.audit-anchor.v1",
    network: "testnet",
    topicId: "0.0.123",
    auditSequence: 7,
    auditRecordHash: expectedHash,
    algorithm: "sha-256",
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        topic_id: "0.0.123",
        sequence_number: 4,
        message: Buffer.from(JSON.stringify(payload)).toString("base64"),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const result = await verifyHcsAnchor({
      topicId: "0.0.123",
      sequenceNumber: 4,
      expectedAuditHash: expectedHash,
    });

    assert.equal(result.valid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Mirror Node verification rejects a different audit hash", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        topic_id: "0.0.123",
        sequence_number: 4,
        message: Buffer.from(
          JSON.stringify({
            schema: "heder1.audit-anchor.v1",
            network: "testnet",
            topicId: "0.0.123",
            auditRecordHash: "b".repeat(64),
            algorithm: "sha-256",
          }),
        ).toString("base64"),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const result = await verifyHcsAnchor({
      topicId: "0.0.123",
      sequenceNumber: 4,
      expectedAuditHash: "a".repeat(64),
    });

    assert.equal(result.valid, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
