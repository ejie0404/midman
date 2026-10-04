import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from "viem";
import { buildServer } from "../dist/server.js";
import { registerRoutes } from "../dist/routes.js";
import { MemoryStore } from "../dist/db.js";
import { Indexer } from "../dist/indexer.js";
import { buildCanonicalTerms } from "../dist/terms.js";

const BUYER_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const SELLER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function draftBody() {
  return {
    creatorWallet: buyer.address,
    counterpartyHint: seller.address,
    terms: {
      buyer: buyer.address,
      seller: seller.address,
      principalUnits: "100000000",
      buyerFeeBps: 10000,
      deliverySeconds: 3600,
      inspectionSeconds: 43200,
      category: "GAME_ITEM",
      agreementHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      policyIds: { fee: "0xfee" },
      platformFeeRecipient: buyer.address,
      arbitrationCostRecipient: seller.address,
      hub: HUB_ADDR,
      token: USDC,
      chainId: 8453,
    },
  };
}

describe("draft lifecycle", () => {
  let app;
  beforeEach(async () => {
    app = buildServer();
    await app.ready();
  });

  it("create -> invite -> accept -> sign -> quote", async () => {
    const created = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
    assert.equal(created.statusCode, 200);
    const { id, terms } = created.json();
    assert.equal(terms.principalUnits, "100000000");
    assert.equal(terms.quotedFeeUnits, "500000");

    const invited = await app.inject({ method: "POST", url: `/drafts/${id}/invite` });
    assert.equal(invited.statusCode, 200);
    assert.ok(invited.json().invitationToken.length > 20);

    const wrong = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      payload: { counterpartyAddress: "0x00000000000000000000000000000000000000bb" },
    });
    assert.equal(wrong.statusCode, 409);

    const accepted = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      payload: { counterpartyAddress: seller.address },
    });
    assert.equal(accepted.statusCode, 200);

    const domain = { name: "MidmanDraft", version: "1", chainId: 8453, verifyingContract: HUB_ADDR };
    const types = {
      DealTerms: [
        { name: "dealId", type: "bytes32" },
        { name: "principal", type: "uint256" },
        { name: "quotedPlatformFee", type: "uint256" },
        { name: "buyer", type: "address" },
        { name: "seller", type: "address" },
      ],
    };
    const message = {
      dealId: terms.dealId,
      principal: BigInt(terms.principalUnits),
      quotedPlatformFee: BigInt(terms.quotedFeeUnits),
      buyer: terms.buyer,
      seller: terms.seller,
    };
    const sig = await seller.signTypedData({ domain, types, primaryType: "DealTerms", message });
    const signed = await app.inject({
      method: "POST",
      url: `/drafts/${id}/signatures`,
      payload: { role: "seller", signature: sig },
    });
    assert.equal(signed.statusCode, 200);

    const badSig = await buyer.signTypedData({ domain, types, primaryType: "DealTerms", message });
    const rejected = await app.inject({
      method: "POST",
      url: `/drafts/${id}/signatures`,
      payload: { role: "seller", signature: badSig },
    });
    assert.equal(rejected.statusCode, 400);

    const quote = await app.inject({ method: "GET", url: `/drafts/${id}/quote?sellerAward=70000000` });
    assert.equal(quote.statusCode, 200);
    const preview = quote.json();
    assert.equal(preview.earnedFee, "350000");
    assert.equal(preview.buyerClaim, "30150000");
    assert.equal(preview.sellerClaim, "70000000");
  });

  it("rejects below-minimum principal", async () => {
    const body = draftBody();
    body.terms.principalUnits = "1000000";
    const res = await app.inject({ method: "POST", url: "/drafts", payload: body });
    assert.equal(res.statusCode, 400);
  });
});

describe("relay outbox idempotency", () => {
  let app;
  beforeEach(async () => {
    app = buildServer();
    await app.ready();
  });

  it("duplicate keys return the existing job, never a second job", async () => {
    const payload = { idempotencyKey: "k1", action: "openDispute", params: { dealId: "0x01" } };
    const first = await app.inject({ method: "POST", url: "/relay/submit", payload });
    assert.equal(first.json().inserted, true);
    const second = await app.inject({ method: "POST", url: "/relay/submit", payload });
    assert.equal(second.json().inserted, false);
    assert.equal(second.json().status, "queued");
    const fetched = await app.inject({ method: "GET", url: "/relay/k1" });
    assert.equal(fetched.json().action, "openDispute");
  });

  it("rejects unknown actions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/relay/submit",
      payload: { idempotencyKey: "k2", action: "drain", params: {} },
    });
    assert.equal(res.statusCode, 400);
  });
});

