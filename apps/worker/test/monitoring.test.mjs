import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@midman/store";
import { collectMetrics } from "../dist/monitoring/metrics.js";
import { evaluate, thresholdsFromEnv } from "../dist/monitoring/thresholds.js";
import { runMonitoringPass, MONITOR_METRICS } from "../dist/monitoring/index.js";
import {
  WebhookSink,
  LogSink,
  AlertDeduper,
  CompositeSink,
  makeSinkFromEnv,
  redactDetails,
} from "../dist/monitoring/alerts.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TH = thresholdsFromEnv({});

/** In-memory Store extension: relay status counts are not part of the base interface. */
class TestStore extends MemoryStore {
  constructor() {
    super();
    this.statuses = [];
  }
  async countRelayByStatus(status) {
    return this.statuses.filter((s) => s === status).length;
  }
  seedRelayStatus(status, count = 1) {
    for (let i = 0; i < count; i += 1) this.statuses.push(status);
  }
}

const dealId = (n) => "0x" + n.toString(16).padStart(64, "0");

function makeDeal(overrides = {}) {
  return {
    funded: true,
    phase: 1,
    principal: 1_000_000n,
    quotedFee: 0n,
    buyerFeeBps: 0,
    prepaidBuyerFee: 0n,
    fundedAt: 1_000n,
    deliveredAt: 0n,
    disputeOpenedAt: 0n,
    disputeUsed: false,
    escalatedAt: 0n,
    fallbackStartedAt: 0n,
    rulingQueued: false,
    rulingExecuteAt: 0n,
    execDelay: 0n,
    ...overrides,
  };
}

