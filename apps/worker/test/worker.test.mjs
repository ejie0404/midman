import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@midman/store";
import { QUEUES, describeJob, drainRelayOnce, runPassOnce } from "../dist/index.js";
import { processRelayJob } from "../dist/relay.js";
import { progressionPass, escapePass, dueAction } from "../dist/progression.js";
import { reconcile } from "../dist/reconcile.js";
import { remindersPass } from "../dist/reminders.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEAL = "0x1111111111111111111111111111111111111111111111111111111111111111";
const NO_SPONSOR = { key: null, rpcUrl: null, dailyCapTxs: 50 };

function deal(overrides = {}) {
  return {
    funded: true,
    phase: 1,
    termsHash: "0x00",
    buyer: "0x0000000000000000000000000000000000000001",
    seller: "0x0000000000000000000000000000000000000002",
    principal: 100000000n,
    quotedFee: 500000n,
    buyerFeeBps: 10000,
    prepaidBuyerFee: 500000n,
    deliveryPeriod: 3600,
    inspectionPeriod: 3600,
    fundedAt: 1000000n,
    deliveredAt: 1000100n,
    disputeOpenedAt: 0n,
    disputeUsed: false,
    escalatedAt: 0n,
    fallbackStartedAt: 0n,
    rulingQueued: false,
    rulingExecuteAt: 0n,
    ...overrides,
  };
}

function fakeReader(deals = {}, claims = {}, liabilities = 0n, balance = 0n) {
  return {
    async getDeal(hub, dealId) {
      const found = deals[dealId.toLowerCase()];
      if (!found) throw new Error("Unknown deal");
      return found;
    },
    async getClaim(hub, claimId) {
      return claims[claimId.toLowerCase()] ?? { recipient: "0x0000000000000000000000000000000000000000", amount: 0n };
    },
    async getLiabilities() {
      return liabilities;
    },
    async getTokenBalance() {
      return balance;
    },
    async getLatestBlockNumber() {
      return 1n;
    },
    async getBlock() {
      throw new Error("No blocks");
    },
    async getBlockByTag() {
      return null;
    },
    async getTransactionReceipt() {
      return null;
    },
    async getLogs() {
      return [];
    },
  };
}

