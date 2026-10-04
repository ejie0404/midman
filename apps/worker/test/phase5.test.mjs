// Phase 5 round-2 tests: mandatory recovery queries, atomic/owned leases,
// tx-identity-before-broadcast, durable sponsor nonces, full payload
// validation, sponsorship accounting, serialized indexing, receipt lifecycle
// and degraded admission. Uses MemoryStore + injected fakes only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, parseAbiItem } from "viem";
import { HUB_ABI } from "@midman/chain";
import { MemoryStore } from "@midman/store";
import {
  RelayProcessor,
  validateRelayJob,
  reconcileSubmitted,
  relayRecoverySnapshot,
} from "../dist/reliability/hardening.js";
import { SponsorNonceCoordinator } from "../dist/reliability/nonce.js";
import { WorkerIndexer } from "../dist/indexer.js";
import { runPassOnce, drainRelayOnce } from "../dist/index.js";
import { assess, durableAdmissionContext } from "../dist/capacity/capacity.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEAL_A = "0x" + "11".repeat(32);
const DEAL_B = "0x" + "22".repeat(32);
const DEAL_EMPTY = "0x" + "00".repeat(32);
const TX = "0x" + "ab".repeat(32);
const TX2 = "0x" + "cd".repeat(32);
const SPONSOR = { key: "0x" + "11".repeat(32), rpcUrl: "http://localhost:8545", dailyCapTxs: 1_000 };

const finalizeData = (dealId) =>
  encodeFunctionData({ abi: HUB_ABI, functionName: "finalizeAfterTimeout", args: [dealId] });

function gasClient({ estimate = 100_000n, baseFee = null, price = 0n } = {}) {
  return {
    async estimateGas() {
      return estimate;
    },
    async getBlock() {
      return { baseFeePerGas: baseFee };
    },
    async getGasPrice() {
      return price;
    },
  };
}

/** Two-phase transport: sign() then sendRaw(), so raw tx is persistable. */
function signingTransport({ start = 5, hash = TX, raw = "0xdeadbeef", sendRawError = null } = {}) {
  const nonces = [];
  const raws = [];
  return {
    nonces,
    raws,
    async getNonce() {
      return start;
    },
    async sign(tx) {
      nonces.push(tx.nonce);
      raws.push(raw);
      return { raw, hash };
    },
    async sendRaw(r) {
      if (sendRawError) throw new Error(sendRawError);
      return hash;
    },
    async send(tx) {
      nonces.push(tx.nonce);
      return hash;
    },
  };
}

/** Legacy transport: one-phase send() that throws. */
function legacyTransport({ start = 5, hash = TX, error = null } = {}) {
  const nonces = [];
  return {
    nonces,
    async getNonce() {
      return start;
    },
    async send(tx) {
      nonces.push(tx.nonce);
      if (error) throw new Error(error);
      return hash;
    },
  };
}

function makeProcessor(store, options = {}) {
  const clock = options.clock ?? 1_000;
  const now = options.now ?? (() => clock);
  const processor = new RelayProcessor({
    store,
    hub: HUB,
    sponsor: options.sponsor ?? null,
    budget: options.budget ?? null,
    abuse: options.abuse ?? null,
    gasClient: options.gasClient ?? null,
    transport: options.transport ?? null,
    now,
    leaseTtlSeconds: options.ttl ?? 120,
    maxAttempts: options.maxAttempts ?? 5,
  });
  return {
    processor,
    advance(seconds) {
      options.clock = (options.clock ?? clock) + seconds;
      if (options.now === undefined) clock += seconds;
    },
  };
}

async function enqueue(store, key, { action = "finalizeAfterTimeout", dealId = DEAL_A, params = {}, calldata } = {}) {
  await store.enqueueRelay({
    idempotencyKey: key,
    queue: "relay",
    action,
    params: { dealId, data: calldata ?? finalizeData(dealId), ...params },
    status: "queued",
    attempts: 0,
    txHash: null,
    result: null,
  });
}

