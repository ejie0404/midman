import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryStore } from "@midman/store";
import {
  AdmissionControls,
  admissionLimitsFromEnv,
  aggregateExposure,
  V1_CATEGORIES,
} from "../dist/capacity/admission.js";
import { CapacityMeter, assess, pauseRecommendation } from "../dist/capacity/capacity.js";
import {
  AesGcmBlobStore,
  restoreDrill,
  restoreDrillWithLocalStore,
} from "../dist/drills/restore.js";
import { outageDrill, simulatedOutageDeps } from "../dist/drills/outage.js";
import { runAllDrills } from "../dist/drills/index.js";

const BUYER = "0x0000000000000000000000000000000000000001";
const SELLER = "0x0000000000000000000000000000000000000002";
const OTHER = "0x0000000000000000000000000000000000000009";
const DEAL = "0x1111111111111111111111111111111111111111111111111111111111111111";
const HUB = "0x00000000000000000000000000000000000000aa";

function admissionCtx(overrides = {}) {
  return {
    category: "GAME_ITEM",
    buyer: BUYER,
    seller: SELLER,
    principalUnits: 5_000_000n,
    activeEscalatedCount: 0,
    pairExposure24hUnits: 0n,
    ...overrides,
  };
}

function seedDraft(store) {
  return store.createDraft({
    id: "draft_capacity",
    dealId: DEAL,
    creatorWallet: BUYER,
    counterpartyHint: null,
    counterpartyAddress: null,
    terms: {},
    signatures: {},
    admission: null,
    revocationNote: null,
    status: "admitted",
  });
}

describe("admission controls (P-14)", () => {
  it("admits an allowlisted category and reports the P-14 defaults", () => {
    const controls = new AdmissionControls(admissionLimitsFromEnv({}));
    const decision = controls.admit(admissionCtx());
    assert.equal(decision.ok, true);
    assert.equal(decision.reason, "ok");
    assert.equal(decision.limits.maxConcurrentEscalatedPerPod, 5);
    assert.equal(decision.limits.maxConcurrentEscalatedProtocol, 20);
    assert.equal(decision.limits.aggregatePairCapUnitsPer24h, 10_000_000_000n);
    assert.deepEqual(decision.limits.categoryAllowlist, [...V1_CATEGORIES]);
  });

  it("rejects a category outside the allowlist", () => {
    const controls = new AdmissionControls();
    const decision = controls.admit(admissionCtx({ category: "PHYSICAL_GOOD" }));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "category-not-allowlisted");
  });

  it("enforces the 5 USDC minimum principal", () => {
    const controls = new AdmissionControls();
    const low = controls.admit(admissionCtx({ principalUnits: 4_999_999n }));
    assert.equal(low.ok, false);
    assert.equal(low.reason, "principal-below-minimum");
    const exact = controls.admit(admissionCtx({ principalUnits: 5_000_000n }));
    assert.equal(exact.ok, true);
  });

  it("rejects at the per-pod concurrent escalation cap", () => {
    const controls = new AdmissionControls();
    const decision = controls.admit(
      admissionCtx({ activeEscalatedCountPerPod: 5, activeEscalatedCount: 0 }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "per-pod-concurrency-limit");
  });

  it("rejects at the protocol-wide concurrent escalation cap", () => {
    const controls = new AdmissionControls();
    const decision = controls.admit(admissionCtx({ activeEscalatedCount: 20 }));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "protocol-concurrency-limit");
  });

  it("rejects pair exposure that would exceed the $10k/24h cap", () => {
    const controls = new AdmissionControls();
    const over = controls.admit(
      admissionCtx({ pairExposure24hUnits: 9_000_000_000n, principalUnits: 2_000_000_000n }),
    );
    assert.equal(over.ok, false);
    assert.equal(over.reason, "pair-exposure-limit");
    const atCap = controls.admit(
      admissionCtx({ pairExposure24hUnits: 9_000_000_000n, principalUnits: 1_000_000_000n }),
    );
    assert.equal(atCap.ok, true);
  });

  it("reads limits and the category allowlist from env", () => {
    const limits = admissionLimitsFromEnv({
      MAX_CONCURRENT_ESCALATED_PER_POD: "3",
      MAX_CONCURRENT_ESCALATED_PROTOCOL: "7",
      AGGREGATE_PAIR_CAP_UNITS_PER_24H: "5000000",
      CATEGORY_ALLOWLIST: "INSTANT_CODE, SERVICE",
    });
    assert.equal(limits.maxConcurrentEscalatedPerPod, 3);
    assert.equal(limits.maxConcurrentEscalatedProtocol, 7);
    assert.equal(limits.aggregatePairCapUnitsPer24h, 5_000_000n);
    assert.deepEqual(limits.categoryAllowlist, ["INSTANT_CODE", "SERVICE"]);
    const controls = new AdmissionControls(limits);
    assert.equal(
      controls.admit(admissionCtx({ category: "GAME_ITEM" })).reason,
      "category-not-allowlisted",
    );
    assert.equal(controls.admit(admissionCtx({ category: "SERVICE" })).ok, true);
  });

  it("computes pair exposure with exact bigint amounts and the fundedAt filter", () => {
    const deals = [
      { buyer: BUYER, seller: SELLER, principal: "4000000000", fundedAt: 1_000n },
      { buyer: SELLER, seller: BUYER, principal: "2500000000", fundedAt: 2_000n },
      { buyer: BUYER, seller: SELLER, principal: "9999999999", fundedAt: 500n },
      { buyer: BUYER, seller: OTHER, principal: "9999999999", fundedAt: 3_000n },
    ];
    const total = aggregateExposure(deals, BUYER, SELLER, 1_000n);
    assert.equal(total, 6_500_000_000n);
    assert.equal(total.toString(), "6500000000");
    assert.equal(aggregateExposure(deals, BUYER, SELLER, 2_001n), 0n);
    assert.equal(aggregateExposure(deals, BUYER, SELLER, 500n).toString(), "16499999999");
  });
});

