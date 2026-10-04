import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
// NOTE: review routes only — server.ts is intentionally not imported here.
import { registerReviewRoutes } from "../dist/review/routes.js";
import {
  __resetReviewRegistryForTests,
  reviewRegistry,
} from "../dist/review/registry.js";
import {
  __resetAwardsForTests,
  RULING_TYPES,
  RULING_FIELD_ORDER,
} from "../dist/review/awards.js";
import { __resetApprovalsForTests } from "../dist/review/approvals.js";
import {
  __resetProposalsForTests,
  MUTUAL_TYPES,
  MUTUAL_FIELD_ORDER,
} from "../dist/review/proposals.js";
import { MemoryStore } from "../dist/db.js";

const REV_A_KEY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B_KEY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REV_C_KEY = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REV_D_KEY = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const REV_E_KEY = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const OUTSIDER_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const BUYER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const SELLER_KEY = "0x3333333333333333333333333333333333333333333333333333333333333333";
const VETO_KEY = "0x4444444444444444444444444444444444444444444444444444444444444444";

const revA = privateKeyToAccount(REV_A_KEY);
const revB = privateKeyToAccount(REV_B_KEY);
const revC = privateKeyToAccount(REV_C_KEY);
const revD = privateKeyToAccount(REV_D_KEY);
const revE = privateKeyToAccount(REV_E_KEY);
const outsider = privateKeyToAccount(OUTSIDER_KEY);
const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);
const vetoer = privateKeyToAccount(VETO_KEY);

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453;

const DEAL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGREEMENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ARB_POLICY = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const EVIDENCE = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const NONCE_A = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NONCE_B = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const PRINCIPAL = "100000000"; // 100 USDC
const QUOTED_FEE = "500000";
const CLAIMANT_BOND = "5000000";
const RESPONDENT_BOND = "5000000";

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function signedHeaders(account, method, path, body) {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const bodyHash = sha256hex(raw);
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const message = `${method.toUpperCase()}\n${path}\n${bodyHash}\n${expiry}`;
  const signature = await account.signMessage({ message });
  return {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
  };
}

async function call(app, account, method, path, body) {
  const headers = await signedHeaders(account, method, path, body);
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method, url: path, headers, payload: body });
}

function makeApp() {
  const store = new MemoryStore();
  const app = Fastify({ logger: false });
  registerReviewRoutes(app, {
    store,
    reader: null,
    hub: HUB,
    usdc: USDC,
    chainId: CHAIN_ID,
    rpcConfigured: false,
  });
  return { app, store };
}

function draftBody(overrides = {}) {
  return {
    principalUnits: PRINCIPAL,
    quotedFeeUnits: QUOTED_FEE,
    buyerFeeBps: 10000,
    sellerAwardUnits: "70000000",
    claimantBondUnits: CLAIMANT_BOND,
    respondentBondUnits: RESPONDENT_BOND,
    evidenceCommitment: EVIDENCE,
    origin: 0,
    rulingNonce: NONCE_A,
    authEpoch: "1",
    queueExpiry: String(Math.floor(Date.now() / 1_000) + 86_400),
    arbitrationPolicyId: ARB_POLICY,
    agreementDigest: AGREEMENT,
    ...overrides,
  };
}

async function assignDefault(app, dealId = DEAL) {
  const body = { primary: [revA.address, revB.address, revC.address], fallback: [revD.address, revE.address, vetoer.address] };
  const res = await call(app, revA, "POST", `/review/cases/${dealId}/assign`, body);
  assert.equal(res.statusCode, 200);
  return res.json();
}

async function draftDefault(app, overrides = {}, dealId = DEAL) {
  const body = draftBody(overrides);
  const res = await call(app, revA, "POST", `/review/cases/${dealId}/awards/draft`, body);
  assert.equal(res.statusCode, 200);
  return res.json();
}

function rulingMessage(draft) {
  return {
    dealId: draft.message.dealId,
    agreementDigest: draft.message.agreementDigest,
    arbitrationPolicyId: draft.message.arbitrationPolicyId,
    origin: draft.message.origin,
    rulingNonce: draft.message.rulingNonce,
    sellerAward: BigInt(draft.message.sellerAward),
    buyerBondCost: BigInt(draft.message.buyerBondCost),
    sellerBondCost: BigInt(draft.message.sellerBondCost),
    evidenceCommitment: draft.message.evidenceCommitment,
    authEpoch: BigInt(draft.message.authEpoch),
    queueExpiry: BigInt(draft.message.queueExpiry),
  };
}