function fakeReader(overrides = {}) {
  return {
    async getDeal() {
      return {
        funded: true,
        phase: 1,
        buyer: DEAL_A,
        seller: DEAL_B,
        principal: 100000000n,
        fundedAt: 1000000n,
        escalatedAt: 0n,
      };
    },
    async getClaim() {
      return { recipient: "0x0000000000000000000000000000000000000000", amount: 0n };
    },
    async getLiabilities() {
      return 0n;
    },
    async getTokenBalance() {
      return 0n;
    },
    async getLatestBlockNumber() {
      return 1n;
    },
    async getBlock(n) {
      return { number: BigInt(n), hash: "0x" + "01".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: 1 };
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
    ...overrides,
  };
}

describe("Phase 5 · mandatory recovery queries", () => {
  it("listRelayByStatus finds processing, submitted, failed and queued jobs", async () => {
    const store = new MemoryStore();
    await enqueue(store, "q", {});
    await enqueue(store, "p", {});
    await enqueue(store, "s", {});
    await enqueue(store, "f", {});
    await store.claimRelayLease("p", "w", 60);
    await store.finishRelay("s", "submitted", TX, null);
    await store.finishRelay("f", "failed", null, { reason: "boom" });

    assert.equal((await store.listRelayByStatus("queued", 10)).length, 1);
    assert.equal((await store.listRelayByStatus("processing", 10))[0].idempotencyKey, "p");
    assert.equal((await store.listRelayByStatus("submitted", 10))[0].idempotencyKey, "s");
    assert.equal((await store.listRelayByStatus("failed", 10))[0].idempotencyKey, "f");
    assert.equal((await store.listRelayByStatus("queued", 0)).length, 0);
  });

  it("relayRecoverySnapshot never silently returns empty while work exists", async () => {
    const store = new MemoryStore();
    await enqueue(store, "p1", {});
    await store.claimRelayLease("p1", "w", 60);
    await enqueue(store, "s1", {});
    await store.finishRelay("s1", "submitted", TX, null);
    await enqueue(store, "f1", {});
    await store.finishRelay("f1", "failed", null, { reason: "x" });
    const snap = await relayRecoverySnapshot(store);
    assert.deepEqual(snap, { queued: 0, processing: 1, submitted: 1, unresolved: 0, failed: 1 });
  });

  it("drainRelayOnce reaps expired leases before draining", async () => {
    const store = new MemoryStore();
    await enqueue(store, "expired", {});
    await store.claimRelayLease("expired", "dead", -1); // expired immediately
    const env = { store, reader: fakeReader(), hub: HUB, usdc: USDC };
    // no sponsor => unsigned, proving the job was recovered and processed
    const outcomes = await drainRelayOnce(env);
    assert.ok(outcomes.some((o) => o.key === "expired"));
  });
});

describe("Phase 5 · atomic leases and ownership", () => {
  it("a live lease held by another worker is never stolen", async () => {
    const store = new MemoryStore();
    await enqueue(store, "held", {});
    // A real-time clock so the lease expiry comparison is meaningful.
    const before = { now: () => Math.floor(Date.now() / 1_000) };
    await store.claimRelayLease("held", "other-worker", 300);
    const transport = signingTransport();
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport, ...before });
    const result = await processor.process("held");
    assert.equal(result.status, "already-handled");
    assert.equal(result.reason, "lease-held");
    assert.equal(transport.nonces.length, 0);
  });

  it("reclaims a stale lease after expiry (crash recovery)", async () => {
    const store = new MemoryStore();
    await enqueue(store, "stale", {});
    await store.claimRelayLease("stale", "dead-worker", -1); // already expired
    const transport = signingTransport({ hash: TX });
    const { processor } = makeProcessor(store, {
      sponsor: SPONSOR,
      gasClient: gasClient(),
      transport,
      now: () => Math.floor(Date.now() / 1_000),
    });
    const result = await processor.process("stale");
    assert.equal(result.status, "submitted");
    assert.equal((await store.getRelay("stale")).leaseOwner, null);
  });

  it("renewRelayLease rejects a stale owner and accepts the holder", async () => {
    const store = new MemoryStore();
    await enqueue(store, "own", {});
    await store.claimRelayLease("own", "worker-a", 60);
    assert.equal(await store.renewRelayLease("own", "worker-a", 120), true);
    assert.equal(await store.renewRelayLease("own", "worker-b", 120), false);
  });
});

