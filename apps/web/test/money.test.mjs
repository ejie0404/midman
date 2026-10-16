import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatUnits,
  formatUSDC,
  parseUSDC,
  formatFeePct,
  effectiveFeeBps,
  countdownTo,
  formatDuration,
} from "../lib/money.ts";

describe("money formatting (exact, no floats)", () => {
  it("formats 500000 units as 0.500000", () => {
    assert.equal(formatUnits("500000"), "0.500000");
    assert.equal(formatUnits(500000n), "0.500000");
    assert.equal(formatUSDC("500000"), "0.500000 USDC");
  });

  it("formats odd units with buyer-favor dust visible", () => {
    assert.equal(formatUnits("1"), "0.000001");
    assert.equal(formatUnits("1000001"), "1.000001");
    assert.equal(formatUnits("1000000"), "1.000000");
  });

  it("groups thousands without floats", () => {
    assert.equal(formatUnits("1234567890123"), "1,234,567.890123");
    assert.equal(formatUSDC("100500000"), "100.500000 USDC");
  });

  it("round-trips decimal input to exact units", () => {
    assert.equal(parseUSDC("0.5"), "500000");
    assert.equal(parseUSDC("0.500000"), "500000");
    assert.equal(parseUSDC("100"), "100000000");
    assert.equal(parseUSDC("1.000001"), "1000001");
    assert.throws(() => parseUSDC("1.0000001"), RangeError);
    assert.throws(() => parseUSDC("-1"), RangeError);
    assert.throws(() => parseUSDC("abc"), RangeError);
  });

  it("formats fee bps with integer math", () => {
    assert.equal(formatFeePct(0), "0.00%");
    assert.equal(formatFeePct(25), "0.25%");
    assert.equal(formatFeePct(50), "0.50%");
    assert.equal(formatFeePct(100), "1.00%");
    assert.equal(formatFeePct(10_000), "100.00%");
    assert.equal(formatFeePct(5n), "0.05%");
  });

  it("computes effective fee bps exactly", () => {
    assert.equal(effectiveFeeBps("350000", "100000000"), 35n);
    assert.equal(effectiveFeeBps("0", "5000000"), 0n);
  });

  it("formats countdowns from unix seconds", () => {
    assert.equal(countdownTo(1_000_000, 999_000), "16m 40s");
    assert.equal(countdownTo(1_000_000, 1_000_000), "expired");
    assert.equal(countdownTo(999, 1_000), "expired");
    assert.equal(countdownTo(1_000_000 + 90_061, 1_000_000), "1d 1h 1m 1s");
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(3_600), "1h 0m 0s");
  });
});

describe("formatAmount", () => {
  it("trims to at least two decimals without rounding", async () => {
    const { formatAmount } = await import("../lib/money.ts");
    assert.equal(formatAmount("100000000"), "100.00");
    assert.equal(formatAmount("100500000"), "100.50");
    assert.equal(formatAmount("123456"), "0.123456");
    assert.equal(formatAmount(1234567890000n), "1,234,567.89");
  });
});

describe("formatSpan", () => {
  it("reads naturally", async () => {
    const { formatSpan } = await import("../lib/money.ts");
    assert.equal(formatSpan(3_600), "1 hour");
    assert.equal(formatSpan(43_200), "12 hours");
    assert.equal(formatSpan(259_200), "3 days");
    assert.equal(formatSpan(108_000), "1 day 6 hours");
    assert.equal(formatSpan(2_700), "45 minutes");
  });
});

