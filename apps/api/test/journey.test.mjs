import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerRoutes } from "../dist/routes.js";
import { buildFullTerms } from "../dist/fullTerms.js";
import { MemoryStore } from "../dist/db.js";

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BUYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const TX = "0xabababababababababababababababababababababababababababababababab";

const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "specs", "contract-spec.json");
const specOrder = JSON.parse(readFileSync(specPath, "utf8")).dealTermsTypes.map((e) => e.name);

function draftBody() {
  return {
    creatorWallet: BUYER,
    counterpartyHint: SELLER,
    terms: {
      buyer: BUYER,
      seller: SELLER,
      principalUnits: "100000000",
      buyerFeeBps: 10000,
      deliverySeconds: 3600,
      inspectionSeconds: 43200,
      category: "GAME_ITEM",
      agreementHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      policyIds: {
        fee: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        category: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      platformFeeRecipient: BUYER,
      arbitrationCostRecipient: SELLER,
      hub: HUB_ADDR,
      token: USDC,
      chainId: 8453,
    },
  };
}

function appWithDeps({ store, reader, hub = HUB_ADDR, chainId = 8453 }) {
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    store,
    reader,
    indexer: null,
    hub,
    usdc: USDC,
    chainId,
    rpcConfigured: true,
  });
  return app;
}

async function createDraft(app) {
  const created = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
  assert.equal(created.statusCode, 200);
  return created.json();
}

function block(n) {
  return {
    number: BigInt(n),
    hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    timestamp: 1,
  };
}

function stubReader({ receipt = null, safe = null, finalized = null } = {}) {
  return {
    async getBlockByTag(tag) {
      return tag === "safe" ? safe : finalized;
    },
    async getTransactionReceipt() {
      return receipt;
    },
    async getDeal() {
      throw new Error("unused");
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
      return 99n;
    },
    async getBlock() {
      throw new Error("unused");
    },
    async getLogs() {
      return [];
    },
  };
}

describe("draft summary", () => {
  it("reports exact amounts, policy copy and warnings", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: null });
    await app.ready();
    const { id, terms } = await createDraft(app);
    const res = await app.inject({ method: "GET", url: `/drafts/${id}/summary` });
    assert.equal(res.statusCode, 200);
    const s = res.json();
    assert.equal(s.dealId, terms.dealId);
    assert.equal(s.parties.buyer, BUYER);
    assert.equal(s.parties.seller, SELLER);
    assert.equal(s.parties.payouts.sellerPayout, SELLER);
    assert.equal(s.parties.payouts.buyerRefund, BUYER);
    assert.equal(s.amounts.principalUnits, "100000000");
    assert.equal(s.amounts.quotedFeeUnits, "500000");
    assert.equal(s.amounts.fundedUnits, "100500000");
    assert.equal(s.amounts.effectiveFeeBps, "50");
    assert.equal(s.schedule.deliverySeconds, "3600");
    assert.equal(s.schedule.inspectionSeconds, "43200");
    assert.equal(s.schedule.fundingDeadline, terms.fundingDeadline);
    assert.ok(s.feeFormula.includes("floor"));
    assert.ok(s.feeFormula.includes("remainder"));
    assert.equal(s.dispute.oneFreeDispute, true);
    assert.equal(s.dispute.negotiationHours, 24);
    assert.equal(s.dispute.escalationHours, 24);
    assert.equal(s.dispute.minBondUnits, "5000000");
    assert.ok(s.dispute.quorumTiers.includes("2-of-3"));
    assert.ok(s.dispute.executionDelays.includes("24h"));
    assert.equal(s.catastrophic.days, 60);
    assert.equal(s.catastrophic.split, "50/50, odd unit to buyer");
    assert.equal(s.catastrophic.fees, "zero");
    assert.ok(Array.isArray(s.warnings) && s.warnings.length >= 3);
    assert.ok(s.warnings.some((w) => w.includes("One free dispute")));
    assert.ok(s.warnings.some((w) => w.includes("lapses")));
    assert.ok(s.warnings.some((w) => w.includes("No warranty")));
  });

  it("404s unknown drafts", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: null });
    await app.ready();
    assert.equal((await app.inject({ method: "GET", url: "/drafts/nope/summary" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/drafts/nope/download" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/drafts/nope/readiness-payload" })).statusCode, 404);
  });
});

