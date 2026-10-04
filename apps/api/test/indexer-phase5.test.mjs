// Phase 5 indexer tests: serialized ticks/replays, consistent
// events+cursor commits, same-height reorgs, re-inclusion, backward-moving
// heads, empty blocks, and mandatory relay-status recovery queries.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from "viem";
import { MemoryStore } from "../dist/db.js";
import { Indexer } from "../dist/indexer.js";

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";
const DEAL = `0x${"11".repeat(32)}`;
const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;

const B0 = H(100);
const B1 = H(101);
const B2 = H(102);
const B3 = H(103);
const B2P = H(202);
const B3P = H(203);
const TX_A = H(0x2a);
const TX_B = H(0x2b);

class FakeReader {
  constructor(blocks, logs = [], { delay = 0 } = {}) {
    this.blocks = blocks;
    this.logs = logs;
    this.delay = delay;
    this.active = 0;
    this.maxActive = 0;
  }
  async getLatestBlockNumber() {
    return BigInt(Math.max(...this.blocks.keys()));
  }
  async getBlock(number) {
    const block = this.blocks.get(Number(number));
    if (!block) throw new Error(`Unknown block ${number}`);
    return { number: BigInt(number), hash: block.hash, parentHash: block.parentHash, timestamp: 1 };
  }
  async getBlockByTag() {
    return null;
  }
  async getTransactionReceipt() {
    return null;
  }
  async getLogs({ fromBlock, toBlock }) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
    const out = this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    this.active -= 1;
    return out;
  }
  async getDeal() {
    throw new Error("No chain");
  }
  async getClaim() {
    throw new Error("No chain");
  }
  async getLiabilities() {
    throw new Error("No chain");
  }
  async getTokenBalance() {
    throw new Error("No chain");
  }
}

const chain = (entries) => new Map(entries.map(([n, hash, parent]) => [n, { hash, parentHash: parent }]));

function hubLog(blockNumber, blockHash, { dealId = DEAL, txHash = TX_A, logIndex = 0 } = {}) {
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
    address: HUB_ADDR,
    data,
    topics,
    removed: false,
  };
}

function ev(txHash, logIndex, blockNumber, blockHash, dealId, orphaned = false) {
  return {
    txHash,
    logIndex,
    blockNumber: BigInt(blockNumber),
    blockHash,
    contractAddress: HUB_ADDR,
    dealId,
    eventName: "DealFunded",
    args: { dealId },
    orphaned,
  };
}

describe("Phase 5 indexer · serialization", () => {
  it("serializes overlapping ticks so getLogs never runs concurrently", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
    ]);
    const reader = new FakeReader(blocks, [hubLog(2, B2)], { delay: 25 });
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });
    await Promise.all([indexer.tick(), indexer.tick()]);
    assert.equal(reader.maxActive, 1);
  });

  it("serializes replay behind an in-flight tick", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
    ]);
    const reader = new FakeReader(blocks, [], { delay: 20 });
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });
    const tick = indexer.tick();
    const replay = indexer.replay(1n);
    await Promise.all([tick, replay]);
    // Replay runs after the tick (serialized) and primes the tip at block 0.
    assert.equal((await store.getTip(HUB_ADDR))?.blockNumber, 0n);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 0);
  });
});

describe("Phase 5 indexer · cursor + projection consistency", () => {
  it("commits events and the cursor together and advances on empty blocks", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
    ]);
    const reader = new FakeReader(blocks, [hubLog(2, B2)]);
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });
    const result = await indexer.tick();
    assert.equal(result.added, 1);
    assert.equal(result.scannedTo, 3n);
    const tip = await store.getTip(HUB_ADDR);
    assert.equal(tip.blockNumber, result.scannedTo);
    assert.equal(tip.blockHash, B3);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 1);

    // Next tick with no new blocks: no events, cursor unchanged.
    const again = await indexer.tick();
    assert.equal(again.added, 0);
    assert.equal(again.scannedTo, 3n);
  });
});

describe("Phase 5 indexer · reorgs and re-inclusion", () => {
  it("detects a same-height tip replacement and rescans", async () => {
    const store = new MemoryStore();
    const original = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
    ]);
    await new Indexer(new FakeReader(original, [hubLog(2, B2, { txHash: TX_A })]), store, {
      hub: HUB_ADDR,
      fromBlock: 0n,
    }).tick();

    const replaced = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2P, B1],
    ]);
    const result = await new Indexer(new FakeReader(replaced, [hubLog(2, B2P, { txHash: TX_B })]), store, {
      hub: HUB_ADDR,
      fromBlock: 0n,
    }).tick();

    assert.equal(result.reorg, true);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 1);
    assert.equal(live[0].txHash, TX_B);
    assert.equal(live[0].blockHash, B2P);
  });

  it("revives an event that is re-included at the same key after a reorg", async () => {
    const store = new MemoryStore();
    await store.putEvents([ev(TX_A, 0, 2, B2, DEAL)]);
    await store.markOrphanedFrom(HUB_ADDR, 2n);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 0);

    await store.putEvents([ev(TX_A, 0, 3, B3, DEAL)]);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 1);
    assert.equal(live[0].orphaned, false);
    assert.equal(live[0].blockNumber, 3n);
  });

  it("handles a backward-moving head without throwing and rolls the tip back", async () => {
    const store = new MemoryStore();
    const original = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
    ]);
    await new Indexer(new FakeReader(original, [hubLog(1, B1, { txHash: TX_A })]), store, {
      hub: HUB_ADDR,
      fromBlock: 0n,
    }).tick();
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 3n);

    // The chain is now shorter: heights 2 and 3 no longer exist.
    const shortened = chain([
      [0, B0, B0],
      [1, B1, B0],
    ]);
    const reader = new FakeReader(shortened, [hubLog(1, B1, { txHash: TX_A })]);
    const result = await new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n }).tick();
    assert.equal(result.reorg, true);
    const tip = await store.getTip(HUB_ADDR);
    assert.ok(tip === null || tip.blockNumber <= 1n);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 1);
  });
});

describe("Phase 5 indexer · mandatory relay recovery", () => {
  it("listRelayByStatus exposes processing and submitted work", async () => {
    const store = new MemoryStore();
    await store.enqueueRelay({
      idempotencyKey: "p",
      queue: "relay",
      action: "finalizeAfterTimeout",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    await store.claimRelayLease("p", "worker", 60);
    await store.enqueueRelay({
      idempotencyKey: "s",
      queue: "relay",
      action: "finalizeAfterTimeout",
      params: { dealId: DEAL },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    await store.finishRelay("s", "submitted", TX_A, null);

    assert.equal((await store.listRelayByStatus("processing", 10)).length, 1);
    assert.equal((await store.listRelayByStatus("submitted", 10))[0].txHash, TX_A);
    assert.equal((await store.listRelayByStatus("failed", 10)).length, 0);
  });
});