describe("Phase 5 · durable sponsor nonce coordination", () => {
  it("two workers sharing a queue+sponsor never reuse a nonce", async () => {
    const store = new MemoryStore();
    await enqueue(store, "n1", {});
    await enqueue(store, "n2", {});
    const tA = signingTransport({ start: 5, hash: TX });
    const tB = signingTransport({ start: 5, hash: TX2 });
    const a = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport: tA });
    const b = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport: tB });
    const [r1, r2] = await Promise.all([a.processor.process("n1"), b.processor.process("n2")]);
    assert.equal(r1.status, "submitted");
    assert.equal(r2.status, "submitted");
    const all = [...tA.nonces, ...tB.nonces].sort((x, y) => x - y);
    assert.equal(all.length, 2);
    assert.notEqual(all[0], all[1]);
    assert.deepEqual(all, [5, 6]);
  });

  it("SponsorNonceCoordinator persists the high-water mark across instances", async () => {
    const store = new MemoryStore();
    const sync = async () => 10;
    const first = new SponsorNonceCoordinator(store, sync);
    assert.equal(await first.allocate(SPONSOR.key), 10);
    const restarted = new SponsorNonceCoordinator(store, async () => 999);
    assert.equal(await restarted.allocate(SPONSOR.key), 11);
    assert.equal(await restarted.reserved(SPONSOR.key), 11);
  });
});

describe("Phase 5 · tx identity persisted before broadcast", () => {
  it("persists nonce, hash and raw signed tx before sendRaw and survives a timeout", async () => {
    const store = new MemoryStore();
    await enqueue(store, "t1", {});
    const transport = signingTransport({ hash: TX, raw: "0xfeed", sendRawError: "timeout" });
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport });
    const result = await processor.process("t1");
    assert.equal(result.status, "submitted");
    assert.equal(result.reason, "unresolved");
    const job = await store.getRelay("t1");
    assert.equal(job.status, "submitted"); // never 'failed'
    assert.equal(job.txHash, TX);
    assert.equal(job.result.attempt.raw, "0xfeed");
    assert.equal(typeof job.result.attempt.nonce, "number");
    assert.equal(transport.nonces.length, 1);
  });

  it("rebroadcasts the SAME signed transaction after a timeout", async () => {
    const store = new MemoryStore();
    await enqueue(store, "t2", {});
    const failing = signingTransport({ hash: TX, raw: "0xfeed", sendRawError: "timeout" });
    const first = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport: failing });
    await first.processor.process("t2");

    const ok = signingTransport({ hash: TX });
    const restarted = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport: ok });
    const result = await restarted.processor.rebroadcast("t2");
    assert.equal(result.status, "submitted");
    assert.equal(result.txHash, TX);
  });

  it("restart after lease, before broadcast and after receipt", async () => {
    const store = new MemoryStore();
    // after receipt: confirmed job is terminal and never rebuilt
    await enqueue(store, "done", {});
    await store.finishRelay("done", "finalized", TX, null);
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient() });
    assert.equal((await processor.process("done")).status, "already-handled");

    // before broadcast: a queued job with no persisted attempt is processed fresh
    await enqueue(store, "fresh", {});
    const transport = signingTransport({ hash: TX });
    const live = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport });
    assert.equal((await live.processor.process("fresh")).status, "submitted");
  });
});