describe("draft download", () => {
  it("serves an attachment with ordered fullTerms and a deterministic digest", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: null });
    await app.ready();
    const { id, terms } = await createDraft(app);
    const first = await app.inject({ method: "GET", url: `/drafts/${id}/download` });
    assert.equal(first.statusCode, 200);
    const cd = first.headers["content-disposition"];
    assert.ok(cd.includes("attachment"));
    assert.ok(cd.includes(`midman-deal-${terms.dealId}.json`));
    const body = first.json();
    assert.deepEqual(Object.keys(body.fullTerms), specOrder);
    assert.equal(Object.keys(body.fullTerms).length, 32);
    assert.equal(body.fullTerms.termsVersion, "1");
    assert.equal(body.fullTerms.custodyAddress, HUB_ADDR);
    assert.equal(body.fullTerms.principal, "100000000");
    assert.match(body.agreementDigest, /^0x[0-9a-fA-F]{64}$/);
    assert.deepEqual(body.signatures, {});
    assert.equal(body.acceptanceTypedData.primaryType, "DealTerms");
    assert.ok(body.exportedAt);
    assert.ok(body.note.length > 0);
    const second = await app.inject({ method: "GET", url: `/drafts/${id}/download` });
    assert.equal(second.json().agreementDigest, body.agreementDigest);
    const direct = buildFullTerms(terms, HUB_ADDR);
    assert.equal(direct.agreementDigest, body.agreementDigest);
    assert.deepEqual(direct.fullTerms, body.fullTerms);
  });

  it("fullTerms key order matches specs/contract-spec.json dealTermsTypes", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: null });
    await app.ready();
    const { id } = await createDraft(app);
    const body = (await app.inject({ method: "GET", url: `/drafts/${id}/download` })).json();
    assert.deepEqual(Object.keys(body.fullTerms), specOrder);
  });
});

describe("fixed EIP-712 agreement digest vector", () => {
  // PHASE 12: re-verify this digest against the on-chain DealTerms digest
  // (MidmanDK.DEAL_TERMS_TYPEHASH + MidmanEscrow domain) before mainnet.
  it("matches the recorded audit-trail digest", () => {
    const terms = {
      dealId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      buyer: BUYER,
      seller: SELLER,
      sellerPayout: SELLER,
      buyerRefund: BUYER,
      buyerBondRefund: BUYER,
      sellerBondRefund: SELLER,
      token: USDC,
      hub: HUB_ADDR,
      principalUnits: "100000000",
      quotedFeeUnits: "500000",
      prepaidBuyerFeeUnits: "500000",
      fundedUnits: "100500000",
      buyerFeeBps: "10000",
      deliverySeconds: "3600",
      inspectionSeconds: "43200",
      durationSeconds: "46800",
      category: "GAME_ITEM",
      agreementHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      fundingDeadline: "100604800",
      nonce: "0x3333333333333333333333333333333333333333333333333333333333333333",
      salt: "0x4444444444444444444444444444444444444444444444444444444444444444",
      chainId: "8453",
      platformFeeRecipient: BUYER,
      arbitrationCostRecipient: SELLER,
      "policy:fee": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "policy:category": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "policy:readiness": "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "policy:evidence": "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "policy:bond": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "policy:arbitration": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "policy:outage": "0x0000000000000000000000000000000000000000000000000000000000000005",
      "policy:catastrophic": "0x0000000000000000000000000000000000000000000000000000000000000006",
    };
    const { fullTerms, agreementDigest } = buildFullTerms(terms, HUB_ADDR);
    assert.deepEqual(Object.keys(fullTerms), specOrder);
    assert.equal(agreementDigest, "0x9f2e8d55198db46098fc63e3085dcc747841d9a36cd0747271105150f475394b");
  });
});

