import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from "viem";
import { MemoryStore } from "../dist/db.js";
import { Indexer, listKnownDealIds } from "../dist/indexer.js";

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";

// Self-contained scripted chain, mirroring api.test.mjs.
class FakeReader {
  constructor(blocks, logs) {
    this.blocks = blocks; // Map<number, {hash, parentHash}>
    this.logs = logs; // array of ChainLog
  }
  async getLatestBlockNumber() {
    return BigInt(Math.max(...this.blocks.keys()));
  }
  async getBlock(number) {
    const n = Number(number);
    const block = this.blocks.get(n);
    if (!block) throw new Error(`Unknown block ${n}`);
    return { number: BigInt(n), hash: block.hash, parentHash: block.parentHash, timestamp: 1 };
  }
  async getBlockByTag() {
    return null;
  }
  async getTransactionReceipt() {
    return null;
  }
  async getLogs({ fromBlock, toBlock }) {
    return this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
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

const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;

const B0 = H(100);
const B1 = H(101);
const B2 = H(102);
const B3 = H(103);
const B4 = H(104);
const B5 = H(105);
const B2P = H(202);
const B3P = H(203);
const B4P = H(204);

const TX_A = H(0x2a);
const TX_B = H(0x2b);
const TX_C = H(0x2c);
const TX_Z = H(0x2d);

const DEAL = `0x${"11".repeat(32)}`;
const DEAL_X = `0x${"22".repeat(32)}`;
const MIXED_UPPER = `0x${"AB".repeat(32)}`;
const MIXED_LOWER = `0x${"ab".repeat(32)}`;

function hubLog(blockNumber, blockHash, { dealId = DEAL, txHash = TX_A, logIndex = 0 } = {}) {
  const topics = encodeEventTopics({
    abi: [
      parseAbiItem(
        "event DealFunded(bytes32 indexed dealId, bytes32 agreementDigest, uint256 principal, uint256 funded)",
      ),
    ],
    args: { dealId },
  });
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [dealId, 100000000n, 100500000n],
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

const chain = (entries) => new Map(entries.map(([n, hash, parent]) => [n, { hash, parentHash: parent }]));

describe("indexer forward scan", () => {
  it("scans a batch, stores the tip, and is idempotent on re-tick", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
    ]);
    const reader = new FakeReader(blocks, [hubLog(2, B2, { txHash: TX_A })]);
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });

    const first = await indexer.tick();
    assert.equal(first.added, 1);
    assert.equal(first.reorg, false);
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 2n);

    const second = await indexer.tick();
    assert.equal(second.added, 0);
    assert.equal(second.reorg, false);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 1);
  });

  it("scans across batches and advances the tip incrementally", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
      [4, B4, B3],
    ]);
    const reader = new FakeReader(blocks, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(3, B3, { txHash: TX_A }),
    ]);
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n, batchSize: 2n });

    const first = await indexer.tick();
    assert.equal(first.scannedTo, 1n);
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 1n);

    const second = await indexer.tick();
    assert.equal(second.scannedTo, 3n);
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 3n);

    const third = await indexer.tick();
    assert.equal(third.added, 0);
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 4n);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 2);
  });
});

