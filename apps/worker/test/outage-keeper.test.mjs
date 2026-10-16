import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextStep, runOutageKeeper } from "../dist/outage/keeper.js";

const POLICIES = "0x00000000000000000000000000000000000000bb";
const PHASE = 1n << 64n;

/**
 * Feed + watermark model mirroring MidmanPolicies: rounds are consecutive per
 * proxy phase; successor crosses to `(phase+1) << 64 | 1`.
 */
class FakeChain {
  constructor(rounds, lastAuditedRound) {
    this.rounds = new Map(rounds.map(([id, up]) => [id, up]));
    this.la = lastAuditedRound;
    this.reads = 0;
  }
  head() {
    return [...this.rounds.keys()].reduce((a, b) => (b > a ? b : a));
  }
  successor(rid) {
    if (this.rounds.has(rid + 1n)) return rid + 1n;
    const next = ((rid >> 64n) + 1n) * PHASE + 1n;
    return this.rounds.has(next) ? next : null;
  }
  covers(head, up) {
    if (up) return this.la === head;
    if (this.la >= head) return true;
    return this.successor(this.la) === head;
  }
  async readWatermark() {
    this.reads += 1;
    const head = this.head();
    const headUp = this.rounds.get(head);
    const next = this.successor(this.la);
    return {
      policies: POLICIES,
      lastAuditedRound: this.la,
      headRound: head,
      headUp,
      covered: this.covers(head, headUp),
      nextRound: next,
      nextUp: next === null ? null : this.rounds.get(next),
    };
  }
}

/** Applies keeper steps with the contract's preconditions. */
class FakeSubmitter {
  constructor(chain) {
    this.chain = chain;
    this.steps = [];
  }
  async submit(_policies, step) {
    const next = this.chain.successor(this.chain.la);
    if (step.kind === "advance") {
      if (next === null || this.chain.rounds.get(next) !== true) throw new Error("BadPanel");
      this.chain.la = next;
    } else {
      if (step.round !== next || this.chain.rounds.get(next) !== false) throw new Error("BadPanel");
      const recovery = this.chain.successor(next);
      if (recovery === null || this.chain.rounds.get(recovery) !== true) throw new Error("BadPanel");
      this.chain.la = recovery;
    }
    this.steps.push(step);
    return `0x${String(this.steps.length).padStart(64, "0")}`;
  }
}

const run = (chain, submitter, memory, nowSeconds, maxLagSeconds = 600) =>
  runOutageKeeper({ chain, submitter, memory, nowSeconds, maxLagSeconds });

describe("outage keeper", () => {
  it("does nothing when the watermark covers the head", async () => {
    const chain = new FakeChain([[1n, true]], 1n);
    const result = await run(chain, new FakeSubmitter(chain), { behindSince: null }, 1000);
    assert.equal(result.status, "covered");
    assert.equal(result.submitted.length, 0);
    assert.equal(result.alerts.length, 0);
  });

  it("reports each recovered outage in order until covered", async () => {
    const chain = new FakeChain(
      [
        [1n, true],
        [2n, false],
        [3n, true],
        [4n, false],
        [5n, true],
      ],
      1n,
    );
    const submitter = new FakeSubmitter(chain);
    const result = await run(chain, submitter, { behindSince: null }, 1000);
    assert.equal(result.status, "advanced");
    assert.deepEqual(
      submitter.steps.map((s) => (s.kind === "report" ? Number(s.round) : s.kind)),
      [2, 4],
    );
    assert.equal(chain.la, 5n);
  });

  it("crosses a proxy phase boundary (down -> new-phase recovery, then up start)", async () => {
    const chain = new FakeChain(
      [
        [PHASE + 7n, true],
        [PHASE + 8n, false],
        [2n * PHASE + 1n, true],
      ],
      PHASE + 7n,
    );
    const submitter = new FakeSubmitter(chain);
    const result = await run(chain, submitter, { behindSince: null }, 1000);
    assert.equal(result.status, "advanced");
    assert.equal(chain.la, 2n * PHASE + 1n);

    const upStart = new FakeChain(
      [
        [PHASE + 7n, true],
        [2n * PHASE + 1n, true],
      ],
      PHASE + 7n,
    );
    const upSubmitter = new FakeSubmitter(upStart);
    await run(upStart, upSubmitter, { behindSince: null }, 1000);
    assert.deepEqual(upSubmitter.steps, [{ kind: "advance" }]);
    assert.equal(upStart.la, 2n * PHASE + 1n);
  });

  it("never reports an ongoing outage at the head", () => {
    const state = {
      policies: POLICIES,
      lastAuditedRound: 1n,
      headRound: 2n,
      headUp: false,
      covered: false,
      nextRound: 2n,
      nextUp: false,
    };
    assert.equal(nextStep(state), null);
  });

  it("alerts only after the lag threshold when no key is configured", async () => {
    const chain = new FakeChain(
      [
        [1n, true],
        [2n, false],
        [3n, true],
      ],
      1n,
    );
    const memory = { behindSince: null };
    const first = await run(chain, null, memory, 1000);
    assert.equal(first.status, "behind");
    assert.equal(first.alerts.length, 0);
    const later = await run(chain, null, memory, 1700);
    assert.equal(later.alerts.length, 1);
    assert.equal(later.alerts[0].id, "outage_watermark_behind");
    assert.equal(later.alerts[0].severity, "critical");
    assert.equal(later.alerts[0].details.keeper, "no KEEPER_KEY configured");
    assert.equal(later.alerts[0].details.lagSeconds, "700");
  });

  it("alerts immediately when a keeper transaction fails, and resets once covered", async () => {
    const chain = new FakeChain(
      [
        [1n, true],
        [2n, false],
        [3n, true],
      ],
      1n,
    );
    const memory = { behindSince: null };
    const failing = { submit: async () => Promise.reject(new Error("insufficient funds")) };
    const failed = await run(chain, failing, memory, 1000);
    assert.equal(failed.alerts.length, 1);
    assert.equal(failed.alerts[0].details.lastError, "insufficient funds");

    const ok = await run(chain, new FakeSubmitter(chain), memory, 1010);
    assert.equal(ok.status, "advanced");
    assert.equal(memory.behindSince, null);
  });

  it("raises a warning when the watermark cannot be read", async () => {
    const broken = { readWatermark: async () => Promise.reject(new Error("rpc down")) };
    const result = await run(broken, null, { behindSince: null }, 1000);
    assert.equal(result.status, "unknown");
    assert.equal(result.alerts[0].id, "outage_watermark_unknown");
  });
});
