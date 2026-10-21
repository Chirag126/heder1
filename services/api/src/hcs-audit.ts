import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

export type HcsAnchor = {
  network: "testnet";
  topicId: string;
  sequenceNumber: number;
  transactionId: string;
  auditSequence: number;
  auditRecordHash: string;
  mirrorNodeUrl: string;
};

function getHcsConfig() {
  if (process.env.HEDERA_AUDIT_HCS_ENABLED !== "true") return null;
  if (process.env.HEDERA_NETWORK !== "testnet") throw new Error("HCS audit anchoring is restricted to Hedera Testnet.");
  const topicId = process.env.HEDERA_AUDIT_HCS_TOPIC_ID;
  const accountId = process.env.HEDERA_AUDIT_HCS_OPERATOR_ACCOUNT_ID ?? process.env.HEDERA_CLIENT_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_AUDIT_HCS_OPERATOR_PRIVATE_KEY ?? process.env.HEDERA_CLIENT_PRIVATE_KEY;
  if (!topicId || !/^0\.0\.\d+$/.test(topicId)) throw new Error("A valid HEDERA_AUDIT_HCS_TOPIC_ID is required when HCS anchoring is enabled.");
  if (!accountId || !/^0\.0\.\d+$/.test(accountId) || !privateKey) throw new Error("HCS operator credentials are required when HCS anchoring is enabled.");
  return { topicId, accountId, privateKey };
}

export async function anchorAuditRecord(input: { sequence: number; hash: string }): Promise<HcsAnchor | null> {
  const config = getHcsConfig();
  if (!config) return null;
  const client = Client.forTestnet();
  try {
    client.setOperator(AccountId.fromString(config.accountId), PrivateKey.fromString(config.privateKey));
    const message = JSON.stringify({
      schema: "heder1.audit-anchor.v1",
      network: "testnet",
      topicId: config.topicId,
      auditSequence: input.sequence,
      auditRecordHash: input.hash,
      algorithm: "sha-256",
    });
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(config.topicId)
      .setMessage(message)
      .execute(client);
    const receipt = await response.getReceipt(client);
    const sequenceNumber = Number(receipt.topicSequenceNumber?.toString());
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
      throw new Error("HCS submission succeeded without a usable topic sequence number.");
    }
    return {
      network: "testnet",
      topicId: config.topicId,
      sequenceNumber,
      transactionId: response.transactionId.toString(),
      auditSequence: input.sequence,
      auditRecordHash: input.hash,
      mirrorNodeUrl: `https://testnet.mirrornode.hedera.com/api/v1/topics/${config.topicId}/messages/${sequenceNumber}`,
    };
  } finally {
    client.close();
  }
}

export async function verifyHcsAnchor(input: { topicId: string; sequenceNumber: number; expectedAuditHash: string }) {
  if (!/^0\.0\.\d+$/.test(input.topicId) || !Number.isSafeInteger(input.sequenceNumber) || input.sequenceNumber < 1 ||
      !/^[a-f0-9]{64}$/.test(input.expectedAuditHash)) {
    throw new Error("A valid topic ID, sequence number, and SHA-256 audit hash are required.");
  }
  const url = `https://testnet.mirrornode.hedera.com/api/v1/topics/${input.topicId}/messages/${input.sequenceNumber}`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return { valid: false, reason: "HCS message not found on the testnet Mirror Node.", url };
  if (!response.ok) throw new Error(`Mirror Node returned HTTP ${response.status}.`);
  const body = await response.json() as { messages?: Array<{ message?: string; topic_id?: string; sequence_number?: number }> };
  const message = body.messages?.[0];
  if (!message?.message || message.topic_id !== input.topicId || message.sequence_number !== input.sequenceNumber) {
    return { valid: false, reason: "Mirror Node response did not match the requested HCS message.", url };
  }
  let decoded: { schema?: string; network?: string; topicId?: string; auditRecordHash?: string; algorithm?: string };
  try { decoded = JSON.parse(Buffer.from(message.message, "base64").toString("utf8")); }
  catch { return { valid: false, reason: "HCS message was not valid anchor JSON.", url }; }
  const valid = decoded.schema === "heder1.audit-anchor.v1" &&
    decoded.network === "testnet" && decoded.topicId === input.topicId &&
    decoded.algorithm === "sha-256" && decoded.auditRecordHash === input.expectedAuditHash;
  return { valid, topicId: input.topicId, sequenceNumber: input.sequenceNumber, expectedAuditHash: input.expectedAuditHash, anchoredAuditHash: decoded.auditRecordHash ?? null, url };
}