describe("indexer reorgs", () => {
  it("detects a same-height tip replacement and rescans the new block", async () => {
    const store = new MemoryStore();
    const original = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
    ]);
    const reader1 = new FakeReader(original, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(2, B2, { txHash: TX_A }),
    ]);
    const indexer1 = new Indexer(reader1, store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer1.tick();
    assert.equal((await store.getEventsByDeal(DEAL)).length, 2);

    // Same height, different block 2 (no new block appended).
    const replaced = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2P, B1],
    ]);
    const reader2 = new FakeReader(replaced, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(2, B2P, { txHash: TX_B }),
    ]);
    const indexer2 = new Indexer(reader2, store, { hub: HUB_ADDR, fromBlock: 0n });
    const result = await indexer2.tick();

    assert.equal(result.reorg, true);
    assert.equal(result.orphaned, 1);
    assert.equal((await store.getTip(HUB_ADDR)).blockHash, B2P);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 2);
    assert.ok(live.some((e) => e.blockHash === B2P && e.txHash === TX_B));
    assert.ok(!live.some((e) => e.txHash === TX_A));
  });

  it("detects a reorg of an already-scanned block by the cascading tip hash", async () => {
    const store = new MemoryStore();
    const original = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
      [4, B4, B3],
    ]);
    const reader1 = new FakeReader(original, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(2, B2, { txHash: TX_A }),
    ]);
    const indexer1 = new Indexer(reader1, store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer1.tick();
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 4n);

    // A block below the tip (2) is rewritten; 3 and 4 cascade.
    const reorged = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2P, B1],
      [3, B3P, B2P],
      [4, B4P, B3P],
    ]);
    const reader2 = new FakeReader(reorged, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(4, B4P, { txHash: TX_B }),
    ]);
    const indexer2 = new Indexer(reader2, store, { hub: HUB_ADDR, fromBlock: 0n });
    const result = await indexer2.tick();

    assert.equal(result.reorg, true);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 2);
    assert.ok(live.some((e) => e.blockHash === B4P && e.txHash === TX_B));
    assert.ok(!live.some((e) => e.txHash === TX_A));
  });

  it("falls back to a full replay when the fork point is beyond the walk limit", async () => {
    const store = new MemoryStore();
    const original = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
    ]);
    const reader1 = new FakeReader(original, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(3, B3, { txHash: TX_A }),
    ]);
    const indexer1 = new Indexer(reader1, store, { hub: HUB_ADDR, fromBlock: 0n, reorgWalkLimit: 1 });
    await indexer1.tick();
    assert.equal((await store.getEventsByDeal(DEAL)).length, 2);

    const reorged = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2P, B1],
      [3, B3P, B2P],
    ]);
    const reader2 = new FakeReader(reorged, [
      hubLog(1, B1, { txHash: TX_Z }),
      hubLog(3, B3P, { txHash: TX_B }),
    ]);
    const indexer2 = new Indexer(reader2, store, { hub: HUB_ADDR, fromBlock: 0n, reorgWalkLimit: 1 });
    const result = await indexer2.tick();

    assert.equal(result.reorg, true);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 2);
    assert.ok(live.some((e) => e.blockHash === B3P && e.txHash === TX_B));
    assert.ok(!live.some((e) => e.txHash === TX_A));
  });

  it("verifyContinuity rejects a parent-hash mismatch below the tip", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
    ]);
    const reader = new FakeReader(blocks, [hubLog(2, B2, { txHash: TX_A })]);
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer.tick();
    assert.equal((await store.getTip(HUB_ADDR)).blockNumber, 3n);

    // Tip 3 stays canonical, but the successor claims the wrong parent.
    const tampered = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
      [4, B4, B0],
    ]);
    const badReader = new FakeReader(tampered, [hubLog(2, B2, { txHash: TX_A })]);
    const badIndexer = new Indexer(badReader, store, { hub: HUB_ADDR, fromBlock: 0n });
    const check = await badIndexer.verifyContinuity();

    assert.equal(check.ok, false);
    assert.equal(check.forkPoint, 2n);
  });

  it("verifyContinuity accepts a canonical tip whose successor links to it", async () => {
    const store = new MemoryStore();
    const blocks = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
    ]);
    const reader = new FakeReader(blocks, [hubLog(2, B2, { txHash: TX_A })]);
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer.replay(2n); // primes the tip at block 1
    const check = await indexer.verifyContinuity();

    assert.equal(check.ok, true);
    assert.equal(check.forkPoint, null);
    assert.equal(check.orphaned, 0);
  });
});

