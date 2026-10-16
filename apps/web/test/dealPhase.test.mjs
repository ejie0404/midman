import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dealStage, isYourMove, nextAction, stepStates } from "../lib/dealPhase.ts";

describe("deal stage", () => {
  it("prefers the chain phase over the draft status", () => {
    assert.equal(dealStage("DELIVERED", "admitted").label, "Inspecting");
    assert.equal(dealStage(null, "admitted").label, "Ready to fund");
  });

  it("marks disputes as needing attention on the inspect step", () => {
    const stage = dealStage("EVIDENCE", null);
    assert.equal(stage.attention, true);
    assert.deepEqual(stepStates(stage), ["done", "done", "done", "attention", "todo"]);
  });

  it("completes every step once settled", () => {
    assert.deepEqual(stepStates(dealStage("SETTLED", null)), ["done", "done", "done", "done", "done"]);
  });

  it("knows whose move it is", () => {
    assert.equal(isYourMove(dealStage("AWAITING_DELIVERY", null), "seller"), true);
    assert.equal(isYourMove(dealStage("AWAITING_DELIVERY", null), "buyer"), false);
    assert.equal(isYourMove(dealStage(null, "admitted"), "buyer"), true);
  });
});

describe("next action", () => {
  it("routes each party to the right page", () => {
    assert.equal(nextAction(null, "admitted", "buyer").cta.path, "fund");
    assert.equal(nextAction(null, "admitted", "seller").cta, null);
    assert.equal(nextAction("AWAITING_DELIVERY", null, "seller").cta.path, "deliver");
    assert.equal(nextAction("DELIVERED", null, "buyer").cta.path, "inspect");
    assert.equal(nextAction("SETTLED", null, "seller").cta.path, "claim");
  });

  it("offers nothing to a non-party", () => {
    assert.equal(nextAction("DELIVERED", null, null).cta, null);
  });
});
