import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import {
  __resetProposalsForTests,
  MUTUAL_TYPES,
  mutualSignableMessage,
  proposeSettlement,
} from "../dist/review/proposals.js";
import { buildDealDefaults, registerDealMetaRoutes } from "../dist/dealsMeta.js";

const DEAL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROPOSER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const proposer = privateKeyToAccount(PROPOSER_KEY);
const PROPOSER = proposer.address;
const HUB = "0x00000000000000000000000000000000000000aa";
const CHAIN_ID = 8453;
const NONCE_A = "0x1111111111111111111111111111111111111111111111111111111111111111";
const NONCE_B = "0x2222222222222222222222222222222222222222222222222222222222222222";
const AGREEMENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function baseInput(overrides = {}) {
  return {
    proposer: PROPOSER,
    sellerAwardUnits: "60000000",
    buyerCostUnits: "1000000",
    sellerCostUnits: "1000000",
    expectedPhase: 4,
    principalUnits: "100000000",
    claimantBondUnits: "5000000",
    respondentBondUnits: "5000000",
    agreementDigest: AGREEMENT,
    chainId: CHAIN_ID,
    hub: HUB,
    ...overrides,
  };
}

function chainCtx(settlementNonce) {
  const chainDeal = {
    principal: 100_000_000n,
    claimantBond: 5_000_000n,
    respondentBond: 5_000_000n,
    buyer: PROPOSER,
    seller: "0x3333333333333333333333333333333333333333",
    termsHash: AGREEMENT,
  };
  if (settlementNonce !== undefined) chainDeal["settlementNonce"] = settlementNonce;
  return { chainDeal, chainId: CHAIN_ID, hub: HUB };
}

