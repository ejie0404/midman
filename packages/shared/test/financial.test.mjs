import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  catastrophicSplit,
  feeRateBps,
  isTimely,
  normalSettlement,
  partialBondCosts,
  quoteFee,
} from "../dist/financial.js";

describe("fee tiers (locked boundaries)", () => {
  it("matches spec boundaries", () => {
    assert.equal(feeRateBps(10800), 25);
    assert.equal(feeRateBps(10801), 50);
    assert.equal(feeRateBps(86399), 50);
    assert.equal(feeRateBps(86400), 70);
    assert.equal(feeRateBps(259200), 70);
    assert.equal(feeRateBps(259201), 100);
    assert.equal(feeRateBps(604800), 100);
    assert.equal(feeRateBps(604801), 200);
  });
});

describe("quote ceil (P-01)", () => {
  it("takes the 0.50 minimum on small deals", () => {
    assert.equal(quoteFee(5_000_000n, 3600), 500_000n);
  });
  it("ceils fractional schedule amounts", () => {
    // 10,000,001 * 25bps = 25,000.0025 -> ceil 25,001 -> clamped to 500,000 minimum
    assert.equal(quoteFee(10_000_001n, 3600), 500_000n);
    // Large principal where schedule exceeds minimum: 100,000,001 * 200bps = 2,000,000.02 -> ceil
    assert.equal(quoteFee(100_000_001n, 604801), 2_000_001n);
  });
});

describe("L-NORMAL (ledger examples)", () => {
  it("buyer-paid 100 USDC, 70 award", () => {
    const r = normalSettlement(100_000_000n, 500_000n, 70_000_000n, 10_000);
    assert.deepEqual(
      [r.buyerClaim, r.sellerClaim, r.earnedFee],
      [30_150_000n, 70_000_000n, 350_000n],
    );
  });
  it("seller-paid 5 USDC, 0.10 award", () => {
    const r = normalSettlement(5_000_000n, 500_000n, 100_000n, 0);
    assert.deepEqual([r.buyerClaim, r.sellerClaim, r.earnedFee], [4_900_000n, 90_000n, 10_000n]);
  });
  it("split odd fee stays within one unit", () => {
    const r = normalSettlement(100_000_000n, 500_001n, 50_000_000n, 5_000);
    assert.equal(r.buyerFee + r.sellerFee, r.earnedFee);
    assert.ok(r.sellerFee - r.buyerFee <= 1n && r.buyerFee - r.sellerFee <= 1n);
  });
  it("S=0 earns zero and returns funding", () => {
    const r = normalSettlement(5_000_000n, 500_000n, 0n, 10_000);
    assert.equal(r.earnedFee, 0n);
    assert.equal(r.buyerClaim, r.funded);
  });
});

describe("P-03 partial bond costs", () => {
  it("generalizes full-win endpoints", () => {
    assert.deepEqual(partialBondCosts(100n, 0n, 5n, 5n), { buyerCost: 0n, sellerCost: 5n });
    assert.deepEqual(partialBondCosts(100n, 100n, 5n, 5n), { buyerCost: 5n, sellerCost: 0n });
  });
});

describe("P-02 catastrophic split", () => {
  it("odd unit goes to buyer", () => {
    assert.deepEqual(catastrophicSplit(5_000_001n), { buyerShare: 2_500_001n, sellerShare: 2_500_000n });
  });
});

describe("deadline comparisons", () => {
  it("timely is strict <", () => {
    assert.equal(isTimely(99, 100), true);
    assert.equal(isTimely(100, 100), false);
  });
});
