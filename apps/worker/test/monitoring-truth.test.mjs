// Truthfulness tests for monitoring (audit finding #12). These lock in the
// invariants that a failed chain read is UNKNOWN (never silently solvent), a
// failed webhook delivery is retried (never marked delivered), placeholder
// zeros are not fabricated for unavailable metric sources, and reconciliation
// reports unknown on read failure.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@midman/store";
import { collectMetrics } from "../dist/monitoring/metrics.js";
import { evaluate, thresholdsFromEnv } from "../dist/monitoring/thresholds.js";
import { runMonitoringPass } from "../dist/monitoring/index.js";
import { WebhookSink, AlertDeduper } from "../dist/monitoring/alerts.js";
import { reconcile } from "../dist/reconcile.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TH = thresholdsFromEnv({});

const alertIds = (alerts) => alerts.map((a) => a.id);

function baseReader(overrides = {}) {
  return {
    async getDeal() {
      throw new Error("no deal");
    },
    async getLiabilities() {
      return 0n;
    },
    async getTokenBalance() {
      return 0n;
    },
    async getBlockByTag() {
      return null;
    },
    async getLatestBlockNumber() {
      return 0n;
    },
    async getBlock() {
      return { number: 0n, hash: "0x00", parentHash: "0x00", timestamp: 0 };
    },
    async getClaim() {
      throw new Error("unused");
    },
    async getLogs() {
      return [];
    },
    async getTransactionReceipt() {
      return null;
    },
    async isPanelMember() {
      return false;
    },
    async getBondPolicy() {
      return { claimantBond: 0n, respondentBond: 0n };
    },
    ...overrides,
  };
}

function envWith({ reader = baseReader(), store = new MemoryStore() } = {}) {
  return { store, reader, hub: HUB, usdc: USDC };
}

class BrokenStore extends MemoryStore {
  constructor({ sponsors = false, queue = false } = {}) {
    super();
    this.brokenSponsors = sponsors;
    this.brokenQueue = queue;
  }
  async countSponsorsSince(sinceIso) {
    if (this.brokenSponsors) throw new Error("db down");
    return super.countSponsorsSince(sinceIso);
  }
  async listQueuedRelay(queue, limit) {
    if (this.brokenQueue) throw new Error("db down");
    return super.listQueuedRelay(queue, limit);
  }
}

describe("solvency truthfulness", () => {
  it("reports UNKNOWN (not ok) when getLiabilities throws", async () => {
    const reader = baseReader({
      async getLiabilities() {
        throw new Error("rpc down");
      },
    });
    const snap = await collectMetrics(envWith({ reader }), 1_000);
    assert.equal(snap.solvency.status, "unknown");
    assert.equal(snap.solvency.ok, null);
    assert.equal(snap.solvency.liabilitiesUnits, "0");
    assert.equal(snap.solvency.balanceUnits, "0");
    assert.equal(snap.solvency.reason, "Error");
    assert.notEqual(snap.solvency.ok, true);
  });

  it("reports UNKNOWN when getTokenBalance throws", async () => {
    const reader = baseReader({
      async getTokenBalance() {
        throw new Error("rpc down");
      },
    });
    const snap = await collectMetrics(envWith({ reader }), 1_000);
    assert.equal(snap.solvency.status, "unknown");
    assert.equal(snap.solvency.ok, null);
  });

  it("reports UNKNOWN when reader or hub is missing", async () => {
    const noReader = envWith({ reader: null });
    const snap1 = await collectMetrics(noReader, 1_000);
    assert.equal(snap1.solvency.status, "unknown");
    assert.equal(snap1.solvency.ok, null);
    assert.equal(snap1.solvency.reason, "no-reader-or-hub");

    const noHub = { store: new MemoryStore(), reader: baseReader(), hub: null, usdc: USDC };
    const snap2 = await collectMetrics(noHub, 1_000);
    assert.equal(snap2.solvency.status, "unknown");
    assert.equal(snap2.solvency.ok, null);
  });

  it("emits a warning solvency_unknown alert and NOT a critical solvent alert", async () => {
    const reader = baseReader({
      async getLiabilities() {
        throw new Error("rpc down");
      },
    });
    const snap = await collectMetrics(envWith({ reader }), 1_000);
    const alerts = evaluate(snap, TH);
    const unknown = alerts.find((a) => a.id === "solvency_unknown");
    assert.ok(unknown, "expected solvency_unknown alert");
    assert.equal(unknown.severity, "warning");
    assert.equal(unknown.details.reason, "Error");
    assert.equal(alerts.some((a) => a.id === "solvency"), false);
    assert.equal(alerts.some((a) => a.severity === "critical"), false);
  });

  it("still emits critical solvency on a real shortfall", async () => {
    const reader = baseReader({
      async getLiabilities() {
        return 100n;
      },
      async getTokenBalance() {
        return 50n;
      },
    });
    const snap = await collectMetrics(envWith({ reader }), 1_000);
    assert.equal(snap.solvency.status, "shortfall");
    assert.equal(snap.solvency.ok, false);
    const alerts = evaluate(snap, TH);
    const critical = alerts.find((a) => a.id === "solvency");
    assert.equal(critical.severity, "critical");
    assert.equal(critical.details.shortfallUnits, "50");
    assert.equal(alerts.some((a) => a.id === "solvency_unknown"), false);
  });

  it("emits no solvency alert when custody covers liabilities", async () => {
    const reader = baseReader({
      async getLiabilities() {
        return 100n;
      },
      async getTokenBalance() {
        return 150n;
      },
    });
    const snap = await collectMetrics(envWith({ reader }), 1_000);
    assert.equal(snap.solvency.status, "ok");
    assert.equal(snap.solvency.ok, true);
    const alerts = evaluate(snap, TH);
    assert.equal(alerts.some((a) => a.id === "solvency"), false);
    assert.equal(alerts.some((a) => a.id === "solvency_unknown"), false);
  });
});

