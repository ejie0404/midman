import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../lib/errors.ts";

describe("friendlyError", () => {
  it("explains contract custom errors", () => {
    const viemLike = Object.assign(new Error("Execution reverted"), {
      shortMessage: 'The contract function "openDispute" reverted.',
      details: 'Error: TooLate()',
    });
    assert.match(friendlyError(viemLike), /window for this action has closed/);
    assert.match(friendlyError(new Error("reverted with custom error 'OutageUnknown()'")), /network outage/);
  });

  it("recognises wallet rejections by code or text", () => {
    assert.equal(friendlyError(Object.assign(new Error("x"), { code: 4001 })), "You cancelled the request in your wallet.");
    assert.equal(friendlyError(new Error("User rejected the request.")), "You cancelled the request in your wallet.");
    assert.equal(
      friendlyError({ message: "outer", cause: { code: 4001 } }),
      "You cancelled the request in your wallet.",
    );
  });

  it("maps API statuses and token balance failures", () => {
    assert.match(friendlyError(Object.assign(new Error("Authentication required"), { status: 401 })), /Sign in again/);
    assert.match(friendlyError(Object.assign(new Error("slow down"), { status: 429 })), /Wait a minute/);
    assert.match(friendlyError(new Error("ERC20: transfer amount exceeds balance")), /Not enough USDC/);
  });

  it("falls back to a trimmed first message", () => {
    assert.equal(friendlyError(new Error("Deal is not ready")), "Deal is not ready");
    assert.ok(friendlyError(new Error("x".repeat(500))).length <= 200);
  });
});