/** Sign the authoritative MutualSettlement envelope as the proposer. */
async function signedInput(overrides = {}) {
  const base = baseInput(overrides);
  if (base.settlementNonce === undefined) return base;
  const expiresAt = base.expiresAt ?? Math.floor(Date.now() / 1_000) + 3_600;
  const withExpiry = { ...base, expiresAt: String(expiresAt) };
  const proposerSignature = await proposer.signTypedData({
    domain: { name: "MidmanEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: HUB },
    types: MUTUAL_TYPES,
    primaryType: "MutualSettlement",
    message: {
      dealId: DEAL,
      agreementDigest: base.agreementDigest,
      sellerAward: BigInt(base.sellerAwardUnits),
      buyerBondCost: BigInt(base.buyerCostUnits),
      sellerBondCost: BigInt(base.sellerCostUnits),
      expectedPhase: base.expectedPhase,
      settlementNonce: base.settlementNonce,
      expiresAt: BigInt(expiresAt),
    },
  });
  return { ...withExpiry, proposerSignature };
}

function policyIds() {
  const out = {};
  const keys = ["fee", "category", "readiness", "evidence", "bond", "arbitration", "outage", "catastrophic"];
  keys.forEach((key, index) => {
    out[key] = `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`;
  });
  return out;
}

function validEnv() {
  return {
    HUB_ADDRESS: HUB,
    USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    BASE_CHAIN_ID: String(CHAIN_ID),
    PLATFORM_FEE_RECIPIENT: "0x4444444444444444444444444444444444444444",
    ARBITRATION_COST_RECIPIENT: "0x5555555555555555555555555555555555555555",
    MIDMAN_POLICY_IDS: JSON.stringify(policyIds()),
  };
}

describe("Phase 4: mutual settlement nonce is authoritative", () => {
  beforeEach(() => {
    __resetProposalsForTests();
  });

  it("rejects an absent settlementNonce (no random fallback)", async () => {
    await assert.rejects(
      () => proposeSettlement(DEAL, baseInput(), chainCtx()),
      (error) => error.statusCode === 400 && /settlementNonce/i.test(error.message),
    );
  });

  it("rejects a malformed settlementNonce", async () => {
    await assert.rejects(
      () => proposeSettlement(DEAL, baseInput({ settlementNonce: "0x1234" }), chainCtx()),
      (error) => error.statusCode === 400 && /settlementNonce/i.test(error.message),
    );
  });

  it("accepts a caller-supplied live nonce when no chain counter is readable", async () => {
    const proposal = await proposeSettlement(DEAL, await signedInput({ settlementNonce: NONCE_A }), chainCtx());
    assert.equal(proposal.settlementNonce, NONCE_A);
    assert.equal(proposal.status, "open");
    assert.match(proposal.proposerSignature, /^0x[0-9a-fA-F]+$/);
  });

  it("rejects a proposal without the proposer signature (A9)", async () => {
    await assert.rejects(
      () => proposeSettlement(DEAL, baseInput({ settlementNonce: NONCE_A }), chainCtx()),
      (error) => error.statusCode === 400 && /proposerSignature/i.test(error.message),
    );
  });

  it("rejects a nonce that conflicts with authoritative chain state", async () => {
    await assert.rejects(
      () => proposeSettlement(DEAL, baseInput({ settlementNonce: NONCE_B }), chainCtx(NONCE_A)),
      (error) => error.statusCode === 400 && /conflict|chain/i.test(error.message),
    );
  });

  it("accepts a nonce that matches authoritative chain state", async () => {
    const proposal = await proposeSettlement(DEAL, await signedInput({ settlementNonce: NONCE_A }), chainCtx(NONCE_A));
    assert.equal(proposal.settlementNonce, NONCE_A);
  });

  it("produces ONE identical mutualSettlement payload for both parties to sign", async () => {
    const proposal = await proposeSettlement(DEAL, await signedInput({ settlementNonce: NONCE_A }), chainCtx(NONCE_A));
    const message = mutualSignableMessage(proposal);
    assert.deepEqual(Object.keys(message), [
      "dealId",
      "agreementDigest",
      "sellerAward",
      "buyerBondCost",
      "sellerBondCost",
      "expectedPhase",
      "settlementNonce",
      "expiresAt",
    ]);
    assert.equal(message.settlementNonce, NONCE_A);
    assert.equal(message.sellerAward, 60_000_000n);
    assert.deepEqual(
      MUTUAL_TYPES.MutualSettlement.map((field) => field.name),
      Object.keys(message),
    );
  });
});

describe("Phase 4: /config/deal-defaults shape", () => {
  it("builds the full agreement binding from env", () => {
    const defaults = buildDealDefaults(validEnv());
    assert.equal(defaults.hub, HUB);
    assert.equal(defaults.chainId, CHAIN_ID);
    assert.equal(Object.keys(defaults.policyIds).length, 8);
    for (const id of Object.values(defaults.policyIds)) {
      assert.match(id, /^0x[0-9a-fA-F]{64}$/);
    }
    assert.match(defaults.platformFeeRecipient, /^0x[0-9a-fA-F]{40}$/);
    assert.match(defaults.arbitrationCostRecipient, /^0x[0-9a-fA-F]{40}$/);
  });

  it("fails loudly when a policy id or recipient is missing", () => {
    assert.throws(() => buildDealDefaults({ ...validEnv(), MIDMAN_POLICY_IDS: "{}" }), /policyIds\./);
    assert.throws(() => buildDealDefaults({ ...validEnv(), PLATFORM_FEE_RECIPIENT: "" }), /PLATFORM_FEE_RECIPIENT/);
  });

  it("serves GET /config/deal-defaults over HTTP", async () => {
    const previous = process.env;
    process.env = { ...previous, ...validEnv() };
    try {
      const app = Fastify({ logger: false });
      registerDealMetaRoutes(app);
      const res = await app.inject({ method: "GET", url: "/config/deal-defaults" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(Object.keys(body.policyIds).length, 8);
      assert.equal(body.hub, HUB);
      await app.close();
    } finally {
      process.env = previous;
    }
  });
});
