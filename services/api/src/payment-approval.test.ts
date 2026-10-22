import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { createPaymentApprovalChallenge, consumePaymentApproval, verifyPaymentApproval } from "./payment-approval.js";
import { DEFAULT_USER_SPENDING_POLICY, type UserSpendingPolicy } from "./spending-policy.js";

const wallet = new Wallet("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const policy = (): UserSpendingPolicy => ({
  ...DEFAULT_USER_SPENDING_POLICY,
  mode: "approval-required",
  expiresAt: Date.now() + 60_000,
  allowedServiceIds: ["heder1-short-summary"],
  maxPaymentTinybars: 100_000,
  taskBudgetTinybars: 500_000,
  dailyBudgetTinybars: 1_000_000,
  approvalThresholdTinybars: 10_000,
});

test("quote-specific wallet approval is one-use and binds the exact payment", async () => {
  const challenge = createPaymentApprovalChallenge({
    account: wallet.address,
    policy: policy(),
    quote: { serviceId: "heder1-short-summary", network: "hedera:testnet", asset: "0.0.0", amountTinybars: 50_000, receiverAccountId: "0.0.11044329" },
  });
  const signature = await wallet.signMessage(challenge.message);
  const verified = await verifyPaymentApproval({ nonce: challenge.nonce, signature });
  assert.equal(verified.quote.amountTinybars, 50_000);
  assert.equal(verified.policy.mode, "approval-required");
  const consumed = consumePaymentApproval(verified.approvalToken);
  assert.equal(consumed.allowed, true);
  if (consumed.allowed) assert.equal(consumed.quote.receiverAccountId, "0.0.11044329");
  assert.equal(consumePaymentApproval(verified.approvalToken).allowed, false);
});

test("approval rejects unapproved services, expired policies, preview mode, and mismatched wallet signatures", async () => {
  assert.throws(() => createPaymentApprovalChallenge({
    account: wallet.address, policy: policy(),
    quote: { serviceId: "unapproved", network: "hedera:testnet", asset: "0.0.0", amountTinybars: 1, receiverAccountId: "0.0.1" },
  }), /allowlist/);
  assert.throws(() => createPaymentApprovalChallenge({
    account: wallet.address, policy: { ...policy(), expiresAt: Date.now() - 1 },
    quote: { serviceId: "heder1-short-summary", network: "hedera:testnet", asset: "0.0.0", amountTinybars: 1, receiverAccountId: "0.0.1" },
  }), /expired/);
  assert.throws(() => createPaymentApprovalChallenge({
    account: wallet.address, policy: { ...policy(), mode: "preview" },
    quote: { serviceId: "heder1-short-summary", network: "hedera:testnet", asset: "0.0.0", amountTinybars: 1, receiverAccountId: "0.0.1" },
  }), /Preview mode/);
  const challenge = createPaymentApprovalChallenge({
    account: wallet.address, policy: policy(),
    quote: { serviceId: "heder1-short-summary", network: "hedera:testnet", asset: "0.0.0", amountTinybars: 1, receiverAccountId: "0.0.1" },
  });
  const wrongSignature = await wallet.signMessage("wrong message");
  await assert.rejects(() => verifyPaymentApproval({ nonce: challenge.nonce, signature: wrongSignature }), /does not match|invalid/);
});