function makeReader({ deals = {}, liabilities = 0n, balance = 0n, fundingPaused = null, head = 1_000, tip = 1_000 } = {}) {
  return {
    async getDeal(_hub, id) {
      const found = deals[id.toLowerCase()];
      if (!found) throw new Error("unreadable deal");
      return found;
    },
    async getLiabilities() {
      return liabilities;
    },
    async getTokenBalance() {
      return balance;
    },
    async getBlockByTag() {
      return { number: 100n, hash: "0x00", parentHash: "0x00", timestamp: head };
    },
    async getLatestBlockNumber() {
      return 100n;
    },
    async getBlock() {
      return { number: 100n, hash: "0x00", parentHash: "0x00", timestamp: tip };
    },
    async getFundingPaused() {
      return fundingPaused;
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
  };
}

async function setup({
  deals = {},
  liabilities = 0n,
  balance = 0n,
  fundingPaused = null,
  head = 1_000,
  tip = 1_000,
  events = [],
} = {}) {
  const store = new TestStore();
  for (const [id] of Object.entries(deals)) {
    await store.createDraft({
      id: `draft-${id}`,
      dealId: id,
      creatorWallet: "0x0000000000000000000000000000000000000001",
      counterpartyHint: null,
      counterpartyAddress: null,
      terms: {},
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "admitted",
    });
  }
  if (events.length > 0) await store.putEvents(events);
  const reader = makeReader({ deals, liabilities, balance, fundingPaused, head, tip });
  return { store, reader, hub: HUB, usdc: USDC };
}

function recordingSink() {
  const sent = [];
  return { sent, async send(alert) { sent.push(alert); return true; } };
}

describe("collectMetrics", () => {
  it("projects solvency, lifecycle and exact-string amounts", async () => {
    const active = dealId(1);
    const settled = dealId(2);
    const env = await setup({
      deals: {
        [active]: makeDeal({ phase: 1 }),
        [settled]: makeDeal({ phase: 9, principal: 9_000_000n, prepaidBuyerFee: 1_000n }),
      },
      liabilities: 100n,
      balance: 50n,
    });
    const snap = await collectMetrics(env, 5_000);

    assert.equal(typeof snap.solvency.liabilitiesUnits, "string");
    assert.equal(snap.solvency.liabilitiesUnits, "100");
    assert.equal(snap.solvency.balanceUnits, "50");
    assert.equal(snap.solvency.ok, false);
    assert.equal(snap.lifecycle.fundedCount, 2);
    assert.equal(snap.lifecycle.settledCount, 1);
    assert.equal(snap.escrow.activeDeals, 1);
    assert.equal(snap.settlements.length, 1);
    assert.equal(snap.settlements[0].fundedUnits, "9001000");
    assert.equal(snap.atUnix, 5_000);
  });

  it("skips unreadable deals without failing the pass", async () => {
    const known = dealId(1);
    const unknown = dealId(99);
    const store = new TestStore();
    await store.createDraft({
      id: "draft-1",
      dealId: known,
      creatorWallet: "0x0",
      counterpartyHint: null,
      counterpartyAddress: null,
      terms: {},
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "admitted",
    });
    await store.createDraft({
      id: "draft-2",
      dealId: unknown,
      creatorWallet: "0x0",
      counterpartyHint: null,
      counterpartyAddress: null,
      terms: {},
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "admitted",
    });
    const env = { store, reader: makeReader({ deals: { [known]: makeDeal() } }), hub: HUB, usdc: USDC };
    const snap = await collectMetrics(env, 1_000);
    assert.equal(snap.lifecycle.fundedCount, 1);
  });

  it("reads indexer lag and evidence counts", async () => {
    const id = dealId(3);
    const env = await setup({
      deals: { [id]: makeDeal() },
      head: 5_000,
      tip: 4_400,
      events: [
        { txHash: "0x1", logIndex: 0, blockNumber: 1n, blockHash: "0x0", contractAddress: HUB, dealId: id, eventName: "EvidenceCommitted", args: {}, orphaned: false },
        { txHash: "0x2", logIndex: 1, blockNumber: 2n, blockHash: "0x0", contractAddress: HUB, dealId: id, eventName: "EvidenceCommitted", args: {}, orphaned: false },
        { txHash: "0x3", logIndex: 2, blockNumber: 3n, blockHash: "0x0", contractAddress: HUB, dealId: id, eventName: "Settled", args: {}, orphaned: false },
      ],
    });
    await env.store.setTip(HUB, { blockNumber: 10n, blockHash: "0x0" });
    const snap = await collectMetrics(env, 5_000);
    assert.equal(snap.ops.indexerLagSeconds, 600);
    assert.equal(snap.storage.evidenceCount, 2);
  });
});

describe("thresholds", () => {
  it("exposes documented defaults", () => {
    assert.equal(TH.largeSettlementUnits, 10_000_000_000n);
    assert.equal(TH.rulingPendingMaxSeconds, 172_800);
    assert.equal(TH.relayFailedMax, 5);
    assert.equal(TH.sponsorDailyTxCap, 50);
    assert.equal(TH.sponsorDailyWeiCap, 0n);
    assert.equal(TH.reviewerInactivitySeconds, 259_200);
    assert.ok(MONITOR_METRICS.includes("ops.relayFailed"));
  });

  it("marks an insolvent snapshot critical", () => {
    const snapshot = {
      atUnix: 1,
      solvency: { liabilitiesUnits: "100", balanceUnits: "90", ok: false, status: "shortfall", reason: null },
      escrow: { activeDeals: 0 },
      rulings: { pendingCount: 0, overdueCount: 0, queuedAgeMaxSeconds: 0 },
      disputes: { inEvidence: 0, inPrimary: 0, inFallback: 0, deadlock: 0 },
      escapes: { eligibleCount: 0 },
      lifecycle: { settledCount: 0, fundedCount: 0, fundingPaused: null },
      ops: { relayQueued: 0, relayFailed: 0, relayUnsigned: 0, sponsors24h: 0, sponsorSpendWeiUnits: "0", indexerLagSeconds: null },
      storage: { evidenceCount: 0 },
      settlements: [],
    };
    const alerts = evaluate(snapshot, TH);
    const solvency = alerts.find((a) => a.id === "solvency");
    assert.equal(solvency.severity, "critical");
    assert.equal(solvency.details.shortfallUnits, "10");
  });

  it("alerts on a large settlement at or above the threshold", async () => {
    const id = dealId(4);
    const env = await setup({ deals: { [id]: makeDeal({ phase: 9, principal: 10_000_000_000n }) } });
    const result = await runMonitoringPass(env, 5_000, {
      sink: recordingSink(),
      deduper: new AlertDeduper(900),
      thresholds: TH,
    });
    assert.ok(result.alerts.some((a) => a.id === `large-settlement:${id}` && a.severity === "warning"));
  });

  it("does not alert on a settlement below the threshold", async () => {
    const id = dealId(5);
    const env = await setup({ deals: { [id]: makeDeal({ phase: 9, principal: 9_999_999_999n }) } });
    const result = await runMonitoringPass(env, 5_000, {
      sink: recordingSink(),
      deduper: new AlertDeduper(900),
      thresholds: TH,
    });
    assert.equal(result.alerts.filter((a) => a.id.startsWith("large-settlement")).length, 0);
  });

  it("flags fallback, escape eligibility and overdue rulings", async () => {
    const fallback = dealId(6);
    const escape = dealId(7);
    const overdue = dealId(8);
    const now = 1_000 + 5_184_000;
    const env = await setup({
      deals: {
        [fallback]: makeDeal({ phase: 6 }),
        [escape]: makeDeal({ phase: 4, escalatedAt: 2_000n, disputeOpenedAt: 1_000n }),
        [overdue]: makeDeal({
          phase: 7,
          rulingQueued: true,
          rulingExecuteAt: 4_000n,
          execDelay: 600n,
          fallbackStartedAt: 3_000n,
        }),
      },
    });
    const snap = await collectMetrics(env, now);
    assert.equal(snap.disputes.inFallback, 1);
    assert.equal(snap.escapes.eligibleCount, 1);
    assert.equal(snap.rulings.pendingCount, 1);
    assert.equal(snap.rulings.overdueCount, 1);
    assert.ok(snap.rulings.queuedAgeMaxSeconds > 259_200);

    const result = await runMonitoringPass(env, now, {
      sink: recordingSink(),
      deduper: new AlertDeduper(900),
      thresholds: TH,
    });
    assert.equal(result.alerts.find((a) => a.id === "fallback-active").severity, "info");
    assert.ok(result.alerts.some((a) => a.id === "escape-eligible" && a.severity === "warning"));
    assert.ok(result.alerts.some((a) => a.id === "ruling-overdue" && a.severity === "warning"));
    assert.ok(result.alerts.some((a) => a.id === "reviewer-inactivity" && a.severity === "warning"));
  });

  it("flags relay failures over max and sponsors over cap", async () => {
    const id = dealId(9);
    const env = await setup({ deals: { [id]: makeDeal() } });
    env.store.seedRelayStatus("failed", 6);
    env.store.seedRelayStatus("unsigned", 2);
    for (let i = 0; i < 51; i += 1) await env.store.recordSponsor(`0x${i.toString(16)}`, id, "test");

    const snap = await collectMetrics(env, 5_000);
    assert.equal(snap.ops.relayFailed, 6);
    assert.equal(snap.ops.relayUnsigned, 2);
    assert.equal(snap.ops.sponsors24h, 51);

    const result = await runMonitoringPass(env, 5_000, {
      sink: recordingSink(),
      deduper: new AlertDeduper(900),
      thresholds: TH,
    });
    assert.ok(result.alerts.some((a) => a.id === "relay-failed" && a.severity === "warning"));
    assert.ok(result.alerts.some((a) => a.id === "sponsor-cap" && a.severity === "warning"));
  });

  it("flags funding paused only when the reader exposes it", async () => {
    const id = dealId(10);
    const env = await setup({ deals: { [id]: makeDeal() }, fundingPaused: true });
    const result = await runMonitoringPass(env, 5_000, {
      sink: recordingSink(),
      deduper: new AlertDeduper(900),
      thresholds: TH,
    });
    assert.equal(result.snapshot.lifecycle.fundingPaused, true);
    assert.ok(result.alerts.some((a) => a.id === "funding-paused" && a.severity === "critical"));

    delete env.reader.getFundingPaused;
    const snap = await collectMetrics(env, 5_000);
    assert.equal(snap.lifecycle.fundingPaused, null);
  });
});

describe("dedupe and delivery", () => {
  it("suppresses repeats within the dedupe window", async () => {
    const id = dealId(11);
    const env = await setup({ deals: { [id]: makeDeal({ phase: 9, principal: 10_000_000_000n }) } });
    const sink = recordingSink();
    const deduper = new AlertDeduper(900);
    const t = 1_000_000;

    const first = await runMonitoringPass(env, t, { sink, deduper, thresholds: TH });
    const second = await runMonitoringPass(env, t + 10, { sink, deduper, thresholds: TH });

    assert.ok(first.delivered >= 1);
    assert.equal(second.delivered, 0);
    assert.ok(second.suppressed >= 1);
    assert.equal(sink.sent.length, first.delivered);

    const later = await runMonitoringPass(env, t + 3_600, { sink, deduper, thresholds: TH });
    assert.ok(later.delivered >= 1);
  });

  it("WebhookSink reports failures (no swallow) and is idempotent only on success", async () => {
    let calls = 0;
    let status = 500;
    const sink = new WebhookSink("https://example.invalid/hook", {
      fetchImpl: async () => {
        calls += 1;
        return { ok: status < 300, status };
      },
      timeoutMs: 50,
      idempotencyWindowSeconds: 900,
    });
    const alert = { id: "x", severity: "warning", summary: "s", details: {}, atUnix: 1_000 };

    assert.equal(await sink.send(alert), false);
    assert.equal(calls, 1);
    assert.equal(sink.failures, 1);
    assert.equal(sink.lastError, "http-500");

    // A failed send must not be remembered as delivered: retry on next pass.
    assert.equal(await sink.send(alert), false);
    assert.equal(calls, 2);

    status = 200;
    assert.equal(await sink.send(alert), true);
    assert.equal(calls, 3);

    // Only now is the same alert within the window suppressed.
    assert.equal(await sink.send(alert), true);
    assert.equal(calls, 3);
  });

  it("WebhookSink reports a network throw as failure", async () => {
    const sink = new WebhookSink("https://example.invalid/hook", {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      timeoutMs: 50,
      idempotencyWindowSeconds: 900,
    });
    assert.equal(await sink.send({ id: "y", severity: "warning", summary: "s", details: {}, atUnix: 1 }), false);
    assert.equal(sink.failures, 1);
    assert.equal(sink.lastError, "TypeError");
  });

  it("redacts credential-looking detail keys and builds a sink from env", async () => {
    const redacted = redactDetails({ webhookUrl: "https://secret", dealId: "0x1", privateKey: "0xdead" });
    assert.equal(redacted.webhookUrl, "[redacted]");
    assert.equal(redacted.privateKey, "[redacted]");
    assert.equal(redacted.dealId, "0x1");

    const empty = makeSinkFromEnv({});
    assert.ok(empty);
    const withWebhook = makeSinkFromEnv({ ALERT_WEBHOOK_URL: "https://example.invalid", ALERT_WEBHOOK_TIMEOUT_MS: "10" });
    assert.ok(withWebhook instanceof CompositeSink);

    const lines = [];
    const logSink = new LogSink({ write: (line) => lines.push(line) });
    await logSink.send({ id: "a", severity: "info", summary: "s", details: { token: "abc" }, atUnix: 1 });
    assert.equal(JSON.parse(lines[0]).details.token, "[redacted]");
  });
});