const RULING_DOMAIN = { name: "MidmanEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: HUB };

async function approveAs(app, dealId, draft, signer, epoch = "1") {
  const signature = await signer.signTypedData({
    domain: RULING_DOMAIN,
    types: RULING_TYPES,
    primaryType: "Ruling",
    message: rulingMessage(draft),
  });
  const body = {
    signer: signer.address,
    signature,
    rulingDigest: draft.rulingDigest,
    epoch,
    origin: draft.message.origin,
  };
  // Any reviewer may relay an approval; auth wallet is revA (allowlisted).
  return call(app, revA, "POST", `/review/cases/${dealId}/approvals`, body);
}

describe("reviewer service (Phase 9)", () => {
  before(() => {
    process.env["REVIEWER_WALLETS"] = [revA.address, revB.address, revC.address, vetoer.address].join(",");
  });

  beforeEach(() => {
    __resetReviewRegistryForTests();
    __resetAwardsForTests();
    __resetApprovalsForTests();
    __resetProposalsForTests();
  });

  it("exposes the exact frozen Ruling/Mutual field order", async () => {
    assert.deepEqual([...RULING_FIELD_ORDER], [
      "dealId",
      "agreementDigest",
      "arbitrationPolicyId",
      "origin",
      "rulingNonce",
      "sellerAward",
      "buyerBondCost",
      "sellerBondCost",
      "evidenceCommitment",
      "authEpoch",
      "queueExpiry",
    ]);
    assert.deepEqual([...MUTUAL_FIELD_ORDER], [
      "dealId",
      "agreementDigest",
      "sellerAward",
      "buyerBondCost",
      "sellerBondCost",
      "expectedPhase",
      "settlementNonce",
      "expiresAt",
    ]);
  });

  it("assignment + recusal quorum math (recused signer excluded)", async () => {
    const { app } = makeApp();
    const assigned = await assignDefault(app);
    assert.deepEqual(
      [...assigned.primary].sort(),
      [revA.address, revB.address, revC.address].sort(),
    );

    const recuseBody = { reviewer: revA.address, reason: "conflict of interest" };
    const recused = await call(app, revA, "POST", `/review/cases/${DEAL}/recuse`, recuseBody);
    assert.equal(recused.statusCode, 200);
    const recusedJson = recused.json();
    assert.equal(recusedJson.recusals.length, 1);
    assert.deepEqual(recusedJson.remainingEligible.primary.sort(), [revB.address, revC.address].sort());

    // Recused signer approval is rejected and counts as ABSENT.
    const draft = await draftDefault(app);
    const denied = await approveAs(app, DEAL, draft, revA);
    assert.equal(denied.statusCode, 403);

    const okB = await approveAs(app, DEAL, draft, revB);
    assert.equal(okB.statusCode, 200);
    assert.equal(okB.json().have, 1);

    const detail = await call(app, revA, "GET", `/review/cases/${DEAL}`);
    assert.equal(detail.statusCode, 200);
    const bundle = detail.json();
    assert.equal(bundle.recusals.length, 1);
    assert.equal(bundle.approvals[0].have, 1);
    assert.deepEqual(bundle.approvals[0].signers, [revB.address]);

    // Direct registry check: recusal does not halt the case.
    assert.equal(reviewRegistry.getCase(DEAL).recusals.length, 1);
    assert.deepEqual(
      reviewRegistry.eligible(DEAL, "primary").sort(),
      [revB.address, revC.address].sort(),
    );
  });

  it("award derivation vectors: S=70/100 P with exact bond costs", async () => {
    const { app } = makeApp();
    await assignDefault(app);

    const partial = await draftDefault(app);
    assert.equal(partial.sellerAward, "70000000");
    assert.equal(partial.buyerCost, "3500000"); // floor(5_000_000 * 70_000_000 / 100_000_000)
    assert.equal(partial.sellerCost, "1500000"); // floor(5_000_000 * 30_000_000 / 100_000_000)
    assert.equal(partial.earnedFeePreview, "350000"); // floor(500_000 * 70M / 100M)

    const full = await draftDefault(app, { sellerAwardUnits: "100000000", rulingNonce: NONCE_B });
    assert.equal(full.buyerCost, "5000000"); // Cb = Qb at S=P
    assert.equal(full.sellerCost, "0"); // Cs = 0 at S=P

    const zero = await draftDefault(app, {
      sellerAwardUnits: "0",
      rulingNonce: "0x0101010101010101010101010101010101010101010101010101010101010101",
    });
    assert.equal(zero.buyerCost, "0");
    assert.equal(zero.sellerCost, "5000000");

    // All money is exact decimal strings.
    for (const key of ["sellerAward", "buyerCost", "sellerCost", "earnedFeePreview"]) {
      assert.match(partial[key], /^[0-9]+$/);
    }
  });

  it("approval sig verification: member ok, outsider rejected, duplicate rejected, 2-of-3 completes", async () => {
    const { app } = makeApp();
    await assignDefault(app);
    const draft = await draftDefault(app);

    const first = await approveAs(app, DEAL, draft, revA);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), {
      rulingDigest: draft.rulingDigest,
      origin: 0,
      have: 1,
      need: 2,
      signers: [revA.address],
      complete: false,
    });

    // Outsider signature (valid sig, non-member wallet) is rejected.
    const outsiderResult = await approveAs(app, DEAL, draft, outsider);
    assert.equal(outsiderResult.statusCode, 403);

    // Duplicate signer is rejected.
    const duplicate = await approveAs(app, DEAL, draft, revA);
    assert.equal(duplicate.statusCode, 409);

    // Wrong-epoch approval is rejected (deal epoch binding).
    const stale = await approveAs(app, DEAL, draft, revB, "999");
    assert.equal(stale.statusCode, 400);

    const second = await approveAs(app, DEAL, draft, revB);
    assert.equal(second.statusCode, 200);
    const progress = second.json();
    assert.equal(progress.have, 2);
    assert.equal(progress.need, 2);
    assert.equal(progress.complete, true);

    // Quorum-gated queue-ruling now returns calldata + relay payload (no submission).
    const queued = await call(app, revA, "POST", `/review/cases/${DEAL}/queue-ruling`, {
      rulingDigest: draft.rulingDigest,
    });
    assert.equal(queued.statusCode, 200);
    const payload = queued.json();
    assert.match(payload.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(payload.relayPayload.action, "queuePrimaryRuling");
    assert.equal(payload.relayPayload.idempotencyKey.length > 0, true);
    assert.equal(payload.signatures.length, 2);
  });

  it("queue-ruling requires quorum (409 before, 200 after)", async () => {
    const { app } = makeApp();
    await assignDefault(app);
    const draft = await draftDefault(app);
    const early = await call(app, revA, "POST", `/review/cases/${DEAL}/queue-ruling`, {
      rulingDigest: draft.rulingDigest,
    });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().have, 0);

    await approveAs(app, DEAL, draft, revA);
    await approveAs(app, DEAL, draft, revB);
    const late = await call(app, revA, "POST", `/review/cases/${DEAL}/queue-ruling`, {
      rulingDigest: draft.rulingDigest,
    });
    assert.equal(late.statusCode, 200);
  });

  it("veto payload shape: cancel-only, no award/recipient fields", async () => {
    const { app } = makeApp();
    await assignDefault(app);
    const draft = await draftDefault(app);
    const rulingDigest = draft.rulingDigest;
    const vetoNonce = "0x1212121212121212121212121212121212121212121212121212121212121212";
    const expiry = Math.floor(Date.now() / 1_000) + 3_600;
    const message = {
      dealId: DEAL,
      rulingDigest,
      authority: vetoer.address,
      nonce: vetoNonce,
      expiresAt: BigInt(expiry),
    };
    const signature = await vetoer.signTypedData({
      domain: RULING_DOMAIN,
      types: {
        VetoRuling: [
          { name: "dealId", type: "bytes32" },
          { name: "rulingDigest", type: "bytes32" },
          { name: "authority", type: "address" },
          { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      primaryType: "VetoRuling",
      message,
    });
    const body = {
      rulingDigest,
      origin: 0,
      vsigs: [{ authority: vetoer.address, nonce: vetoNonce, expiry, signature }],
    };
    const res = await call(app, vetoer, "POST", `/review/cases/${DEAL}/veto`, body);
    assert.equal(res.statusCode, 200);
    const veto = res.json();
    assert.equal(veto.effect, "cancel-only");
    assert.ok(!("sellerAward" in veto));
    assert.ok(!("buyerCost" in veto));
    assert.ok(!("sellerCost" in veto));
    assert.ok(!("award" in veto));
    assert.ok(!("recipient" in veto));
    assert.match(veto.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(veto.relayPayload.action, "vetoPrimaryRuling");
    assert.deepEqual(veto.authorities, [vetoer.address]);
  });

  it("settlement proposal bounds: S>P rejected, costs>posted rejected, accept returns calldata", async () => {
    const { app, store } = makeApp();
    await store.createDraft({
      id: "draft_settle_1",
      dealId: DEAL,
      creatorWallet: buyer.address,
      counterpartyHint: seller.address,
      counterpartyAddress: seller.address,
      terms: { buyer: buyer.address, seller: seller.address },
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "accepted",
    });
    const base = {
      principalUnits: PRINCIPAL,
      claimantBondUnits: CLAIMANT_BOND,
      respondentBondUnits: RESPONDENT_BOND,
      agreementDigest: AGREEMENT,
      buyer: buyer.address,
      seller: seller.address,
      chainId: CHAIN_ID,
      hub: HUB,
    };
    const tooBig = await call(app, buyer, "POST", `/deals/${DEAL}/settlement-proposals`, {
      ...base,
      sellerAwardUnits: "100000001",
      buyerCostUnits: "0",
      sellerCostUnits: "0",
      expectedPhase: 4,
    });
    assert.equal(tooBig.statusCode, 400);

    const overBond = await call(app, buyer, "POST", `/deals/${DEAL}/settlement-proposals`, {
      ...base,
      sellerAwardUnits: "60000000",
      buyerCostUnits: "5000001",
      sellerCostUnits: "0",
      expectedPhase: 4,
    });
    assert.equal(overBond.statusCode, 400);

    const created = await call(app, buyer, "POST", `/deals/${DEAL}/settlement-proposals`, {
      ...base,
      sellerAwardUnits: "60000000",
      buyerCostUnits: "1000000",
      sellerCostUnits: "1000000",
      expectedPhase: 4,
    });
    assert.equal(created.statusCode, 200);
    const proposal = created.json();
    assert.equal(proposal.bondsUnverified, true); // no chain reader: explicit-bond fallback
    assert.match(proposal.sellerAward, /^[0-9]+$/);

    const listed = await call(app, buyer, "GET", `/deals/${DEAL}/settlement-proposals`);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().proposals.length, 1);

    const mutualMessage = {
      dealId: DEAL,
      agreementDigest: proposal.agreementDigest,
      sellerAward: BigInt(proposal.sellerAward),
      buyerBondCost: BigInt(proposal.buyerCost),
      sellerBondCost: BigInt(proposal.sellerCost),
      expectedPhase: proposal.expectedPhase,
      settlementNonce: proposal.settlementNonce,
      expiresAt: BigInt(proposal.expiresAt),
    };
    // Proposer (buyer) signs the exact proposal struct; counterparty (seller)
    // signs the identical struct at accept time.
    const proposerSig = await buyer.signTypedData({
      domain: RULING_DOMAIN,
      types: MUTUAL_TYPES,
      primaryType: "MutualSettlement",
      message: mutualMessage,
    });
    const sellerSig = await seller.signTypedData({
      domain: RULING_DOMAIN,
      types: MUTUAL_TYPES,
      primaryType: "MutualSettlement",
      message: mutualMessage,
    });
    const accepted = await call(app, seller, "POST", `/settlement-proposals/${proposal.id}/accept`, {
      counterparty: seller.address,
      signature: sellerSig,
      proposerSignature: proposerSig,
    });
    assert.equal(accepted.statusCode, 200);
    const result = accepted.json();
    assert.match(result.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(result.relayPayload.action, "mutualSettlement");
    assert.equal(result.proposal.status, "accepted");

    // Re-accept of a closed proposal is rejected.
    const again = await call(app, seller, "POST", `/settlement-proposals/${proposal.id}/accept`, {
      counterparty: seller.address,
      signature: sellerSig,
    });
    assert.equal(again.statusCode, 409);
  });

  it("escalation data shape: estimated policy-minimum fallback + windows", async () => {
    const { app } = makeApp();
    const res = await call(app, revA, "GET", `/deals/${DEAL}/escalation`);
    assert.equal(res.statusCode, 200);
    const escalation = res.json();
    assert.equal(escalation.dealId, DEAL);
    assert.equal(escalation.claimantBond, "5000000"); // policy minimum fallback
    assert.equal(escalation.respondentBond, "5000000");
    assert.equal(escalation.source, "estimated");
    assert.equal(escalation.estimated, true);
    assert.ok(typeof escalation.windows === "object");
    assert.ok("deadlines" in escalation.windows);
  });

  it("review queue + case bundle shape", async () => {
    const { app } = makeApp();
    await assignDefault(app);
    await draftDefault(app);

    const queue = await call(app, revA, "GET", "/review/queue");
    assert.equal(queue.statusCode, 200);
    const entries = queue.json().queue;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].dealId, DEAL);
    assert.equal(entries[0].stage, "unknown"); // no chain reader: projection
    assert.ok("deadlines" in entries[0]);

    const detail = await call(app, revB, "GET", `/review/cases/${DEAL}`);
    assert.equal(detail.statusCode, 200);
    const bundle = detail.json();
    assert.ok(Array.isArray(bundle.evidence.entries));
    assert.equal(bundle.deliveryForm, null);
    assert.equal(bundle.drafts.length, 1);
    assert.equal(bundle.quorumNeed, 2);
    assert.ok("remainingEligible" in bundle);

    // Strangers cannot read the queue.
    const stranger = await call(app, outsider, "GET", "/review/queue");
    assert.equal(stranger.statusCode, 403);
  });
});
