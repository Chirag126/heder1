import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { AUTHORIZATION_SCOPE_V2, consumeAuthorizationGrant, createAuthorizationChallenge, revokeAuthorizationGrant, verifyAuthorizationChallenge } from "./authorization.js";

const wallet = new Wallet("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

test("wallet signature grants one bounded agent invocation and token is single-use", async () => {
  const challenge = await createAuthorizationChallenge(wallet.address, 1_000_000);
  assert.equal(challenge.chainId, 296);
  assert.match(challenge.message, /0\.001 HBAR/);
  const signature = await wallet.signMessage(challenge.message);
  const grant = await verifyAuthorizationChallenge({ nonce: challenge.nonce, signature, now: 1_000_001 });
  assert.equal(grant.account.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(grant.singleUse, true);
  assert.equal((await consumeAuthorizationGrant(grant.authorizationToken, 1_000_002)).allowed, true);
  assert.equal((await consumeAuthorizationGrant(grant.authorizationToken, 1_000_003)).allowed, false);
});

test("authorization rejects a signature from the wrong wallet and burns the challenge", async () => {
  const challenge = await createAuthorizationChallenge(wallet.address, 2_000_000);
  const wrongWallet = new Wallet("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  const signature = await wrongWallet.signMessage(challenge.message);
  await assert.rejects(
    verifyAuthorizationChallenge({ nonce: challenge.nonce, signature, now: 2_000_001 }),
    /does not match/,
  );
  await assert.rejects(
    verifyAuthorizationChallenge({ nonce: challenge.nonce, signature, now: 2_000_002 }),
    /missing, expired, or already used/,
  );
});

test("authorization rejects expired and missing grants", async () => {
  const challenge = await createAuthorizationChallenge(wallet.address, 3_000_000);
  assert.equal((await consumeAuthorizationGrant(undefined, 3_000_001)).allowed, false);
  assert.equal((await consumeAuthorizationGrant("not-a-grant", 3_000_001)).allowed, false);
  assert.ok(challenge.expiresAt);
});

test("Phase 10 authorization is explicit, bounded, and cannot be consumed by the Phase 9 endpoint", async () => {
  const challenge = await createAuthorizationChallenge(wallet.address, 4_000_000, AUTHORIZATION_SCOPE_V2);
  assert.equal(challenge.scope, AUTHORIZATION_SCOPE_V2);
  assert.match(challenge.message, /Maximum task budget: 500000 tinybars/);
  assert.match(challenge.message, /Maximum single payment: 100000 tinybars/);
  assert.match(challenge.message, /registered heder1 testnet services only/);
  const signature = await wallet.signMessage(challenge.message);
  const grant = await verifyAuthorizationChallenge({ nonce: challenge.nonce, signature, now: 4_000_001 });
  assert.equal(grant.scope, AUTHORIZATION_SCOPE_V2);
  assert.equal((await consumeAuthorizationGrant(grant.authorizationToken, 4_000_002)).allowed, false);
  assert.equal((await consumeAuthorizationGrant(grant.authorizationToken, 4_000_002, AUTHORIZATION_SCOPE_V2)).allowed, true);
});

test("Phase 11 signed policy is included in the wallet message and unused grants can be revoked", async () => {
  const now = 5_000_000;
  const policy = {
    mode: "autonomous" as const,
    network: "hedera:testnet" as const,
    maxPaymentTinybars: 40_000,
    taskBudgetTinybars: 100_000,
    dailyBudgetTinybars: 200_000,
    maxPaidCallsPerTask: 1,
    maxPaidCallsPerDay: 2,
    allowedServiceIds: ["heder1-short-summary"],
    allowedAssets: ["0.0.0"],
    expiresAt: now + 60_000,
    approvalThresholdTinybars: 20_000,
  };
  const challenge = await createAuthorizationChallenge(wallet.address, now, AUTHORIZATION_SCOPE_V2, policy);
  assert.match(challenge.message, /"maxPaymentTinybars":40000/);
  const signature = await wallet.signMessage(challenge.message);
  const grant = await verifyAuthorizationChallenge({ nonce: challenge.nonce, signature, now: now + 1 });
  assert.equal(grant.policy.maxPaymentTinybars, 40_000);
  assert.deepEqual(await revokeAuthorizationGrant(grant.authorizationToken), { revoked: true });
  assert.equal((await consumeAuthorizationGrant(grant.authorizationToken, now + 2, AUTHORIZATION_SCOPE_V2)).allowed, false);
});