describe("chain event store re-inclusion", () => {
  it("clears the orphan flag when an event is re-included at the same key", async () => {
    const store = new MemoryStore();
    const event = ev(TX_A, 0, 5, B5, DEAL);
    assert.equal(await store.putEvents([event]), 1);

    assert.equal(await store.markOrphanedFrom(HUB_ADDR, 5n), 1);
    assert.equal((await store.getEventsByDeal(DEAL)).length, 0);

    const added = await store.putEvents([{ ...event, blockNumber: 6n, blockHash: B5 }]);
    assert.equal(added, 0); // re-inclusion is an update, not a new insert
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 1);
    assert.equal(live[0].orphaned, false);
    assert.equal(live[0].blockNumber, 6n);
  });

  it("markOrphanedFrom is idempotent", async () => {
    const store = new MemoryStore();
    await store.putEvents([ev(TX_A, 0, 5, B5, DEAL)]);
    assert.equal(await store.markOrphanedFrom(HUB_ADDR, 5n), 1);
    assert.equal(await store.markOrphanedFrom(HUB_ADDR, 5n), 0);
  });

  it("re-includes an event across a reorg that first removed then restored it", async () => {
    const store = new MemoryStore();
    const original = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2, B1],
      [3, B3, B2],
    ]);
    const logs = [hubLog(1, B1, { txHash: TX_Z }), hubLog(2, B2, { txHash: TX_A })];
    const indexer1 = new Indexer(new FakeReader(original, logs), store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer1.tick();
    assert.equal((await store.getEventsByDeal(DEAL)).length, 2);

    // Reorg 1: block 2 rewritten, the DEAL event disappears.
    const removed = chain([
      [0, B0, B0],
      [1, B1, B0],
      [2, B2P, B1],
      [3, B3P, B2P],
    ]);
    const indexer2 = new Indexer(
      new FakeReader(removed, [hubLog(1, B1, { txHash: TX_Z })]),
      store,
      { hub: HUB_ADDR, fromBlock: 0n },
    );
    await indexer2.tick();
    assert.equal((await store.getEventsByDeal(DEAL)).length, 1);

    // Reorg 2: the original block 2 comes back with the same (txHash, logIndex).
    const restored = {
      txHash: TX_A,
      logIndex: 0,
      blockNumber: 2n,
      blockHash: B2,
      removed: false,
    };
    const indexer3 = new Indexer(
      new FakeReader(original, [hubLog(1, B1, { txHash: TX_Z }), { ...logs[1], ...restored }]),
      store,
      { hub: HUB_ADDR, fromBlock: 0n },
    );
    const result = await indexer3.tick();

    assert.equal(result.reorg, true);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 2);
    const revived = live.find((e) => e.txHash === TX_A);
    assert.ok(revived);
    assert.equal(revived.orphaned, false);
    assert.equal(revived.blockHash, B2);
  });
});

describe("external deal discovery", () => {
  it("listChainEventDealIds returns distinct, non-orphaned deal ids", async () => {
    const store = new MemoryStore();
    await store.putEvents([
      ev(TX_A, 0, 1, B1, DEAL),
      ev(TX_B, 0, 2, B2, DEAL),
      ev(TX_C, 0, 3, B3, DEAL_X),
    ]);
    assert.deepEqual((await store.listChainEventDealIds()).sort(), [DEAL, DEAL_X].sort());

    await store.markOrphanedFrom(HUB_ADDR, 3n);
    assert.deepEqual(await store.listChainEventDealIds(), [DEAL]);
  });

  it("listKnownDealIds surfaces an externally funded deal absent from drafts", async () => {
    const store = new MemoryStore();
    await store.putEvents([ev(TX_C, 0, 3, B3, DEAL_X)]);
    assert.deepEqual(await store.listDealIds(), []);

    const known = await listKnownDealIds(store);
    assert.ok(known.some((d) => d.toLowerCase() === DEAL_X.toLowerCase()));
  });

  it("listKnownDealIds unions drafts and chain events and dedupes case-insensitively", async () => {
    const store = new MemoryStore();
    await store.createDraft({
      id: "draft_mixed",
      dealId: MIXED_UPPER,
      creatorWallet: "0xcreator",
      counterpartyHint: null,
      counterpartyAddress: null,
      terms: {},
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "draft",
    });
    await store.putEvents([
      ev(TX_A, 0, 1, B1, MIXED_LOWER), // same deal as the draft, different case
      ev(TX_C, 0, 2, B2, DEAL_X), // chain-only deal
    ]);

    const known = await listKnownDealIds(store);
    assert.equal(known.length, 2);
    assert.ok(known.includes(MIXED_UPPER));
    assert.ok(known.some((d) => d.toLowerCase() === DEAL_X.toLowerCase()));
    assert.equal(known.filter((d) => d.toLowerCase() === MIXED_LOWER).length, 1);
  });

  it("listKnownDealIds tolerates empty stores", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await listKnownDealIds(store), []);
  });
});