describe("webhook delivery truthfulness", () => {
  it("WebhookSink returns false on HTTP 500 and does not remember it as delivered", async () => {
    let calls = 0;
    let status = 500;
    const sink = new WebhookSink("https://example.invalid/hook", {
      fetchImpl: async () => {
        calls += 1;
        return { ok: status < 300, status };
      },
      idempotencyWindowSeconds: 900,
    });
    const alert = { id: "a1", severity: "warning", summary: "s", details: {}, atUnix: 1_000 };

    assert.equal(await sink.send(alert), false);
    assert.equal(sink.lastError, "http-500");
    // Retry is attempted because the failure was not cached.
    assert.equal(await sink.send(alert), false);
    assert.equal(calls, 2);

    status = 200;
    assert.equal(await sink.send(alert), true);
    assert.equal(calls, 3);
    // Only after success is the same alert suppressed.
    assert.equal(await sink.send(alert), true);
    assert.equal(calls, 3);
  });

  it("runMonitoringPass counts failures, retries them, then delivers on success", async () => {
    const reader = baseReader({
      async getLiabilities() {
        throw new Error("rpc down");
      },
    });
    const env = envWith({ reader });
    const deduper = new AlertDeduper(900, 3);
    let sinkHealthy = false;
    const attempted = [];
    const sink = {
      async send(alert) {
        attempted.push(alert.id);
        return sinkHealthy;
      },
    };
    const t = 1_000_000;

    const first = await runMonitoringPass(env, t, { sink, deduper, thresholds: TH });
    assert.equal(first.delivered, 0);
    assert.ok(first.failed >= 1, "failed send must be reported");
    assert.ok(first.failed === first.alerts.length);
    assert.ok(attempted.includes("solvency_unknown"));

    // A failed delivery is re-queued: the same alert id is attempted again.
    const second = await runMonitoringPass(env, t + 10, { sink, deduper, thresholds: TH });
    assert.ok(second.failed >= 1);
    assert.ok(attempted.filter((id) => id === "solvency_unknown").length >= 2);

    // Once the sink recovers, the re-queued alerts are delivered.
    sinkHealthy = true;
    const third = await runMonitoringPass(env, t + 20, { sink, deduper, thresholds: TH });
    assert.ok(third.delivered >= 1);
    assert.equal(third.failed, 0);
  });

  it("gives up after ALERT_MAX_ATTEMPTS and emits a delivery_failed meta-alert", async () => {
    const reader = baseReader({
      async getLiabilities() {
        throw new Error("rpc down");
      },
    });
    const env = envWith({ reader });
    const deduper = new AlertDeduper(900, 3);
    const sink = { async send() { return false; } };
    const t = 2_000_000;

    const first = await runMonitoringPass(env, t, { sink, deduper, thresholds: TH });
    const second = await runMonitoringPass(env, t + 10, { sink, deduper, thresholds: TH });
    const third = await runMonitoringPass(env, t + 20, { sink, deduper, thresholds: TH });
    assert.equal(first.failed, first.alerts.length);
    assert.equal(second.failed, second.alerts.length);
    assert.ok(alertIds(third.alerts).includes("delivery_failed"));

    // After giving up, the originals are suppressed rather than retried forever.
    const fourth = await runMonitoringPass(env, t + 30, { sink, deduper, thresholds: TH });
    assert.equal(fourth.delivered, 0);
    assert.equal(fourth.failed, 0);
    assert.equal(alertIds(fourth.alerts).includes("delivery_failed"), false);
    assert.ok(fourth.suppressed >= first.alerts.length);
  });

  it("dedupe still suppresses true duplicates after a SUCCESSFUL delivery", async () => {
    const reader = baseReader({
      async getLiabilities() {
        throw new Error("rpc down");
      },
    });
    const env = envWith({ reader });
    const deduper = new AlertDeduper(900, 3);
    const sent = [];
    const sink = { async send(alert) { sent.push(alert.id); return true; } };
    const t = 3_000_000;

    const first = await runMonitoringPass(env, t, { sink, deduper, thresholds: TH });
    assert.ok(first.delivered >= 1);
    assert.equal(sent.length, first.delivered);

    const second = await runMonitoringPass(env, t + 10, { sink, deduper, thresholds: TH });
    assert.equal(second.delivered, 0);
    assert.equal(sent.length, first.delivered);
    assert.ok(second.suppressed >= 1);
  });
});

