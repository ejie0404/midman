// Phase 11 adversarial end-to-end acceptance.
//
// One Fastify app per scenario, built by registering EVERY browser-facing route
// group directly (registerRoutes, registerEvidenceRoutes, registerCategoryRoutes,
// registerMessageRoutes, registerCommitmentRoutes, registerReviewRoutes) against
// a MemoryStore and a MUTABLE scripted ChainReader stub. The stub's getDeal
// returns deal records the test mutates as the acceptance progresses, so
// /deals/:id/status, reviewer deadline/escalation math, and relay preconditions
// all read "chain" state. buildServer/server.ts is intentionally NOT imported.
//
// Auth reuses the shared signed-request scheme verbatim (EIP-191 personal_sign
// of `${METHOD}\n${req.url}\n${sha256hex(bodyBytes)}\n${expiry}`), exercised with
// real viem keys. Worker-side pure/ops subsystems (relay preconditions, capacity
// admission, abuse controls, monitoring) are the same dist the worker runs, so
// the scenarios cross the API boundary into the exact ops code paths the browser
// triggers indirectly.
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { toFunctionSelector } from "viem";

import { MemoryStore } from "../dist/db.js";
import { registerRoutes } from "../dist/routes.js";
import { registerEvidenceRoutes } from "../dist/evidence/routes.js";
import {
  EVIDENCE_AUTH_APP,
  buildMetadataSignedMessage,
  evidenceAuthDomain,
} from "../dist/evidence/access.js";
import {
  registerCategoryRoutes,
  registerMessageRoutes,
  registerCommitmentRoutes,
} from "../dist/categories/routes.js";
import { registerReviewRoutes } from "../dist/review/routes.js";
import {
  InMemoryDeliveryFormRegistry,
  InMemoryMessageThreadRegistry,
} from "../dist/categories/registry.js";
import { __resetBlobStoreForTests } from "../dist/evidence/store.js";
import { __resetRegistryForTests } from "../dist/evidence/registry.js";
import { __resetReceiptSignerForTests } from "../dist/evidence/receipts.js";
import { MAX_UPLOAD_BYTES } from "../dist/evidence/uploadChecks.js";
import { RULING_TYPES, __resetAwardsForTests } from "../dist/review/awards.js";
import { __resetApprovalsForTests } from "../dist/review/approvals.js";
import { MUTUAL_TYPES, __resetProposalsForTests } from "../dist/review/proposals.js";
import { VETO_TYPES } from "../dist/review/routes.js";
import { __resetReviewRegistryForTests } from "../dist/review/registry.js";

// Worker ops subsystems (same compiled dist the worker entrypoint loads).
import { processRelayJob } from "../../worker/dist/relay.js";
import { progressionPass, escapePass, dueAction } from "../../worker/dist/progression.js";
import { runMonitoringPass, AlertDeduper } from "../../worker/dist/monitoring/index.js";
import {
  AdmissionControls,
  admissionLimitsFromEnv,
  aggregateExposure,
  DEFAULT_AGGREGATE_PAIR_CAP_UNITS_PER_24H,
} from "../../worker/dist/capacity/admission.js";
import { AbuseControls } from "../../worker/dist/reliability/abuse.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453;
const ZERO32 = `0x${"00".repeat(32)}`;
const NOW = Math.floor(Date.now() / 1_000);
const NO_SPONSOR = { key: null, rpcUrl: null, dailyCapTxs: 50 };

const BUYER_KEY = `0x${"11".repeat(32)}`;
const SELLER_KEY = `0x${"22".repeat(32)}`;
const THIRD_KEY = `0x${"33".repeat(32)}`;
const REV_A_KEY = `0x${"aa".repeat(32)}`;
const REV_B_KEY = `0x${"bb".repeat(32)}`;
const REV_C_KEY = `0x${"cc".repeat(32)}`;
const REV_D_KEY = `0x${"dd".repeat(32)}`;
const REV_E_KEY = `0x${"ee".repeat(32)}`;
const VETO_KEY = `0x${"44".repeat(32)}`;
const RECEIPT_KEY = `0x${"55".repeat(32)}`;

const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);
const third = privateKeyToAccount(THIRD_KEY);
const revA = privateKeyToAccount(REV_A_KEY);
const revB = privateKeyToAccount(REV_B_KEY);
const revC = privateKeyToAccount(REV_C_KEY);
const revD = privateKeyToAccount(REV_D_KEY);
const revE = privateKeyToAccount(REV_E_KEY);
const vetoer = privateKeyToAccount(VETO_KEY);

const EXPLICIT_AGREEMENT = bytes32("agreement");
const ARB_POLICY = bytes32("arbitration-policy");
const NONCE_A = bytes32("ruling-nonce-a");
const NONCE_B = bytes32("ruling-nonce-b");

let evidenceDir = "";