describe("Phase 5 · full relay payload validation", () => {
  it("accepts calldata supplied under the API's `calldata` field", () => {
    const data = finalizeData(DEAL_A);
    const result = validateRelayJob({ action: "finalizeAfterTimeout", params: { dealId: DEAL_A, calldata: data } });
    assert.equal(result.ok, true);
    assert.equal(result.functionName, "finalizeAfterTimeout");
  });

  it("rejects deal-A metadata paired with deal-B calldata", () => {
    const result = validateRelayJob(
      { action: "finalizeAfterTimeout", params: { dealId: DEAL_A } },
      finalizeData(DEAL_B),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "deal-mismatch");
  });

  it("rejects an action/calldata function mismatch and an explicit wrong target", () => {
    assert.equal(
      validateRelayJob({ action: "executeRuling", params: { dealId: DEAL_A } }, finalizeData(DEAL_A)).reason,
      "action-calldata-mismatch",
    );
    assert.equal(
      validateRelayJob(
        { action: "finalizeAfterTimeout", params: { dealId: DEAL_A, to: DEAL_B } },
        finalizeData(DEAL_A),
        { hub: HUB },
      ).reason,
      "target-mismatch",
    );
  });

  it("requires a full fund struct (not a bare selector) for fund jobs", () => {
    const result = validateRelayJob(
      { action: "fund", params: { dealId: DEAL_A } },
      finalizeData(DEAL_A),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "action-calldata-mismatch");
  });

  it("process() fails a mismatched deal instead of broadcasting", async () => {
    const store = new MemoryStore();
    await enqueue(store, "mm", { dealId: DEAL_A, calldata: finalizeData(DEAL_B) });
    const transport = signingTransport();
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport });
    const result = await processor.process("mm");
    assert.equal(result.status, "failed");
    assert.match(result.reason, /deal-mismatch/);
    assert.equal(transport.nonces.length, 0);
  });
});

describe("Phase 5 · sponsorship accounting", () => {
  it("reserves budget atomically so concurrent requests cannot over-spend", async () => {
    const store = new MemoryStore();
    await enqueue(store, "b1", {});
    await enqueue(store, "b2", {});
    const sponsor = { ...SPONSOR, dailyCapTxs: 1 };
    const t1 = signingTransport({ hash: TX });
    const t2 = signingTransport({ hash: TX2 });
    const p1 = makeProcessor(store, { sponsor, gasClient: gasClient(), transport: t1 });
    const p2 = makeProcessor(store, { sponsor, gasClient: gasClient(), transport: t2 });
    const [r1, r2] = await Promise.all([p1.processor.process("b1"), p2.processor.process("b2")]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, ["submitted", "unsigned"]);
    const stopped = [r1, r2].find((r) => r.status === "unsigned");
    assert.match(stopped.reason, /daily-cap|budget-exhausted/);
  });

  it("preserves recorded spend across a restart", async () => {
    const store = new MemoryStore();
    await enqueue(store, "spend", {});
    const sponsor = { ...SPONSOR, dailyCapTxs: 1 };
    const first = makeProcessor(store, {
      sponsor,
      gasClient: gasClient(),
      transport: signingTransport({ hash: TX }),
    });
    assert.equal((await first.processor.process("spend")).status, "submitted");
    assert.equal(await store.countSponsorsSince("2000-01-01T00:00:00.000Z"), 1);

    await enqueue(store, "spend2", {});
    const restarted = makeProcessor(store, {
      sponsor,
      gasClient: gasClient(),
      transport: signingTransport({ hash: TX2 }),
    });
    const result = await restarted.processor.process("spend2");
    assert.equal(result.status, "unsigned");
    assert.equal(result.reason, "daily-cap");
  });
});