describe("tx status", () => {
  it("503s when no chain reader is configured", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: null });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/tx/${TX}/status` });
    assert.equal(res.statusCode, 503);
    assert.ok(res.json().reason);
  });

  it("400s invalid hashes", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: stubReader() });
    await app.ready();
    assert.equal((await app.inject({ method: "GET", url: "/tx/notahash/status" })).statusCode, 400);
  });

  it("pending when no receipt", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: stubReader({ receipt: null }) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/tx/${TX}/status` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().level, "pending");
    assert.equal(res.json().blockNumber, null);
  });

  it("included when below safe/finalized", async () => {
    const app = appWithDeps({
      store: new MemoryStore(),
      reader: stubReader({ receipt: { status: true, blockNumber: 10n }, safe: null, finalized: null }),
    });
    await app.ready();
    const body = (await app.inject({ method: "GET", url: `/tx/${TX}/status` })).json();
    assert.equal(body.level, "included");
    assert.equal(body.blockNumber, "10");
    assert.equal(body.status, true);
  });

  it("safe and finalized via stubbed tags", async () => {
    const safeApp = appWithDeps({
      store: new MemoryStore(),
      reader: stubReader({ receipt: { status: true, blockNumber: 10n }, safe: block(12), finalized: null }),
    });
    await safeApp.ready();
    assert.equal((await safeApp.inject({ method: "GET", url: `/tx/${TX}/status` })).json().level, "safe");

    const finApp = appWithDeps({
      store: new MemoryStore(),
      reader: stubReader({ receipt: { status: false, blockNumber: 10n }, safe: block(12), finalized: block(11) }),
    });
    await finApp.ready();
    const fin = (await finApp.inject({ method: "GET", url: `/tx/${TX}/status` })).json();
    assert.equal(fin.level, "finalized");
    assert.equal(fin.status, false);
  });
});

describe("readiness payload", () => {
  it("returns a signable ReadinessConsent with a 2h window", async () => {
    const app = appWithDeps({ store: new MemoryStore(), reader: null });
    await app.ready();
    const { id, terms } = await createDraft(app);
    const before = Math.floor(Date.now() / 1000);
    const res = await app.inject({ method: "POST", url: `/drafts/${id}/readiness-payload` });
    const after = Math.floor(Date.now() / 1000);
    assert.equal(res.statusCode, 200);
    const p = res.json();
    assert.deepEqual(p.domain, { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: HUB_ADDR });
    assert.equal(p.primaryType, "ReadinessConsent");
    assert.deepEqual(
      p.types.ReadinessConsent.map((f) => `${f.name}:${f.type}`),
      ["dealId:bytes32", "agreementDigest:bytes32", "buyer:address", "attestedAt:uint64", "nonce:bytes32", "expiresAt:uint64"],
    );
    assert.equal(p.message.dealId, terms.dealId);
    assert.equal(p.message.buyer, BUYER);
    assert.match(p.message.agreementDigest, /^0x[0-9a-fA-F]{64}$/);
    assert.match(p.message.nonce, /^0x[0-9a-fA-F]{64}$/);
    const attestedAt = Number(p.message.attestedAt);
    const expiresAt = Number(p.message.expiresAt);
    assert.equal(expiresAt - attestedAt, 7200);
    assert.ok(attestedAt >= before && attestedAt <= after);
    const download = (await app.inject({ method: "GET", url: `/drafts/${id}/download` })).json();
    assert.equal(p.message.agreementDigest, download.agreementDigest);
  });

  it("503s when hub/chainId are unconfigured", async () => {
    const app = Fastify({ logger: false });
    registerRoutes(app, {
      store: new MemoryStore(),
      reader: null,
      indexer: null,
      hub: null,
      usdc: USDC,
      chainId: null,
      rpcConfigured: false,
    });
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
    assert.equal(created.statusCode, 200);
    const res = await app.inject({ method: "POST", url: `/drafts/${created.json().id}/readiness-payload` });
    assert.equal(res.statusCode, 503);
  });
});