async function seedDraftDeal(store, dealId = DEAL) {
  await store.createDraft({
    id: `draft_${dealId.slice(2, 10)}`,
    dealId,
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

describe("worker queues", () => {
  it("declares the four Phase 3 queues with idempotency keys", () => {
    assert.deepEqual([...QUEUES], ["reminders", "relay", "reconciliation", "progression"]);
    assert.equal(describeJob("relay", "0xabc").dedupeKey, "0xabc");
  });
});

describe("relay", () => {
  let store;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("returns unsigned calldata without a sponsor (direct fallback)", async () => {
    await store.enqueueRelay({
      idempotencyKey: "r1",
      queue: "relay",
      action: "finalizeAfterTimeout",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    const reader = fakeReader({ [DEAL]: deal() });
    const result = await processRelayJob({ store, reader, hub: HUB, sponsor: NO_SPONSOR, idempotencyKey: "r1" });
    assert.equal(result.status, "unsigned");
    const job = await store.getRelay("r1");
    assert.equal(job.status, "unsigned");
    assert.match(job.result.data, /^0x[0-9a-f]+$/);
    // Second processing never duplicates: already handled.
    const again = await processRelayJob({ store, reader, hub: HUB, sponsor: NO_SPONSOR, idempotencyKey: "r1" });
    assert.equal(again.status, "already-handled");
  });

  it("skips when chain preconditions fail", async () => {
    await store.enqueueRelay({
      idempotencyKey: "r2",
      queue: "relay",
      action: "openDispute",
      params: { dealId: DEAL, data: "0x1234" },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    // Phase 1 DELIVERED with disputeUsed true is not disputable.
    const reader = fakeReader({ [DEAL]: deal({ disputeUsed: true }) });
    const result = await processRelayJob({ store, reader, hub: HUB, sponsor: NO_SPONSOR, idempotencyKey: "r2" });
    assert.equal(result.status, "skipped");
  });

  it("encodes signed actions from params (deliver/release/mutual)", async () => {
    const zero = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const reader = fakeReader({ [DEAL]: deal({ phase: 0 }) });
    await store.enqueueRelay({
      idempotencyKey: "r3",
      queue: "relay",
      action: "markDelivered",
      params: { dealId: DEAL, manifestHash: zero, nonce: zero, expiresAt: 9999999999, sig: "0x1234" },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    const delivered = await processRelayJob({ store, reader, hub: HUB, sponsor: NO_SPONSOR, idempotencyKey: "r3" });
    assert.equal(delivered.status, "unsigned");
    const job = await store.getRelay("r3");
    assert.match(job.result.data, /^0x[0-9a-f]+$/);
    assert.ok(job.result.data.length > 200);

    const reader1 = fakeReader({ [DEAL]: deal({ phase: 1 }) });
    await store.enqueueRelay({
      idempotencyKey: "r4",
      queue: "relay",
      action: "approveSeller",
      params: { dealId: DEAL, terminalPolicyVersion: zero, nonce: zero, expiresAt: 9999999999, sig: "0x1234" },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    const released = await processRelayJob({ store, reader: reader1, hub: HUB, sponsor: NO_SPONSOR, idempotencyKey: "r4" });
    assert.equal(released.status, "unsigned");

    // Missing signed params -> failed, never submitted.
    await store.enqueueRelay({
      idempotencyKey: "r5",
      queue: "relay",
      action: "mutualSettlement",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    const broken = await processRelayJob({ store, reader: reader1, hub: HUB, sponsor: NO_SPONSOR, idempotencyKey: "r5" });
    assert.equal(broken.status, "failed");
  });
});

describe("progression", () => {
  it("enqueues due timeouts once (deterministic daily keys)", async () => {
    const store = new MemoryStore();
    await seedDraftDeal(store);
    // Delivered at 1000100 + 3600 inspection; now well past + margin.
    const reader = fakeReader({ [DEAL]: deal() });
    const first = await progressionPass({ store, reader, hub: HUB, nowSeconds: 1000100 + 3600 + 3600 + 1 });
    assert.equal(first.length, 1);
    assert.match(first[0], /finalizeAfterTimeout/);
    const second = await progressionPass({ store, reader, hub: HUB, nowSeconds: 1000100 + 3600 + 3600 + 2 });
    assert.equal(second.length, 0);
  });

  it("dueAction maps phases to permissionless calls", () => {
    assert.equal(dueAction(deal({ phase: 0, fundedAt: 0n, deliveryPeriod: 3600 }), 3600 + 3600 + 1), "refundForNonDelivery");
    assert.equal(dueAction(deal({ phase: 1 }), 1000100), null);
    assert.equal(
      dueAction({ funded: true, phase: 2, disputeOpenedAt: 1000n }, 1000 + 172800 + 3600 + 1),
      "lapseDispute",
    );
    assert.equal(dueAction({ funded: true, phase: 7, rulingExecuteAt: 5000n }, 5000), "executeRuling");
    assert.equal(dueAction({ funded: true, phase: 9 }, 99999999), null);
  });

  it("escapePass surfaces fixed-cutoff exits", async () => {
    const store = new MemoryStore();
    await seedDraftDeal(store);
    const reader = fakeReader({
      [DEAL]: deal({ phase: 4, disputeOpenedAt: 1000n, escalatedAt: 2000n }),
    });
    const keys = await escapePass({ store, reader, hub: HUB, nowSeconds: 1000 + 5184000 });
    assert.equal(keys.length, 1);
  });
});

describe("reconciliation", () => {
  it("passes when custody covers liabilities", async () => {
    const result = await reconcile({ reader: fakeReader({}, {}, 100n, 150n), hub: HUB, usdc: USDC });
    assert.equal(result.ok, true);
    assert.equal(result.delta, 50n);
  });

  it("alerts on shortfall", async () => {
    const result = await reconcile({ reader: fakeReader({}, {}, 200n, 150n), hub: HUB, usdc: USDC });
    assert.equal(result.ok, false);
  });
});

describe("reminders", () => {
  it("flags inspection deadlines within 24h", async () => {
    const store = new MemoryStore();
    await seedDraftDeal(store);
    const reader = fakeReader({ [DEAL]: deal() });
    // Inspection ends at 1000100+3600; now is 1h before.
    const due = await remindersPass({ store, reader, hub: HUB, nowSeconds: 1000100 + 3600 - 3600 });
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, "inspection");
    const none = await remindersPass({ store, reader, hub: HUB, nowSeconds: 1000 });
    assert.equal(none.length, 0);
  });
});

describe("runPassOnce", () => {
  it("degrades without rpc or hub", async () => {
    const counts = await runPassOnce({ store: new MemoryStore(), reader: null, hub: null, usdc: USDC }, 1000);
    assert.deepEqual(counts, { relay: 0, progression: 0, escape: 0, reminders: 0 });
  });

  it("drains relay and runs passes", async () => {
    const store = new MemoryStore();
    await seedDraftDeal(store);
    await store.enqueueRelay({
      idempotencyKey: "d1",
      queue: "relay",
      action: "finalizeAfterTimeout",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    const reader = fakeReader({ [DEAL]: deal() }, {}, 100n, 100n);
    const counts = await runPassOnce({ store, reader, hub: HUB, usdc: USDC }, 1000100 + 3600 + 3600 + 1);
    assert.equal(counts.relay, 1);
    assert.ok(counts.progression >= 0);
  });
});