function bytes32(seed) {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- signed-request client (exact spec from src/evidence/access.ts) ----
async function signHeaders(account, method, url, bodyBytes, contentType) {
  const bodyHash = sha256hex(bodyBytes ?? Buffer.alloc(0));
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const message = `${method.toUpperCase()}\n${url}\n${bodyHash}\n${expiry}`;
  const signature = await account.signMessage({ message });
  const headers = {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
  };
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

async function call(app, account, method, url, payload) {
  if (payload === undefined) {
    return app.inject({ method, url, headers: await signHeaders(account, method, url) });
  }
  const bodyStr = JSON.stringify(payload);
  return app.inject({
    method,
    url,
    headers: await signHeaders(account, method, url, Buffer.from(bodyStr, "utf8"), "application/json"),
    payload: bodyStr,
  });
}

function buildMultipartBody(boundary, fields, file) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(Buffer.from(file.bytes));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function uploadEvidence(app, dealId, account, { bytes, filename, contentType, kind, description }) {
  const boundary = "----midman-phase11-boundary";
  const body = buildMultipartBody(boundary, { kind, description }, { filename, contentType, bytes });
  const url = `/deals/${dealId}/evidence`;
  // Evidence mutations require the metadata-bound signature, bound to the
  // parsed multipart filename/mime/size/content hash.
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const nonce = randomBytes(16).toString("hex");
  const fileHash = sha256hex(bytes);
  const mime = contentType || "application/octet-stream";
  const message = buildMetadataSignedMessage({
    app: EVIDENCE_AUTH_APP,
    domain: evidenceAuthDomain(),
    method: "POST",
    path: url,
    dealId,
    action: "evidence.upload",
    fileHash,
    filename,
    mime,
    size: String(bytes.length),
    bodySha256: sha256hex(Buffer.alloc(0)),
    nonce,
    expiry,
  });
  const signature = await account.signMessage({ message });
  return app.inject({
    method: "POST",
    url,
    headers: {
      "x-wallet-address": account.address,
      "x-wallet-expiry": expiry,
      "x-wallet-signature": signature,
      "x-request-nonce": nonce,
      "x-request-action": "evidence.upload",
      "x-request-deal": dealId,
      "x-request-file": fileHash,
      "x-request-filename": filename,
      "x-request-mime": mime,
      "x-request-size": String(bytes.length),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}

function ok(res, code, context = "") {
  assert.equal(res.statusCode, code, `${context} -> ${res.statusCode}: ${res.body}`);
  return res;
}

// ---- scripted mutable chain ----
function baseDeal(overrides = {}) {
  return {
    funded: true,
    phase: 4,
    buyer: buyer.address,
    seller: seller.address,
    principal: 100_000_000n,
    quotedFee: 500_000n,
    prepaidBuyerFee: 500_000n,
    buyerFeeBps: 10000,
    deliveryPeriod: 3600,
    inspectionPeriod: 43200,
    fundedAt: 1_000_000n,
    deliveredAt: 1_000_100n,
    disputeOpenedAt: 0n,
    disputeUsed: false,
    escalatedAt: 0n,
    fallbackStartedAt: 0n,
    rulingQueued: false,
    rulingExecuteAt: 0n,
    claimantBond: 5_000_000n,
    respondentBond: 5_000_000n,
    termsHash: EXPLICIT_AGREEMENT,
    ...overrides,
  };
}

function makeChain() {
  const deals = new Map();
  const claims = new Map();
  let liabilities = 0n;
  let balance = 0n;
  let claimsFail = false;
  const reader = {
    async getDeal(_hub, dealId) {
      const deal = deals.get(String(dealId).toLowerCase());
      if (!deal) throw new Error("Unknown deal");
      return { ...deal };
    },
    async getClaim(_hub, claimId) {
      if (claimsFail) throw new Error("token-wide claim failure");
      const claim = claims.get(String(claimId).toLowerCase());
      if (!claim) throw new Error("Unknown claim");
      return { ...claim };
    },
    async getLiabilities() {
      return liabilities;
    },
    async getTokenBalance() {
      return balance;
    },
    async getLatestBlockNumber() {
      return 99n;
    },
    async getBlock(number) {
      return { number: BigInt(number), hash: ZERO32, parentHash: ZERO32, timestamp: 1 };
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
    async isPanelMember() {
      return false;
    },
    async getBondPolicy() {
      return { claimantBond: 5_000_000n, respondentBond: 5_000_000n };
    },
  };
  return {
    reader,
    deals,
    claims,
    setDeal(dealId, record) {
      deals.set(dealId.toLowerCase(), record);
    },
    patchDeal(dealId, patch) {
      const key = dealId.toLowerCase();
      deals.set(key, { ...(deals.get(key) ?? {}), ...patch });
    },
    setLiabilities(value) {
      liabilities = value;
    },
    setBalance(value) {
      balance = value;
    },
    failClaims(value = true) {
      claimsFail = value;
    },
  };
}

function makeApp({ store, reader, hub = HUB, chainId = CHAIN_ID, rpcConfigured = true }) {
  const app = Fastify({ logger: false });
  const deps = { store, reader: reader ?? null, indexer: null, hub, usdc: USDC, chainId, rpcConfigured };
  registerRoutes(app, deps);
  registerEvidenceRoutes(app, deps);
  const opts = {
    forms: new InMemoryDeliveryFormRegistry(),
    threads: new InMemoryMessageThreadRegistry(),
  };
  registerCategoryRoutes(app, deps, opts);
  registerMessageRoutes(app, deps, opts);
  registerCommitmentRoutes(app, deps);
  registerReviewRoutes(app, deps);
  return app;
}

function makeWorld() {
  const store = new MemoryStore();
  const chain = makeChain();
  const app = makeApp({ store, reader: chain.reader });
  return { app, store, chain, reader: chain.reader };
}

// ---- draft helpers ----
function draftBody(termOverrides = {}) {
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
      agreementHash: bytes32("agreement-hash"),
      policyIds: {
        fee: bytes32("fee-policy"),
        category: bytes32("category-policy"),
        evidence: bytes32("evidence-policy"),
        bond: bytes32("bond-policy"),
        arbitration: bytes32("arbitration-policy"),
        outage: bytes32("outage-policy"),
        catastrophic: bytes32("catastrophic-policy"),
      },
      platformFeeRecipient: buyer.address,
      arbitrationCostRecipient: seller.address,
      hub: HUB,
      token: USDC,
      chainId: CHAIN_ID,
      ...termOverrides,
    },
  };
}

async function createDraft(app, termOverrides = {}) {
  const res = ok(await app.inject({ method: "POST", url: "/drafts", payload: draftBody(termOverrides) }), 200, "createDraft");
  return res.json();
}

async function acceptDraft(app, id) {
  ok(await app.inject({ method: "POST", url: `/drafts/${id}/invite` }), 200, "invite");
  ok(
    await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      payload: { counterpartyAddress: seller.address },
    }),
    200,
    "accept",
  );
}

async function signAsSeller(app, terms) {
  const signature = await seller.signTypedData({
    domain: {
      name: "MidmanDraft",
      version: "1",
      chainId: Number(terms.chainId),
      verifyingContract: terms.hub,
    },
    types: {
      DealTerms: [
        { name: "dealId", type: "bytes32" },
        { name: "principal", type: "uint256" },
        { name: "quotedPlatformFee", type: "uint256" },
        { name: "buyer", type: "address" },
        { name: "seller", type: "address" },
      ],
    },
    primaryType: "DealTerms",
    message: {
      dealId: terms.dealId,
      principal: BigInt(terms.principalUnits),
      quotedPlatformFee: BigInt(terms.quotedFeeUnits),
      buyer: terms.buyer,
      seller: terms.seller,
    },
  });
  return signature;
}

async function createAcceptedDraft(app, termOverrides = {}) {
  const created = await createDraft(app, termOverrides);
  await acceptDraft(app, created.id);
  const signature = await signAsSeller(app, created.terms);
  ok(
    await app.inject({
      method: "POST",
      url: `/drafts/${created.id}/signatures`,
      payload: { role: "seller", signature },
    }),
    200,
    "sign",
  );
  return created;
}

async function downloadDigest(app, id) {
  return ok(await app.inject({ method: "GET", url: `/drafts/${id}/download` }), 200, "download").json().agreementDigest;
}

async function assignPanel(app, dealId) {
  return ok(
    await call(app, revA, "POST", `/review/cases/${dealId}/assign`, {
      primary: [revA.address, revB.address, revC.address],
      fallback: [revD.address, revE.address, vetoer.address],
    }),
    200,
    "assign",
  ).json();
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

async function draftAwardHttp(app, dealId, overrides = {}) {
  const body = {
    principalUnits: "100000000",
    quotedFeeUnits: "500000",
    buyerFeeBps: 10000,
    sellerAwardUnits: "0",
    claimantBondUnits: "5000000",
    respondentBondUnits: "5000000",
    evidenceCommitment: bytes32("evidence-commitment"),
    origin: 0,
    rulingNonce: NONCE_A,
    authEpoch: "1",
    queueExpiry: String(NOW + 86_400),
    arbitrationPolicyId: ARB_POLICY,
    agreementDigest: EXPLICIT_AGREEMENT,
    ...overrides,
  };
  const res = await call(app, revA, "POST", `/review/cases/${dealId}/awards/draft`, body);
  ok(res, 200, "draftAward");
  return res.json();
}

async function approveAs(app, dealId, draft, signer, epoch = "1") {
  const signature = await signer.signTypedData({
    domain: {
      name: draft.domain.name,
      version: draft.domain.version,
      chainId: draft.domain.chainId,
      verifyingContract: draft.domain.verifyingContract,
    },
    types: RULING_TYPES,
    primaryType: "Ruling",
    message: rulingMessage(draft),
  });
  return call(app, revA, "POST", `/review/cases/${dealId}/approvals`, {
    signer: signer.address,
    signature,
    rulingDigest: draft.rulingDigest,
    epoch,
    origin: draft.message.origin,
  });
}

async function submitRelay(app, idempotencyKey, action, params) {
  const res = await app.inject({
    method: "POST",
    url: "/relay/submit",
    payload: { idempotencyKey, action, params },
  });
  return res;
}

describe("Phase 11 acceptance (one app, scripted chain)", () => {  before(async () => {
    delete process.env["S3_BUCKET"];
    delete process.env["POLICIES_ADDRESS"];
    delete process.env["CLAMAV_HOST"];
    process.env["EVIDENCE_KEK_HEX"] = "ab".repeat(32);
    process.env["RECEIPT_SIGNER_KEY"] = RECEIPT_KEY;
    evidenceDir = await mkdtemp(join(tmpdir(), "midman-phase11-"));
    process.env["EVIDENCE_DIR"] = evidenceDir;
    process.env["REVIEWER_WALLETS"] = [revA, revB, revC, revD, revE, vetoer]
      .map((a) => a.address)
      .join(",");
  });

  beforeEach(() => {
    __resetReviewRegistryForTests();
    __resetAwardsForTests();
    __resetApprovalsForTests();
    __resetProposalsForTests();
    __resetRegistryForTests();
    __resetBlobStoreForTests();
    __resetReceiptSignerForTests();
  });

  after(async () => {
    await rm(evidenceDir, { recursive: true, force: true }).catch(() => {});
  });

  // (a) Happy path: create -> invite -> accept -> sign -> fund -> deliver ->
  // inspect -> release -> claims, driving status by mutating the stub deal.
  it("(a) happy path with exact funding/payout/fee amounts", async () => {
    const { app, store, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { id, dealId, terms } = created;

    ok(await call(app, buyer, "GET", `/drafts/${id}/quote?sellerAward=100000000`), 200, "quote");
    const preview = (
      await call(app, buyer, "GET", `/drafts/${id}/quote?sellerAward=100000000`)
    ).json();
    assert.equal(preview.funded, "100500000");
    assert.equal(preview.prepaidBuyerFee, "500000");
    assert.equal(preview.earnedFee, "500000");
    assert.equal(preview.buyerClaim, "0");
    assert.equal(preview.sellerClaim, "100000000");

    const summary = ok(await app.inject({ method: "GET", url: `/drafts/${id}/summary` }), 200, "summary").json();
    assert.equal(summary.amounts.principalUnits, "100000000");
    assert.equal(summary.amounts.quotedFeeUnits, "500000");
    assert.equal(summary.amounts.fundedUnits, "100500000");
    assert.equal(summary.amounts.effectiveFeeBps, "50");
    assert.equal(summary.parties.payouts.sellerPayout, seller.address);
    assert.equal(summary.parties.payouts.buyerRefund, buyer.address);

    // Fund precondition: chain says unfunded -> relay precondition is "unfunded".
    // A malformed/undecodable fund calldata is now rejected by the worker's
    // calldata validator (action↔calldata parity), so it fails closed instead
    // of being submitted. The direct-fallback (unsigned) path is asserted below
    // for the signed actions the worker encodes itself.
    chain.setDeal(
      dealId,
      baseDeal({ funded: false, phase: 0, fundedAt: 0n, deliveredAt: 0n, escalatedAt: 0n }),
    );
    ok(await submitRelay(app, "fund-a", "fund", { dealId, data: "0x1234" }), 200, "relay fund");
    const fundJob = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "fund-a",
    });
    assert.equal(fundJob.status, "failed");
    assert.match(String((await store.getRelay("fund-a")).result.reason), /calldata/);

    // Chain now reflects funding -> status is chain-first.
    chain.setDeal(
      dealId,
      baseDeal({ phase: 0, buyer: buyer.address, seller: seller.address, fundedAt: 1_000_000n }),
    );
    const funded = ok(await app.inject({ method: "GET", url: `/deals/${dealId}/status` }), 200, "status").json();
    assert.equal(funded.source, "chain");
    assert.equal(funded.phase, "AWAITING_DELIVERY");

    // Deliver + inspect: seller posts the delivery form, buyer reads it.
    const form = ok(
      await call(app, seller, "POST", `/deals/${dealId}/delivery-form`, {
        category: "GAME_ITEM",
        data: { itemName: "Dragon Blade", recipientId: "player-4821", tradeId: "trade-9917" },
      }),
      200,
      "delivery-form",
    ).json();
    assert.match(form.deliveryManifestHash, /^0x[0-9a-f]{64}$/);
    ok(await call(app, buyer, "GET", `/deals/${dealId}/delivery-form`), 200, "read form");
    chain.patchDeal(dealId, { phase: 1, deliveredAt: 1_000_100n });
    const delivered = ok(await app.inject({ method: "GET", url: `/deals/${dealId}/status` }), 200, "status").json();
    assert.equal(delivered.phase, "DELIVERED");

    // Release: relay precondition on phase 1 is active (ok) -> unsigned.
    ok(
      await submitRelay(app, "release-a", "approveSeller", {
        dealId,
        terminalPolicyVersion: ZERO32,
        nonce: ZERO32,
        expiresAt: NOW + 3600,
        sig: "0x1234",
      }),
      200,
      "relay release",
    );
    const releaseJob = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "release-a",
    });
    assert.equal(releaseJob.status, "unsigned");

    // Claims: chain settles; the off-chain preview stays exact.
    chain.patchDeal(dealId, { phase: 9 });
    const settled = ok(await app.inject({ method: "GET", url: `/deals/${dealId}/status` }), 200, "status").json();
    assert.equal(settled.phase, "SETTLED");
    const claims = (
      await call(app, buyer, "GET", `/drafts/${id}/quote?sellerAward=100000000`)
    ).json();
    assert.equal(claims.buyerClaim, "0");
    assert.equal(claims.sellerClaim, "100000000");
    assert.equal(claims.earnedFee, "500000");
    void terms;
  });

  // (b) False delivery: S=0 primary award, buyer full+refund, zero fee/arb.
  it("(b) false delivery: S=0 award, buyer full+refund, zero fee and zero arb revenue", async () => {
    const { app, store, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId, terms } = created;
    chain.setDeal(
      dealId,
      baseDeal({
        phase: 1,
        deliveredAt: 1_000_100n,
        disputeOpenedAt: 0n,
        disputeUsed: false,
        claimantBond: 5_000_000n,
        respondentBond: 0n,
      }),
    );

    // Buyer opens dispute (precondition: phase 1, unused).
    ok(
      await submitRelay(app, "dispute-b", "openDispute", {
        dealId,
        reasonCode: 0,
        initialCommitment: ZERO32,
        nonce: NONCE_A,
        expiresAt: NOW + 3600,
        sig: "0x1234",
      }),
      200,
      "relay dispute",
    );
    const disputeJob = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "dispute-b",
    });
    assert.equal(disputeJob.status, "unsigned");
    chain.patchDeal(dealId, { phase: 4, disputeUsed: true, disputeOpenedAt: BigInt(NOW - 100) });

    // Both parties upload evidence (multipart).
    const buyerFile = Buffer.from("buyer dispute evidence: never delivered", "utf8");
    const sellerFile = Buffer.from("seller claims shipped, tracking attached", "utf8");
    ok(
      await uploadEvidence(app, dealId, buyer, {
        bytes: buyerFile,
        filename: "buyer.txt",
        contentType: "text/plain",
        kind: "dispute",
        description: "buyer dispute record",
      }),
      200,
      "buyer evidence",
    );
    ok(
      await uploadEvidence(app, dealId, seller, {
        bytes: sellerFile,
        filename: "seller.txt",
        contentType: "text/plain",
        kind: "dispute",
        description: "seller rebuttal",
      }),
      200,
      "seller evidence",
    );
    const manifest = ok(
      await call(app, buyer, "GET", `/deals/${dealId}/evidence`),
      200,
      "manifest",
    ).json();
    assert.equal(manifest.entries.length, 2);
    const evidenceCommitment = manifest.head;
    assert.match(evidenceCommitment, /^0x[0-9a-f]{64}$/);

    await assignPanel(app, dealId);
    const draft = await draftAwardHttp(app, dealId, {
      sellerAwardUnits: "0",
      claimantBondUnits: "5000000",
      respondentBondUnits: "0",
      evidenceCommitment,
      arbitrationPolicyId: ARB_POLICY,
      agreementDigest: await downloadDigest(app, created.id),
    });
    assert.equal(draft.buyerCost, "0");
    assert.equal(draft.sellerCost, "0");
    assert.equal(draft.earnedFeePreview, "0");

    // Quorum 2-of-3.
    assert.equal((await approveAs(app, dealId, draft, revA)).json().complete, false);
    const done = await approveAs(app, dealId, draft, revB);
    assert.equal(done.json().complete, true);

    chain.patchDeal(dealId, { phase: 5 });
    const queued = ok(
      await call(app, revA, "POST", `/review/cases/${dealId}/queue-ruling`, { rulingDigest: draft.rulingDigest }),
      200,
      "queue-ruling",
    ).json();
    assert.match(queued.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(queued.relayPayload.action, "queuePrimaryRuling");

    // Execute after delay.
    chain.patchDeal(dealId, { phase: 7, rulingQueued: true, rulingExecuteAt: NOW - 1 });
    ok(await submitRelay(app, "execute-b", "executeRuling", { dealId }), 200, "relay execute");
    const execJob = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "execute-b",
    });
    assert.equal(execJob.status, "unsigned");
    chain.patchDeal(dealId, { phase: 9 });

    const claims = (await call(app, buyer, "GET", `/drafts/${created.id}/quote?sellerAward=0`)).json();
    assert.equal(claims.buyerClaim, "100500000");
    assert.equal(claims.sellerClaim, "0");
    assert.equal(claims.earnedFee, "0");
    assert.equal(BigInt(draft.buyerCost) + BigInt(draft.sellerCost), 0n);
    void terms;
  });

  // (c) Partial S=70% with proportional bond costs.
  it("(c) partial S=70% derives exact proportional bond costs and final claims", async () => {
    const { app, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    chain.setDeal(dealId, baseDeal({ phase: 5, claimantBond: 5_000_000n, respondentBond: 5_000_000n }));
    await assignPanel(app, dealId);
    const digest = await downloadDigest(app, created.id);
    const draft = await draftAwardHttp(app, dealId, {
      sellerAwardUnits: "70000000",
      claimantBondUnits: "5000000",
      respondentBondUnits: "5000000",
      evidenceCommitment: bytes32("partial-evidence"),
      agreementDigest: digest,
    });
    assert.equal(draft.sellerAward, "70000000");
    assert.equal(draft.buyerCost, "3500000");
    assert.equal(draft.sellerCost, "1500000");
    assert.equal(draft.earnedFeePreview, "350000");

    const buyerBond = 5_000_000n;
    const sellerBond = 5_000_000n;
    const buyerRefund = buyerBond - BigInt(draft.buyerCost);
    const sellerRefund = sellerBond - BigInt(draft.sellerCost);
    assert.equal(buyerRefund.toString(), "1500000");
    assert.equal(sellerRefund.toString(), "3500000");
    assert.equal((BigInt(draft.buyerCost) + BigInt(draft.sellerCost)).toString(), "5000000");

    const claims = (
      await call(app, buyer, "GET", `/drafts/${created.id}/quote?sellerAward=70000000`)
    ).json();
    assert.equal(claims.earnedFee, "350000");
    assert.equal(claims.buyerClaim, "30150000");
    assert.equal(claims.sellerClaim, "70000000");

    await approveAs(app, dealId, draft, revA);
    const done = await approveAs(app, dealId, draft, revB);
    assert.equal(done.json().complete, true);
    const queued = ok(
      await call(app, revA, "POST", `/review/cases/${dealId}/queue-ruling`, { rulingDigest: draft.rulingDigest }),
      200,
      "queue",
    ).json();
    assert.equal(queued.relayPayload.action, "queuePrimaryRuling");
  });

  // (d) Lapsed escalation + exhausted second dispute.
  it("(d) lapsed escalation surfaces lapse and a second openDispute is exhausted", async () => {
    const { app, store, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    chain.setDeal(dealId, baseDeal({ phase: 1, disputeUsed: false, disputeOpenedAt: 0n }));
    const disputedAt = NOW - 200_000;
    chain.patchDeal(dealId, { phase: 2, disputeUsed: true, disputeOpenedAt: BigInt(disputedAt) });

    // A10: the negotiation window is anchored on DISPUTE OPEN, not delivery.
    const windows = ok(
      await call(app, buyer, "GET", `/deals/${dealId}/escalation`),
      200,
      "escalation windows",
    ).json().windows;
    assert.equal(windows.selfResolutionEnd, String(disputedAt + 86_400));
    assert.equal(windows.escalationEnd, String(disputedAt + 172_800));

    const later = disputedAt + 172_800 + 3_600 + 1;
    assert.equal(dueAction(baseDeal({ ...chain.deals.get(dealId) }), later), "lapseDispute");
    const enqueued = await progressionPass({ store, reader: chain.reader, hub: HUB, nowSeconds: later });
    assert.equal(enqueued.length, 1);
    assert.match(enqueued[0], /lapseDispute/);

    ok(
      await submitRelay(app, "second-dispute", "openDispute", {
        dealId,
        nonce: NONCE_B,
        expiresAt: later + 3600,
        sig: "0x1234",
      }),
      200,
      "relay second dispute",
    );
    const second = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "second-dispute",
    });
    assert.equal(second.status, "skipped");
    assert.equal((await store.getRelay("second-dispute")).result.reason, "not-disputable");
  });

  // (e) Missing respondent: award completes on claimant evidence alone.
  it("(e) missing respondent completes the award on claimant evidence", async () => {
    const { app, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    chain.setDeal(dealId, baseDeal({ phase: 4, claimantBond: 5_000_000n, respondentBond: 0n }));
    const onlyBuyer = ok(
      await uploadEvidence(app, dealId, buyer, {
        bytes: Buffer.from("sole claimant evidence", "utf8"),
        filename: "claimant.txt",
        contentType: "text/plain",
        kind: "dispute",
        description: "claimant record",
      }),
      200,
      "claimant evidence",
    ).json();
    const manifest = ok(await call(app, buyer, "GET", `/deals/${dealId}/evidence`), 200, "manifest").json();
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].uploader, buyer.address);
    assert.equal(manifest.head, onlyBuyer.commitment);

    await assignPanel(app, dealId);
    const digest = await downloadDigest(app, created.id);
    const draft = await draftAwardHttp(app, dealId, {
      sellerAwardUnits: "0",
      claimantBondUnits: "5000000",
      respondentBondUnits: "0",
      evidenceCommitment: manifest.head,
      agreementDigest: digest,
    });
    assert.equal(draft.sellerCost, "0");
    assert.equal(draft.buyerCost, "0");
    assert.equal(draft.earnedFeePreview, "0");
    await approveAs(app, dealId, draft, revA);
    const done = await approveAs(app, dealId, draft, revB);
    assert.equal(done.json().complete, true);
    chain.patchDeal(dealId, { phase: 5 });
    ok(
      await call(app, revA, "POST", `/review/cases/${dealId}/queue-ruling`, { rulingDigest: draft.rulingDigest }),
      200,
      "queue",
    );
    const claims = (await call(app, buyer, "GET", `/drafts/${created.id}/quote?sellerAward=0`)).json();
    assert.equal(claims.buyerClaim, "100500000");
    assert.equal(claims.sellerClaim, "0");
  });

  // (f) Mutual settlement + stale-nonce proposal.
  it("(f) mutual settlement countersign works and a stale-nonce offer is rejected", async () => {
    const { app, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    chain.setDeal(dealId, baseDeal({ phase: 4, claimantBond: 5_000_000n, respondentBond: 5_000_000n }));
    const domain = { name: "MidmanEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: HUB };
    const settlementNonce = "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e";
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const base = {
      sellerAwardUnits: "60000000",
      buyerCostUnits: "1000000",
      sellerCostUnits: "1000000",
      expectedPhase: 4,
      agreementDigest: EXPLICIT_AGREEMENT,
      settlementNonce,
      expiresAt: String(expiresAt),
    };
    // The proposer signs the authoritative envelope BEFORE publishing.
    const message1 = {
      dealId,
      agreementDigest: EXPLICIT_AGREEMENT,
      sellerAward: 60_000_000n,
      buyerBondCost: 1_000_000n,
      sellerBondCost: 1_000_000n,
      expectedPhase: 4,
      settlementNonce,
      expiresAt: BigInt(expiresAt),
    };
    const buyerSig = await buyer.signTypedData({ domain, types: MUTUAL_TYPES, primaryType: "MutualSettlement", message: message1 });
    const created1 = ok(
      await call(app, buyer, "POST", `/deals/${dealId}/settlement-proposals`, { ...base, proposerSignature: buyerSig }),
      200,
      "propose",
    ).json();
    assert.equal(created1.bondsUnverified, false);
    const list = ok(await call(app, buyer, "GET", `/deals/${dealId}/settlement-proposals`), 200, "list").json();
    assert.equal(list.proposals.length, 1);

    const sellerSig = await seller.signTypedData({ domain, types: MUTUAL_TYPES, primaryType: "MutualSettlement", message: message1 });
    const accepted = ok(
      await call(app, seller, "POST", `/settlement-proposals/${created1.id}/accept`, {
        counterparty: seller.address,
        signature: sellerSig,
        proposerSignature: buyerSig,
      }),
      200,
      "accept proposal",
    ).json();
    assert.match(accepted.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(accepted.relayPayload.action, "mutualSettlement");
    assert.equal(accepted.proposal.status, "accepted");
    assert.match(accepted.note, /settlementNonce/);

    // Re-accept a closed proposal is a 409.
    const again = await call(app, seller, "POST", `/settlement-proposals/${created1.id}/accept`, {
      counterparty: seller.address,
      signature: sellerSig,
    });
    assert.equal(again.statusCode, 409);

    // A superseded nonce: the counterparty signs struct #1 but submits against
    // a fresh proposal #2 (signed by the proposer for its own envelope).
    const message2 = { ...message1, sellerAward: 50_000_000n };
    const buyerSig2 = await buyer.signTypedData({ domain, types: MUTUAL_TYPES, primaryType: "MutualSettlement", message: message2 });
    const created2 = ok(
      await call(app, buyer, "POST", `/deals/${dealId}/settlement-proposals`, {
        ...base,
        sellerAwardUnits: "50000000",
        proposerSignature: buyerSig2,
      }),
      200,
      "propose 2",
    ).json();
    const stale = await call(app, seller, "POST", `/settlement-proposals/${created2.id}/accept`, {
      counterparty: seller.address,
      signature: sellerSig,
      proposerSignature: buyerSig2,
    });
    assert.equal(stale.statusCode, 400);
    assert.match(stale.json().error, /recover/i);
  });

  // (g) Veto is cancel-only and hands off to the independent fallback.
  it("(g) veto returns cancel-only payload with no award/recipient fields", async () => {
    const { app, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    chain.setDeal(dealId, baseDeal({ phase: 5 }));
    await assignPanel(app, dealId);
    const draft = await draftAwardHttp(app, dealId, {
      sellerAwardUnits: "70000000",
      agreementDigest: await downloadDigest(app, created.id),
    });
    const vetoNonce = bytes32("veto-nonce");
    const expiry = NOW + 3600;
    const message = {
      dealId,
      rulingDigest: draft.rulingDigest,
      authority: vetoer.address,
      nonce: vetoNonce,
      expiresAt: BigInt(expiry),
    };
    const signature = await vetoer.signTypedData({
      domain: { name: "MidmanEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: HUB },
      types: VETO_TYPES,
      primaryType: "VetoRuling",
      message,
    });
    const veto = ok(
      await call(app, vetoer, "POST", `/review/cases/${dealId}/veto`, {
        rulingDigest: draft.rulingDigest,
        origin: 0,
        vsigs: [{ authority: vetoer.address, nonce: vetoNonce, expiry, signature }],
      }),
      200,
      "veto",
    ).json();
    assert.equal(veto.effect, "cancel-only");
    assert.ok(!("sellerAward" in veto));
    assert.ok(!("buyerCost" in veto));
    assert.ok(!("sellerCost" in veto));
    assert.ok(!("award" in veto));
    assert.ok(!("recipient" in veto));
    assert.equal(veto.relayPayload.action, "vetoPrimaryRuling");
    assert.deepEqual(veto.authorities, [vetoer.address]);

    const fallbackVeto = ok(
      await call(app, vetoer, "POST", `/review/cases/${dealId}/veto`, {
        rulingDigest: draft.rulingDigest,
        origin: 1,
        vsigs: [{ authority: vetoer.address, nonce: bytes32("veto-nonce-2"), expiry, signature: await vetoer.signTypedData({
          domain: { name: "MidmanEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: HUB },
          types: VETO_TYPES,
          primaryType: "VetoRuling",
          message: { ...message, nonce: bytes32("veto-nonce-2") },
        }) }],
      }),
      200,
      "fallback veto",
    ).json();
    assert.equal(fallbackVeto.relayPayload.action, "vetoFallbackRuling");
    chain.patchDeal(dealId, { phase: 6, fallbackStartedAt: BigInt(NOW) });
    const status = ok(await app.inject({ method: "GET", url: `/deals/${dealId}/status` }), 200, "status").json();
    assert.equal(status.phase, "FALLBACK_REVIEW");
  });

  // (h) Revoked terms: fund path unavailable (chain-flip) + revoke-note intent.
  it("(h) revoked terms make the fund path unavailable and the note records intent", async () => {
    const { app, store, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { id, dealId } = created;

    const note = ok(
      await app.inject({ method: "POST", url: `/drafts/${id}/revoke-note`, payload: { by: buyer.address } }),
      200,
      "revoke-note",
    ).json();
    assert.equal(note.ok, true);
    assert.equal(note.note.by, buyer.address);
    assert.match(note.pendingUntil, /chain inclusion/);

    // Chain-flip: the digest is revoked and the deal is (still) unfunded.
    chain.setDeal(dealId, baseDeal({ funded: false, phase: 0, revokedTerms: true }));
    const status = ok(await app.inject({ method: "GET", url: `/deals/${dealId}/status` }), 200, "status").json();
    assert.equal(status.source, "draft");
    assert.equal(status.status, "revocation-noted");

    // Funded-only relay paths are unavailable while the deal is unfunded.
    ok(
      await submitRelay(app, "revoked-dispute", "openDispute", {
        dealId,
        nonce: NONCE_A,
        expiresAt: NOW + 3600,
        sig: "0x1234",
      }),
      200,
      "relay",
    );
    const skipped = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "revoked-dispute",
    });
    assert.equal(skipped.status, "skipped");
    assert.equal((await store.getRelay("revoked-dispute")).result.reason, "not-funded");
  });

  // (i) Forwarded invitation binds to the intended counterparty.
  it("(i) a forwarded invitation accepted by another wallet is rejected 409", async () => {
    const { app } = makeWorld();
    await app.ready();
    const created = await createDraft(app);
    ok(await app.inject({ method: "POST", url: `/drafts/${created.id}/invite` }), 200, "invite");
    const forwarded = await app.inject({
      method: "POST",
      url: `/drafts/${created.id}/accept`,
      payload: { counterpartyAddress: third.address },
    });
    assert.equal(forwarded.statusCode, 409);
    assert.match(forwarded.json().error, /intended invitee/i);
  });

  // (j) Failed services degrade without crashing; secret inputs are rejected.
  it("(j) missing services degrade to 503/4xx and secret inputs are rejected 400", async () => {
    // --- missing reader / hub / chainId ---
    const store = new MemoryStore();
    const app = makeApp({ store, reader: null, hub: null, chainId: null, rpcConfigured: false });
    await app.ready();
    const created = await createDraft(app);
    const dealId = created.terms.dealId;

    assert.equal((await call(app, buyer, "GET", `/tx/${bytes32("tx")}/status`)).statusCode, 503);
    assert.equal((await call(app, buyer, "GET", `/deals/${dealId}/confirmation`)).statusCode, 503);
    assert.equal(
      (await app.inject({ method: "POST", url: `/drafts/${created.id}/readiness-payload` })).statusCode,
      503,
    );
    assert.equal((await call(app, buyer, "GET", `/deals/${dealId}/recovery`)).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/indexer/tick" })).statusCode, 503);

    const payloadPath = `/deals/${dealId}/evidence/payload`;
    const commitment = {
      uploader: seller.address,
      sequence: 0,
      prevCommitment: ZERO32,
      fileHashes: [bytes32("file-a")],
      metadataCommitment: bytes32("meta"),
      nonce: bytes32("commit-nonce"),
      expiresAt: NOW + 3600,
      agreementDigest: EXPLICIT_AGREEMENT,
    };
    assert.equal((await call(app, seller, "POST", payloadPath, commitment)).statusCode, 503);

    // --- evidence storage failure (oversize > 25MB) degrades to 4xx ---
    assert.equal(
      (
        await uploadEvidence(app, dealId, seller, {
          bytes: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41),
          filename: "huge.txt",
          contentType: "text/plain",
          kind: "delivery",
          description: "oversize",
        })
      ).statusCode,
      413,
    );

    // --- hard I/O storage failure: server answers, never crashes ---
    const brokenDir = join(tmpdir(), `midman-phase11-file-${randomBytes(6).toString("hex")}`);
    await writeFile(brokenDir, "not a directory", "utf8");
    const previousDir = process.env["EVIDENCE_DIR"];
    process.env["EVIDENCE_DIR"] = brokenDir;
    __resetBlobStoreForTests();
    try {
      const stored = await uploadEvidence(app, dealId, seller, {
        bytes: Buffer.from("payload", "utf8"),
        filename: "note.txt",
        contentType: "text/plain",
        kind: "delivery",
        description: "storage failure",
      });
      assert.ok(stored.statusCode >= 400, `expected error code, got ${stored.statusCode}`);
      assert.equal((await app.inject({ method: "GET", url: "/categories" })).statusCode, 200, "server survived");
    } finally {
      process.env["EVIDENCE_DIR"] = previousDir;
      __resetBlobStoreForTests();
      await rm(brokenDir, { force: true }).catch(() => {});
    }

    // --- secret-bearing message and evidence are 400 with finding codes ---
    const seedWords = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const secretMessage = await call(app, seller, "POST", `/deals/${dealId}/messages`, {
      text: `mnemonic: ${seedWords}`,
    });
    assert.equal(secretMessage.statusCode, 400);
    assert.ok(secretMessage.json().errors.some((e) => e.includes("SEED_PHRASE")));
    assert.ok(!secretMessage.body.includes(seedWords));

    const secretFile = await uploadEvidence(app, dealId, seller, {
      bytes: Buffer.from("AKIAIOSFODNN7EXAMPLE", "utf8"),
      filename: "keys.txt",
      contentType: "text/plain",
      kind: "delivery",
      description: "aws key",
    });
    assert.equal(secretFile.statusCode, 400);
    assert.ok(secretFile.json().findings.includes("CLOUD_KEY"));
    assert.ok(!secretFile.body.includes("AKIAIOSFODNN7EXAMPLE"));
  });

  // (k) Subsidised-case abuse: admission signal, rate/duplicate control, alerts.
  it("(k) many small deals hit admission caps and monitoring fires on solvency/abuse", async () => {
    const { app, store, chain } = makeWorld();
    await app.ready();
    const smallDeals = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await createDraft(app, { principalUnits: "5000000" });
      smallDeals.push(created);
      chain.setDeal(
        created.terms.dealId,
        baseDeal({
          buyer: buyer.address,
          seller: seller.address,
          principal: 5_000_000n,
          quotedFee: 500_000n,
          prepaidBuyerFee: 500_000n,
          fundedAt: BigInt(NOW - 10),
          phase: 4,
        }),
      );
    }
    const exposure = aggregateExposure(
      smallDeals.map((d) => ({
        buyer: d.terms.buyer,
        seller: d.terms.seller,
        principal: BigInt(d.terms.principalUnits),
        fundedAt: BigInt(NOW - 10),
      })),
      buyer.address,
      seller.address,
      0,
    );
    assert.equal(exposure, 15_000_000n);

    const controls = new AdmissionControls(admissionLimitsFromEnv({}));
    assert.equal(controls.limits.aggregatePairCapUnitsPer24h, DEFAULT_AGGREGATE_PAIR_CAP_UNITS_PER_24H);
    const overPair = controls.admit({
      category: "GAME_ITEM",
      buyer: buyer.address,
      seller: seller.address,
      principalUnits: 5_000_000n,
      activeEscalatedCount: 0,
      pairExposure24hUnits: DEFAULT_AGGREGATE_PAIR_CAP_UNITS_PER_24H - 5_000_000n + 1n,
    });
    assert.equal(overPair.ok, false);
    assert.equal(overPair.reason, "pair-exposure-limit");
    assert.equal(
      controls.admit({
        category: "GAME_ITEM",
        buyer: buyer.address,
        seller: seller.address,
        principalUnits: 5_000_000n,
        activeEscalatedCount: 20,
        pairExposure24hUnits: 0n,
      }).reason,
      "protocol-concurrency-limit",
    );
    assert.equal(
      controls.admit({
        category: "GAME_ITEM",
        buyer: buyer.address,
        seller: seller.address,
        principalUnits: 5_000_000n,
        activeEscalatedCount: 0,
        activeEscalatedCountPerPod: 5,
        pairExposure24hUnits: 0n,
      }).reason,
      "per-pod-concurrency-limit",
    );
    assert.equal(
      controls.admit({
        category: "PHYSICAL_GOOD",
        buyer: buyer.address,
        seller: seller.address,
        principalUnits: 5_000_000n,
        activeEscalatedCount: 0,
        pairExposure24hUnits: 0n,
      }).reason,
      "category-not-allowlisted",
    );

    // Rate / duplicate / payload abuse controls (deterministic clock).
    const abuse = new AbuseControls({
      relayRatePerMin: 2,
      evidenceRatePerMin: 1,
      duplicateWindowSeconds: 300,
      relayMaxBytes: 10,
      now: () => 1_000,
    });
    assert.equal(abuse.checkRelay("k").allowed, true);
    assert.equal(abuse.checkRelay("k").allowed, true);
    assert.equal(abuse.checkRelay("k").allowed, false);
    assert.equal(abuse.checkUpload("k", 10).allowed, true);
    assert.equal(abuse.checkUpload("k", 10).allowed, false);
    assert.equal(abuse.checkUpload("k2", 0).reason, "bad-size");
    assert.equal(abuse.checkDuplicate("0xAB", 1_000).allowed, true);
    assert.equal(abuse.checkDuplicate("0xab", 1_100).allowed, false);
    assert.equal(abuse.checkDuplicate("0xab", 1_400).allowed, true);
    assert.equal(abuse.checkPayload("x".repeat(11)).reason, "oversize");
    assert.equal(abuse.checkPayload("{}", "0xzz").reason, "non-hex");
    assert.equal(abuse.checkPayload("{}", "0x1234").allowed, true);

    // Monitoring: solvency shortfall + sponsor-cap abuse alerts fire.
    chain.setLiabilities(100n);
    chain.setBalance(90n);
    for (let i = 0; i < 3; i += 1) await store.recordSponsor(`0x${(i + 1).toString(16).padStart(64, "0")}`);
    const seen = [];
    const result = await runMonitoringPass(
      { store, reader: chain.reader, hub: HUB, usdc: USDC },
      NOW,
      {
        sink: { async send(alert) { seen.push(alert); return true; } },
        deduper: new AlertDeduper(900),
        thresholds: {
          largeSettlementUnits: 10_000_000_000n,
          rulingPendingMaxSeconds: 172_800,
          relayFailedMax: 5,
          sponsorDailyTxCap: 2,
          sponsorDailyWeiCap: 0n,
          reviewerInactivitySeconds: 259_200,
        },
      },
    );
    const solvency = seen.find((a) => a.id === "solvency");
    assert.ok(solvency, "solvency alert missing");
    assert.equal(solvency.severity, "critical");
    assert.equal(solvency.details.shortfallUnits, "10");
    assert.ok(seen.some((a) => a.id === "sponsor-cap"), "sponsor-cap alert missing");
    assert.equal(result.delivered, seen.length);
  });

  // (l) 60-day escape eligibility + token-wide claim failure preserves liability.
  it("(l) escape eligibility surfaces and a token-wide claim failure preserves liability", async () => {
    const { app, store, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    const disputeOpenedAt = BigInt(NOW - 5_184_000);
    chain.setDeal(
      dealId,
      baseDeal({ phase: 4, escalatedAt: BigInt(NOW - 100_000), disputeOpenedAt, funded: true }),
    );

    const escapeKeys = await escapePass({ store, reader: chain.reader, hub: HUB, nowSeconds: NOW });
    assert.equal(escapeKeys.length, 1);
    assert.match(escapeKeys[0], /catastrophicEscape/);

    const esc = ok(
      await call(app, revA, "GET", `/deals/${dealId}/escalation`),
      200,
      "escalation",
    ).json();
    assert.equal(
      esc.windows.deadlines.escapeAt,
      (disputeOpenedAt + 5_184_000n).toString(),
    );
    assert.equal(esc.windows.escapeAt, undefined); // escapeAt only surfaces via deadlines
    assert.ok(Number(esc.windows.deadlines.secondsToEscape) <= 0);

    chain.setLiabilities(100n);
    chain.setBalance(100n);
    const seen = [];
    await runMonitoringPass({ store, reader: chain.reader, hub: HUB, usdc: USDC }, NOW, {
      sink: { async send(alert) { seen.push(alert); return true; } },
      deduper: new AlertDeduper(900),
    });
    assert.ok(seen.some((a) => a.id === "escape-eligible"), "escape-eligible alert missing");

    // Token-wide failure: the claim read throws; the relay job is skipped and
    // no submission happens, so the liability is preserved.
    chain.failClaims(true);
    ok(await submitRelay(app, "claim-l", "claimFor", { dealId, kind: 1 }), 200, "relay claim");
    const claimJob = await processRelayJob({
      store,
      reader: chain.reader,
      hub: HUB,
      sponsor: NO_SPONSOR,
      idempotencyKey: "claim-l",
    });
    assert.equal(claimJob.status, "skipped");
    assert.equal((await store.getRelay("claim-l")).result.reason, "claim-unreadable");
    assert.equal(await chain.reader.getLiabilities(), 100n);
  });

  // Extra: frozen schema parity through the evidence-commitment endpoint.
  it("(m) evidence payload preserves the frozen EIP-712 order and never echoes secrets", async () => {
    const { app, chain } = makeWorld();
    await app.ready();
    const created = await createAcceptedDraft(app);
    const { dealId } = created;
    chain.setDeal(dealId, baseDeal({ phase: 4 }));
    const digest = await downloadDigest(app, created.id);
    const body = {
      uploader: seller.address,
      sequence: 0,
      prevCommitment: ZERO32,
      fileHashes: [bytes32("file-a"), bytes32("file-b")],
      metadataCommitment: bytes32("meta"),
      nonce: bytes32("commit-nonce"),
      expiresAt: NOW + 3600,
      agreementDigest: digest,
    };
    const res = ok(await call(app, seller, "POST", `/deals/${dealId}/evidence/payload`, body), 200, "payload");
    const json = res.json();
    assert.deepEqual(
      json.types.EvidenceManifest.map((f) => f.name),
      [
        "dealId",
        "agreementDigest",
        "uploader",
        "sequence",
        "prevCommitment",
        "fileHashes",
        "metadataCommitment",
        "nonce",
        "expiresAt",
      ],
    );
    const selector = toFunctionSelector(
      "submitEvidenceCommitment(bytes32,address,uint32,bytes32,bytes32[],bytes32,bytes32,uint64,bytes)",
    );
    assert.ok(json.calldata.startsWith(selector));
    assert.match(json.commitment, /^0x[0-9a-f]{64}$/);
    assert.deepEqual([...RULING_TYPES.Ruling.map((f) => f.name)], [
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
    assert.deepEqual([...MUTUAL_TYPES.MutualSettlement.map((f) => f.name)], [
      "dealId",
      "agreementDigest",
      "sellerAward",
      "buyerBondCost",
      "sellerBondCost",
      "expectedPhase",
      "settlementNonce",
      "expiresAt",
    ]);
    assert.deepEqual([...VETO_TYPES.VetoRuling.map((f) => f.name)], [
      "dealId",
      "rulingDigest",
      "authority",
      "nonce",
      "expiresAt",
    ]);
  });
});