// ---- Indexer with a scripted chain ----
class FakeReader {
  constructor(blocks, logs) {
    this.blocks = blocks; // Map<number, {hash, parentHash}>
    this.logs = logs; // array of ChainLog
  }
  async getLatestBlockNumber() {
    return BigInt(Math.max(...this.blocks.keys()));
  }
  async getBlock(number) {
    const block = this.blocks.get(Number(number));
    if (!block) throw new Error("Unknown block");
    return { number: BigInt(Number(number)), hash: block.hash, parentHash: block.parentHash, timestamp: 1 };
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

const DEAL = "0x1111111111111111111111111111111111111111111111111111111111111111";
const B1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const B2P = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function fundedLog(blockNumber, blockHash, txHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd") {
  const topics = encodeEventTopics({
    abi: [parseAbiItem("event DealFunded(bytes32 indexed dealId, bytes32 agreementDigest, uint256 principal, uint256 funded)")],
    args: { dealId: DEAL },
  });
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [DEAL, 100000000n, 100500000n],
  );
  return {
    blockNumber: BigInt(blockNumber),
    blockHash,
    transactionHash: txHash,
    logIndex: 0,
    address: HUB_ADDR,
    data,
    topics,
    removed: false,
  };
}

function chainWithFunded(blocks) {
  return new FakeReader(blocks, [fundedLog(2, blocks.get(2).hash)]);
}

describe("indexer", () => {
  it("scans, stores tip, and is idempotent on re-tick", async () => {
    const store = new MemoryStore();
    const blocks = new Map([
      [0, { hash: "0x00", parentHash: "0x00" }],
      [1, { hash: B1, parentHash: "0x00" }],
      [2, { hash: B2, parentHash: B1 }],
    ]);
    const indexer = new Indexer(chainWithFunded(blocks), store, { hub: HUB_ADDR, fromBlock: 0n });
    const first = await indexer.tick();
    assert.equal(first.added, 1);
    const tip = await store.getTip(HUB_ADDR);
    assert.equal(tip.blockNumber, 2n);
    const events = await store.getEventsByDeal(DEAL);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventName, "DealFunded");
    const second = await indexer.tick();
    assert.equal(second.added, 0);
  });

  it("replay reproduces state from scratch", async () => {
    const store = new MemoryStore();
    const blocks = new Map([
      [0, { hash: "0x00", parentHash: "0x00" }],
      [1, { hash: B1, parentHash: "0x00" }],
      [2, { hash: B2, parentHash: B1 }],
    ]);
    const reader = chainWithFunded(blocks);
    const indexer = new Indexer(reader, store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer.tick();
    await indexer.replay();
    const afterReplay = await store.getEventsByDeal(DEAL);
    assert.equal(afterReplay.length, 0);
    await indexer.tick();
    assert.equal((await store.getEventsByDeal(DEAL)).length, 1);
  });

  it("reorg orphans rolled-back events and rescans the new branch", async () => {
    const store = new MemoryStore();
    const blocks = new Map([
      [0, { hash: "0x00", parentHash: "0x00" }],
      [1, { hash: B1, parentHash: "0x00" }],
      [2, { hash: B2, parentHash: B1 }],
    ]);
    const txA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reader1 = new FakeReader(blocks, [fundedLog(1, B1, txA), fundedLog(2, B2)]);
    const indexer = new Indexer(reader1, store, { hub: HUB_ADDR, fromBlock: 0n });
    await indexer.tick();
    assert.equal((await store.getEventsByDeal(DEAL)).length, 2);
    // Reorg: block 2 is replaced; block 1 is the common anchor.
    blocks.set(2, { hash: B2P, parentHash: B1 });
    blocks.set(3, { hash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", parentHash: B2P });
    const txB = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const reader2 = new FakeReader(blocks, [fundedLog(1, B1, txA), fundedLog(2, B2P, txB)]);
    const indexer2 = new Indexer(reader2, store, { hub: HUB_ADDR, fromBlock: 0n });
    const result = await indexer2.tick();
    assert.equal(result.reorg, true);
    assert.equal(result.orphaned, 1);
    const live = await store.getEventsByDeal(DEAL);
    assert.equal(live.length, 2);
    assert.ok(live.some((e) => e.blockHash === B2P));
  });
});

describe("canonical terms", () => {  it("matches the contract ceil-quote rule", () => {
    const terms = buildCanonicalTerms(
      {
        buyer: buyer.address,
        seller: seller.address,
        principalUnits: "100000000",
        buyerFeeBps: 10000,
        deliverySeconds: 3600,
        inspectionSeconds: 43200,
        category: "GAME_ITEM",
        agreementHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        policyIds: {},
        platformFeeRecipient: buyer.address,
        arbitrationCostRecipient: seller.address,
        hub: HUB_ADDR,
        token: USDC,
        chainId: 8453,
      },
      1000000,
    );
    assert.equal(terms.quotedFeeUnits, "500000");
    assert.equal(terms.fundedUnits, "100500000");
  });
});

describe("chain-first status", () => {
  it("prefers contract state over projections and drafts", async () => {
    const store = new MemoryStore();
    const dealId = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const reader = {
      async getDeal() {
        return { funded: true, phase: 1, fundedAt: 1n, deliveredAt: 2n, disputeOpenedAt: 0n, disputeUsed: false };
      },
      async getClaim() {
        throw new Error("unused");
      },
      async getLiabilities() {
        throw new Error("unused");
      },
      async getTokenBalance() {
        throw new Error("unused");
      },
      async getLatestBlockNumber() {
        return 1n;
      },
      async getBlock() {
        throw new Error("unused");
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
    const app = Fastify({ logger: false });
    registerRoutes(app, {
      store,
      reader,
      indexer: null,
      hub: HUB_ADDR,
      usdc: USDC,
      chainId: 8453,
      rpcConfigured: true,
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/deals/${dealId}/status` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().source, "chain");
    assert.equal(res.json().phase, "DELIVERED");
  });
});