describe("capacity meter + pause policy", () => {
  const limits = {
    activeEscalated: 20,
    openRelayJobs: 50,
    evidenceCount: 100,
    reviewerPending: 10,
  };

  it("grades green below 80% of every cap", () => {
    const load = { activeEscalated: 1, openRelayJobs: 2, evidenceCount: 3, reviewerPending: 4 };
    const result = assess(load, limits);
    assert.equal(result.state, "green");
    assert.deepEqual(result.notes, []);
    assert.equal(pauseRecommendation(result), false);
  });

  it("grades amber at exactly 80% of a cap", () => {
    const load = { activeEscalated: 16, openRelayJobs: 2, evidenceCount: 3, reviewerPending: 4 };
    const result = assess(load, limits);
    assert.equal(result.state, "amber");
    assert.ok(result.notes.some((note) => note.includes("activeEscalated")));
    assert.equal(pauseRecommendation(result), false);
  });

  it("grades red and recommends a funding-only pause when a hard cap is exceeded", () => {
    const load = { activeEscalated: 21, openRelayJobs: 2, evidenceCount: 3, reviewerPending: 4 };
    const result = assess(load, limits);
    assert.equal(result.state, "red");
    assert.equal(pauseRecommendation(result), true);
    assert.ok(result.notes.some((note) => note.includes("preserved and immutable")));
  });

  it("evaluates the optional apiWindowQps cap only when present", () => {
    const load = { activeEscalated: 0, openRelayJobs: 0, evidenceCount: 0, reviewerPending: 0, apiWindowQps: 90 };
    const withQps = assess(load, { ...limits, apiWindowQps: 100 });
    assert.equal(withQps.state, "amber");
    const withoutQps = assess(load, limits);
    assert.equal(withoutQps.state, "green");
  });

  it("measures load from the store and reader", async () => {
    const store = new MemoryStore();
    await seedDraft(store);
    await store.enqueueRelay({
      idempotencyKey: "j1",
      queue: "relay",
      action: "finalizeAfterTimeout",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    await store.enqueueRelay({
      idempotencyKey: "j2",
      queue: "relay",
      action: "lapseDispute",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    await store.enqueueRelay({
      idempotencyKey: "j3",
      queue: "reconciliation",
      action: "noop",
      params: {},
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });

    const reader = {
      async getDeal() {
        return { funded: true, phase: 5, escalatedAt: 12_345n };
      },
    };
    const meter = new CapacityMeter({
      store,
      reader,
      hub: HUB,
      evidenceCount: () => 7,
      reviewerPending: async () => 2,
    });
    const load = await meter.measure();
    assert.equal(load.openRelayJobs, 2);
    assert.equal(load.activeEscalated, 1);
    assert.equal(load.evidenceCount, 7);
    assert.equal(load.reviewerPending, 2);
    assert.equal(load.apiWindowQps, undefined);

    const degraded = new CapacityMeter({ store, reader: null, hub: null, apiWindowQps: () => 42 });
    const degradedLoad = await degraded.measure();
    assert.equal(degradedLoad.activeEscalated, 0);
    assert.equal(degradedLoad.apiWindowQps, 42);
  });
});

describe("restore drill", () => {
  it("recovers byte-identical data and keys with the local AES store", async () => {
    const result = await restoreDrillWithLocalStore();
    assert.equal(result.ok, true);
    assert.ok(result.steps.length >= 6);
    const names = result.steps.map((step) => step.name);
    for (const expected of [
      "export-wrapped-dek",
      "export-encrypted-blob",
      "delete-ciphertext",
      "reimport-wrapped-dek",
      "restore-encrypted-blob",
      "re-download-and-rehash",
    ]) {
      assert.ok(names.includes(expected), `missing step ${expected}`);
    }
    assert.ok(result.steps.every((step) => step.ok));
  });

  it("detects tampering and fails closed", async () => {
    const kek = Buffer.alloc(32, 7);
    const store = new AesGcmBlobStore(kek);
    const bytes = Buffer.from("tamper-target", "utf8");
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const originalGet = store.get.bind(store);
    store.get = async (dealId, hash) => {
      const value = await originalGet(dealId, hash);
      if (!value) return value;
      const copy = Buffer.from(value);
      copy[0] ^= 0xff;
      return copy;
    };
    const result = await restoreDrill({ blobStore: store, dealId: "dealtamper", fileHash, bytes });
    assert.equal(result.ok, false);
    const rehash = result.steps.find((step) => step.name === "re-download-and-rehash");
    assert.equal(rehash.ok, false);
  });
});

describe("outage drill", () => {
  it("covers sequencer, RPC failover and token-restriction scenarios", async () => {
    const result = await outageDrill(simulatedOutageDeps());
    assert.equal(result.ok, true);
    assert.equal(result.steps.length, 6);
    assert.ok(result.steps.every((step) => step.ok));
    const names = result.steps.map((step) => step.name);
    assert.ok(names.includes("sequencer-timeout-fails-closed"));
    assert.ok(names.includes("sequencer-dispute-admission-open"));
    assert.ok(names.includes("rpc-pool-failover"));
    assert.ok(names.includes("token-liability-preserved"));
  });
});

describe("runAllDrills", () => {
  it("aggregates both drills and reports overall status", async () => {
    const result = await runAllDrills({
      restore: () => restoreDrillWithLocalStore(),
      outage: () => outageDrill(simulatedOutageDeps()),
    });
    assert.equal(result.ok, true);
    assert.equal(result.drills.length, 2);

    const failed = await runAllDrills({
      restore: () => ({ ok: false, steps: [], detail: "nope" }),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.drills.length, 1);
  });
});
