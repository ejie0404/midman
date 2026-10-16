import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("web shell", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

  it("states the contract minimums", () => {
    assert.match(page, /5\.00 USDC/);
    assert.match(page, /0\.50 USDC minimum/);
  });

  it("does not repeat claims the contracts contradict", () => {
    // Panels are 5 members with a 2- or 3-signature quorum, never "2-of-3";
    // inspection is capped at 14 days, never 30.
    assert.doesNotMatch(page, /2-of-3/);
    assert.doesNotMatch(page, /1h.30d/);
  });

  it("mirrors the on-chain fee tiers", () => {
    for (const rate of ["0.25%", "0.50%", "0.70%", "1.00%", "2.00%"]) assert.ok(page.includes(rate), rate);
  });
});