describe("metric source truthfulness", () => {
  it("reports null (never 0) for relayQueued and sponsors24h when the store read fails", async () => {
    const store = new BrokenStore({ sponsors: true, queue: true });
    const env = { store, reader: baseReader(), hub: HUB, usdc: USDC };
    const snap = await collectMetrics(env, 1_000);
    assert.equal(snap.ops.relayQueued, null);
    assert.equal(snap.ops.sponsors24h, null);

    const alerts = evaluate(snap, TH);
    assert.ok(alertIds(alerts).includes("relay_queued_unknown"));
    assert.ok(alertIds(alerts).includes("sponsor_count_unknown"));
  });

  it("reports null (never fabricated '0') for sponsor spend when the source is unavailable", async () => {
    const env = envWith();
    const unavailable = await collectMetrics(env, 1_000, { sponsorSpendWei: () => null });
    assert.equal(unavailable.ops.sponsorSpendWeiUnits, null);
    assert.ok(alertIds(evaluate(unavailable, TH)).includes("sponsor_spend_unknown"));

    // An explicitly available source may legitimately report 0.
    const known = await collectMetrics(env, 1_000, { sponsorSpendWei: () => 0n });
    assert.equal(known.ops.sponsorSpendWeiUnits, "0");
    assert.equal(alertIds(evaluate(known, TH)).includes("sponsor_spend_unknown"), false);
  });

  it("includes failed and suppressed in the pass result", async () => {
    const env = envWith();
    const result = await runMonitoringPass(env, 1_000, {
      sink: { async send() { return true; } },
      deduper: new AlertDeduper(900, 3),
      thresholds: TH,
    });
    assert.equal(typeof result.delivered, "number");
    assert.equal(typeof result.suppressed, "number");
    assert.equal(result.failed, 0);
  });
});

describe("reconciliation truthfulness", () => {
  it("returns ok=null (unknown) when the chain read fails", async () => {
    const reader = {
      async getLiabilities() {
        throw new Error("rpc down");
      },
      async getTokenBalance() {
        return 0n;
      },
    };
    const result = await reconcile({ reader, hub: HUB, usdc: USDC });
    assert.equal(result.ok, null);
    assert.equal(result.liabilities, null);
    assert.equal(result.balance, null);
    assert.equal(result.delta, null);
    assert.equal(result.reason, "Error");
    assert.notEqual(result.ok, true);
  });

  it("returns a known verdict when both reads succeed", async () => {
    const shortfall = await reconcile({
      reader: {
        async getLiabilities() {
          return 200n;
        },
        async getTokenBalance() {
          return 150n;
        },
      },
      hub: HUB,
      usdc: USDC,
    });
    assert.equal(shortfall.ok, false);
    assert.equal(shortfall.delta, -50n);

    const solvent = await reconcile({
      reader: {
        async getLiabilities() {
          return 100n;
        },
        async getTokenBalance() {
          return 150n;
        },
      },
      hub: HUB,
      usdc: USDC,
    });
    assert.equal(solvent.ok, true);
    assert.equal(solvent.delta, 50n);
  });
});
