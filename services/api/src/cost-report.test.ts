import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dailyTaskQuota, estimateTaskCost, getPublicPricing, reportActualTaskCost } from "./cost-report.js";

const originalQuota = process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY;
afterEach(() => {
  if (originalQuota === undefined) delete process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY;
  else process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY = originalQuota;
});

test("pricing separates free preview, provider resource, service, sponsored network fee, and unallocated hosting", () => {
  const pricing = getPublicPricing();
  assert.equal(pricing.currentAgent.heder1ServiceFeeTinybars, "0");
  assert.equal(pricing.currentAgent.model, "deterministic; no LLM inference is called");
  assert.equal(pricing.plans.hostedAgent.price, "Not offered in this release");
});

test("cost estimate uses registry hints and bounds calls without claiming hints are final quotes", () => {
  const estimate = estimateTaskCost("heder1-full-report", 3);
  assert.equal(estimate.resourcePayment.maximumResourcePaymentTinybars, "300000");
  assert.equal(estimate.resourcePayment.maximumResourcePaymentHbar, "0.003");
  assert.equal(estimate.resourcePayment.authoritativeQuoteRequired, true);
  assert.equal(estimate.hederaNetworkFee.userPayableTinybars, "0");
  assert.equal(estimate.hostingInfrastructure.allocatedUsd, null);
  assert.throws(() => estimateTaskCost("heder1-full-report", 4), /1 to 3/);
  assert.throws(() => estimateTaskCost("unknown-service", 1), /approved service/);
});

test("actual cost report totals settlement receipt amounts exactly", () => {
  const report = reportActualTaskCost([
    { serviceId: "a", amountTinybars: "100000", transactionId: "tx-1" },
    { serviceId: "b", amountTinybars: "50000", transactionId: "tx-2" },
  ]);
  assert.equal(report.resourcePayment.amountTinybars, "150000");
  assert.equal(report.resourcePayment.amountHbar, "0.0015");
  assert.equal(report.knownUserCost.amountTinybars, "150000");
  assert.equal(report.items.length, 2);
  assert.equal(report.modelInference.calls, 0);
  assert.throws(() => reportActualTaskCost([{ serviceId: "a", amountTinybars: "-1", transactionId: "tx" }]), /non-negative integer/);
});

test("per-wallet daily task quota defaults to ten and validates configuration", () => {
  delete process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY;
  assert.equal(dailyTaskQuota(), 10);
  process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY = "5";
  assert.equal(dailyTaskQuota(), 5);
  process.env.HEDER1_TASK_QUOTA_PER_WALLET_PER_DAY = "1000";
  assert.throws(() => dailyTaskQuota(), /integer from 1 to 100/);
});