describe("Phase 5 · receipt lifecycle", () => {
  it("does not permanently confirm from a single receipt; finality is terminal", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rc", {});
    await store.finishRelay("rc", "submitted", TX, null);
    const tentative = {
      async getTransactionReceipt() {
        return { status: true, blockNumber: 10n };
      },
      async getBlockByTag() {
        return { number: 5n, hash: "0x01", parentHash: "0x00" };
      },
    };
    const first = await reconcileSubmitted(store, tentative, []);
    assert.equal(first[0].status, "confirmed");
    assert.equal((await store.getRelay("rc")).status, "confirmed");

    const finalized = {
      async getTransactionReceipt() {
        return { status: true, blockNumber: 10n };
      },
      async getBlockByTag() {
        return { number: 12n, hash: "0x02", parentHash: "0x01" };
      },
    };
    const second = await reconcileSubmitted(store, finalized, []);
    assert.equal(second[0].status, "finalized");
    assert.equal((await store.getRelay("rc")).status, "finalized");
  });

  it("orphans a previously-confirmed job whose receipt disappears (reorg)", async () => {
    const store = new MemoryStore();
    await enqueue(store, "orphan", {});
    await store.finishRelay("orphan", "confirmed", TX, { blockNumber: "10" });
    const reader = {
      async getTransactionReceipt() {
        return null;
      },
    };
    const outcomes = await reconcileSubmitted(store, reader, []);
    assert.equal(outcomes[0].status, "orphaned");
    assert.equal((await store.getRelay("orphan")).status, "orphaned");
  });

  it("marks a reverted receipt as reverted (terminal)", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rev", {});
    await store.finishRelay("rev", "submitted", TX, null);
    const reader = {
      async getTransactionReceipt() {
        return { status: false, blockNumber: 3n };
      },
    };
    const outcomes = await reconcileSubmitted(store, reader, []);
    assert.equal(outcomes[0].status, "reverted");
  });
});

describe("Phase 5 · indexing serialization and projection reorg", () => {
  function chain(entries) {
    return new Map(entries.map(([n, hash, parent]) => [n, { hash, parentHash: parent }]));
  }
  const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;

  class FakeReader {
    constructor(blocks, logs) {
      this.blocks = blocks;
      this.logs = logs;
      this.active = 0;
      this.maxActive = 0;
    }
    async getLatestBlockNumber() {
      return BigInt(Math.max(...this.blocks.keys()));
    }
    async getBlock(number) {
      const block = this.blocks.get(Number(number));
      if (!block) throw new Error(`unknown block ${number}`);
      return { number: BigInt(number), hash: block.hash, parentHash: block.parentHash, timestamp: 1 };
    }
    async getLogs({ fromBlock, toBlock }) {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise((r) => setTimeout(r, 20));
      const out = this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      this.active -= 1;
      return out;
    }
    async getBlockByTag() {
      return null;
    }
    async getTransactionReceipt() {
      return null;
    }
    async getDeal() {
      throw new Error("no chain");
    }
    async getClaim() {
      throw new Error("no chain");
    }
    async getLiabilities() {
      throw new Error("no chain");
    }
    async getTokenBalance() {
      throw new Error("no chain");
    }
  }

  function hubLog(blockNumber, blockHash, { txHash = TX, logIndex = 0, dealId = DEAL_A } = {}) {
    // Use a real ABI event so decodeHubLog succeeds.
    const topics = encodeEventTopics({
      abi: [parseAbiItem("event DealFunded(bytes32 indexed dealId, bytes32 agreementDigest, uint256 principal, uint256 funded)")],
      args: { dealId },
    });
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [dealId, 1n, 2n],
    );
    return {
      blockNumber: BigInt(blockNumber),
      blockHash,
      transactionHash: txHash,
      logIndex,
      address: HUB,
      data,
      topics,
      removed: false,
    };
  }

  it("serializes overlapping ticks (no concurrent getLogs)", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, H(100), H(100)],
      [1, H(101), H(100)],
      [2, H(102), H(101)],
    ]);
    const reader = new FakeReader(blocks, []);
    const indexer = new WorkerIndexer(reader, store, { hub: HUB, fromBlock: 0n });
    await Promise.all([indexer.tick(), indexer.tick()]);
    assert.equal(reader.maxActive, 1);
  });

  it("corrects job + projection when an included tx is reorged", async () => {
    const store = new MemoryStore();
    const B2 = H(102);
    const B2P = H(202);
    const B3 = H(103);
    const original = chain([
      [0, H(100), H(100)],
      [1, H(101), H(100)],
      [2, B2, H(101)],
    ]);
    const reader1 = new FakeReader(original, [hubLog(2, B2, { txHash: TX })]);
    const indexer1 = new WorkerIndexer(reader1, store, { hub: HUB, fromBlock: 0n });
    await indexer1.tick();
    assert.equal((await store.getEventsByDeal(DEAL_A)).length, 1);

    // The included tx also has a relay job; a receipt makes it tentatively confirmed.
    await enqueue(store, "included", {});
    await store.finishRelay("included", "submitted", TX, null);
    const confirmed = await reconcileSubmitted(store, {
      async getTransactionReceipt() {
        return { status: true, blockNumber: 2n };
      },
      async getBlockByTag() {
        return null;
      },
    }, []);
    assert.equal(confirmed[0].status, "confirmed");

    // Reorg: same height, different block, event gone.
    const replaced = chain([
      [0, H(100), H(100)],
      [1, H(101), H(100)],
      [2, B2P, H(101)],
      [3, B3, B2P],
    ]);
    const reader2 = new FakeReader(replaced, []);
    const indexer2 = new WorkerIndexer(reader2, store, { hub: HUB, fromBlock: 0n });
    const result = await indexer2.tick();
    assert.equal(result.reorg, true);
    assert.equal((await store.getEventsByDeal(DEAL_A)).length, 0);

    const orphaned = await reconcileSubmitted(store, {
      async getTransactionReceipt() {
        return null;
      },
    }, []);
    assert.equal(orphaned[0].status, "orphaned");
    assert.equal((await store.getRelay("included")).status, "orphaned");
  });
});

