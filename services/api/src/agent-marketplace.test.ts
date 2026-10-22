import assert from "node:assert/strict";
import test from "node:test";
import { getMarketplaceAgentCards, negotiateMarketplaceOffers } from "./agent-marketplace.js";

const offers = [
  { serviceId: "heder1-full-report", status: "quoted", amountTinybars: 100_000, reason: "live quote" },
  { serviceId: "heder1-short-summary", status: "quoted", amountTinybars: 50_000, reason: "live quote" },
];

test("marketplace exposes distinct provider agents with explicit unverified identity status", () => {
  const cards = getMarketplaceAgentCards();
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0]!.agentId, cards[1]!.agentId);
  assert.ok(cards.every((card) => card.identity.status === "local-unverified"));
  assert.ok(cards.every((card) => card.pricing.negotiable === false));
});

test("buyer selects cheapest eligible live quote when task intent is generic", () => {
  const result = negotiateMarketplaceOffers({ goal: "Find a report", budgetTinybars: 100_000, offers });
  assert.equal(result.selected?.serviceId, "heder1-short-summary");
  assert.equal(result.selected?.amountTinybars, 50_000);
  assert.equal(result.paymentAttempted, false);
});

test("buyer honors explicit capability preference when the preferred provider is eligible", () => {
  const result = negotiateMarketplaceOffers({ goal: "Create a detailed full report", budgetTinybars: 100_000, offers });
  assert.equal(result.selected?.serviceId, "heder1-full-report");
});

test("buyer rejects offers outside budget and does not attempt payment", () => {
  const result = negotiateMarketplaceOffers({
    goal: "short summary",
    budgetTinybars: 40_000,
    offers: offers.map((offer) => ({ ...offer, status: "rejected", reason: "Quote exceeds cap" })),
  });
  assert.equal(result.selected, null);
  assert.equal(result.decision, "no-eligible-offer");
  assert.equal(result.paymentAttempted, false);
});

test("goal and budget are validated", () => {
  assert.throws(() => negotiateMarketplaceOffers({ goal: " ", budgetTinybars: 50_000, offers }), /Goal/);
  assert.throws(() => negotiateMarketplaceOffers({ goal: "summary", budgetTinybars: 500_001, offers }), /Budget/);
});