describe("Phase 5 · in-process single-flight passes", () => {
  it("drops an overlapping timer pass instead of running it concurrently", async () => {
    const store = new MemoryStore();
    let blockCalls = 0;
    const reader = fakeReader({
      async getLatestBlockNumber() {
        blockCalls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return 1n;
      },
    });
    const env = { store, reader, hub: HUB, usdc: USDC };
    const [first, second] = await Promise.all([runPassOnce(env, 1_000), runPassOnce(env, 1_001)]);
    assert.equal((first.overlapped ?? 0) + (second.overlapped ?? 0), 1);
    assert.ok(blockCalls >= 1);
  });
});

describe("Phase 5 · degraded admission/capacity", () => {
  const limits = { activeEscalated: 20, openRelayJobs: 50, evidenceCount: 100, reviewerPending: 10 };

  it("grades missing probes as degraded (unknown, not zero usage)", () => {
    const result = assess(
      { activeEscalated: 0, openRelayJobs: 0, evidenceCount: 0, reviewerPending: 0, probesMissing: ["evidenceCount"] },
      limits,
    );
    assert.equal(result.state, "amber");
    assert.ok(result.notes.some((n) => n.includes("unknown, not zero")));
  });

  it("durableAdmissionContext fails closed (degraded) when probes are missing", async () => {
    const ctx = await durableAdmissionContext({
      store: new MemoryStore(),
      reader: null,
      hub: null,
      buyer: DEAL_A,
      seller: DEAL_B,
      nowSeconds: 1_000,
    });
    assert.equal(ctx.degraded, true);
  });

  it("durableAdmissionContext derives active-escalated and pair exposure from chain", async () => {
    const store = new MemoryStore();
    await store.recordDealMeta(DEAL_A, "test");
    const reader = fakeReader({
      async getDeal() {
        return {
          funded: true,
          phase: 5,
          escalatedAt: 10n,
          buyer: DEAL_A,
          seller: DEAL_B,
          principal: 123n,
          fundedAt: 5_000n,
        };
      },
    });
    const ctx = await durableAdmissionContext({
      store,
      reader,
      hub: HUB,
      buyer: DEAL_A,
      seller: DEAL_B,
      nowSeconds: 10_000,
    });
    assert.equal(ctx.degraded, false);
    assert.equal(ctx.activeEscalatedCount, 1);
    assert.equal(ctx.pairExposure24hUnits, 123n);
  });
});
