// Validation + client-behavior tests for @midman/api-client.
// Run AFTER build: `node --test test/client.test.mjs` from packages/api-client.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  ApiValidationError,
  MidmanClient,
  validateApprovalProgress,
  validateAwardDraft,
  validateConfirmation,
  validateDealStatus,
  validateEscalationInfo,
  validateEvidenceManifestEntry,
  validateRecoveryPackage,
  validateRelayJob,
  validateReviewCaseBundle,
  validateReviewQueueItem,
  validateSettlementProposal,
  validateSettlementQuote,
  validateVetoPayload,
  isDealStatus,
  isReviewCaseBundle,
} from "../dist/index.js";

const A = `0x${"11".repeat(20)}`;
const B = `0x${"22".repeat(20)}`;
const HUB = `0x${"33".repeat(20)}`;
const USDC = `0x${"44".repeat(20)}`;
const DEAL = `0x${"aa".repeat(32)}`;
const H1 = `0x${"bb".repeat(32)}`;
const H2 = `0x${"cc".repeat(32)}`;
const ZERO = `0x${"00".repeat(32)}`;

const deadlines = {
  evidenceEnd: null,
  primaryEnd: null,
  fallbackEnd: null,
  escapeAt: null,
  secondsToEvidenceEnd: null,
  secondsToEscape: null,
};

const manifestEntry = {
  dealId: DEAL,
  seq: 0,
  uploader: A,
  kind: "delivery",
  description: "packing slip",
  fileHash: H1,
  prevHash: ZERO,
  head: H2,
  scan: { status: "deferred" },
  filename: "slip.bin",
  mimetype: "application/octet-stream",
  size: 10,
  at: "2026-01-01T00:00:00.000Z",
};

const awardDraft = {
  dealId: DEAL,
  agreementDigest: H1,
  arbitrationPolicyId: H2,
  origin: 0,
  rulingNonce: H1,
  sellerAward: "100",
  buyerCost: "10",
  sellerCost: "10",
  earnedFeePreview: "5",
  evidenceCommitment: H2,
  authEpoch: "7",
  queueExpiry: "9999999999",
  rulingDigest: H1,
  domain: { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: HUB },
  types: {},
  primaryType: "Ruling",
  message: {
    dealId: DEAL,
    agreementDigest: H1,
    arbitrationPolicyId: H2,
    origin: 0,
    rulingNonce: H1,
    sellerAward: "100",
    buyerBondCost: "10",
    sellerBondCost: "10",
    evidenceCommitment: H2,
    authEpoch: "7",
    queueExpiry: "9999999999",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

const fixtures = {
  quote: {
    prepaidBuyerFee: "1",
    earnedFee: "2",
    buyerFee: "3",
    sellerFee: "4",
    buyerClaim: "5",
    sellerClaim: "6",
    funded: "7",
    source: "offchain-preview",
  },
  statusChain: { dealId: DEAL, source: "chain", phase: "EVIDENCE", events: 3 },
  confirmation: { dealId: DEAL, level: "safe", txBlock: "10", safeBlock: "9", finalizedBlock: null },
  recovery: {
    version: 1,
    chainId: 8453,
    hub: HUB,
    usdc: USDC,
    dealId: DEAL,
    agreementDigest: H1,
    canonicalTerms: { buyer: A },
    signatures: { buyer: H1, seller: H1 },
    policyIds: {},
    relevantTransactions: [],
    indexerTip: null,
    emergencyCalldata: { refundForNonDelivery: "0x1234" },
    note: "n",
  },
  relayJob: {
    idempotencyKey: "k",
    queue: "relay",
    action: "fund",
    params: {},
    status: "queued",
    attempts: 0,
    txHash: null,
    result: null,
  },
  manifestEntry,
  queueItem: {
    dealId: DEAL,
    source: "chain",
    phase: "EVIDENCE",
    phaseIndex: 4,
    inDispute: true,
    stage: "EVIDENCE",
    deadlines,
    primaryEligible: [A],
    fallbackEligible: [B],
    recusals: 0,
  },
  caseBundle: {
    dealId: DEAL,
    chain: null,
    evidence: { head: H2, entries: [manifestEntry] },
    deliveryForm: null,
    primary: [A],
    fallback: [B],
    recusals: [],
    remainingEligible: { primary: [A], fallback: [B] },
    drafts: [awardDraft],
    approvals: [{ rulingDigest: H1, origin: 0, have: 1, need: 2, signers: [A], complete: false }],
    quorumNeed: 2,
  },
  awardDraft,
  proposal: {
    id: "prop_0001",
    dealId: DEAL,
    proposer: A,
    buyer: A,
    seller: B,
    sellerAward: "100",
    buyerCost: "10",
    sellerCost: "10",
    expectedPhase: 4,
    agreementDigest: H1,
    settlementNonce: H2,
    expiresAt: "9999999999",
    principal: "5000000",
    claimantBond: "5000000",
    respondentBond: "5000000",
    bondsUnverified: false,
    proposerSignature: null,
    chainId: 8453,
    hub: HUB,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  escalation: {
    dealId: DEAL,
    claimantBond: "5000000",
    respondentBond: "5000000",
    source: "estimated",
    estimated: true,
    policyNote: "fallback",
    windows: {
      now: "100",
      fundedAt: null,
      deliveredAt: null,
      disputeOpenedAt: null,
      escalatedAt: null,
      selfResolutionEnd: null,
      escalationEnd: null,
      deadlines,
    },
  },
  veto: {
    dealId: DEAL,
    rulingDigest: H1,
    origin: 0,
    effect: "cancel-only",
    authorities: [A],
    vsigs: [{ authority: A, nonce: H2, expiry: "9999999999", signature: "0x1234" }],
    calldata: "0x1234",
    relayPayload: { idempotencyKey: "k", action: "vetoPrimaryRuling", params: {} },
    note: "n",
  },
};

const validators = {
  quote: validateSettlementQuote,
  statusChain: validateDealStatus,
  confirmation: validateConfirmation,
  recovery: validateRecoveryPackage,
  relayJob: validateRelayJob,
  manifestEntry: validateEvidenceManifestEntry,
  queueItem: validateReviewQueueItem,
  caseBundle: validateReviewCaseBundle,
  awardDraft: validateAwardDraft,
  proposal: validateSettlementProposal,
  escalation: validateEscalationInfo,
  veto: validateVetoPayload,
};

// Required-field-missing: drop the first required key of each fixture.
const dropKey = {
  quote: "funded",
  statusChain: "dealId",
  confirmation: "level",
  recovery: "dealId",
  relayJob: "action",
  manifestEntry: "fileHash",
  queueItem: "deadlines",
  caseBundle: "quorumNeed",
  awardDraft: "rulingDigest",
  proposal: "settlementNonce",
  escalation: "windows",
  veto: "vsigs",
};

// Wrong-type: replace a string field with a number.
const wrongTypeKey = {
  quote: "funded",
  statusChain: "phase",
  confirmation: "dealId",
  recovery: "hub",
  relayJob: "action",
  manifestEntry: "kind",
  queueItem: "stage",
  caseBundle: "dealId",
  awardDraft: "sellerAward",
  proposal: "sellerAward",
  escalation: "estimated",
  veto: "origin",
};

for (const [name, validate] of Object.entries(validators)) {
  describe(`schema ${name}`, () => {
    it("accepts the valid fixture", () => {
      const value = validate(structuredClone(fixtures[name]), "$");
      assert.equal(typeof value, "object");
    });
    it("rejects a missing required field", () => {
      const bad = structuredClone(fixtures[name]);
      delete bad[dropKey[name]];
      assert.throws(() => validate(bad, "$"), ApiValidationError);
    });
    it("rejects a wrong-typed field", () => {
      const bad = structuredClone(fixtures[name]);
      bad[wrongTypeKey[name]] = 12345;
      assert.throws(() => validate(bad, "$"), ApiValidationError);
    });
  });
}

describe("predicates", () => {
  it("isDealStatus narrows the chain shape", () => {
    assert.equal(isDealStatus(fixtures.statusChain), true);
    assert.equal(isDealStatus({}), false);
  });
  it("isReviewCaseBundle rejects the legacy web shape", () => {
    // Legacy web guard shape (deal/manifest/awards/approvals-object) must NOT pass.
    assert.equal(isReviewCaseBundle({ deal: {}, evidence: { manifest: [], head: "x" } }), false);
    assert.equal(isReviewCaseBundle(fixtures.caseBundle), true);
  });
  it("approval progress validates quorum fields", () => {
    assert.deepEqual(validateApprovalProgress(fixtures.caseBundle.approvals[0], "$").have, 1);
  });
});

// ---- Client behavior against a stub fetch ----

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

describe("MidmanClient", () => {
  it("returns validated data on 200-valid", async () => {
    const client = new MidmanClient("http://api.test", async () => jsonResponse(200, fixtures.statusChain));
    const status = await client.getStatus(DEAL);
    assert.equal(status.source, "chain");
    assert.equal(status.phase, "EVIDENCE");
  });

  it("passes API {error} through as ApiError with status", async () => {
    const client = new MidmanClient("http://api.test", async () => jsonResponse(400, { error: "Invalid quote" }));
    await assert.rejects(() => client.getQuote("draft_1"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Invalid quote/);
      return true;
    });
  });

  it("throws ApiValidationError with the endpoint path on 200-invalid-shape", async () => {
    const client = new MidmanClient("http://api.test", async () => jsonResponse(200, { bogus: 1 }));
    await assert.rejects(() => client.getStatus(DEAL), (error) => {
      assert.ok(error instanceof ApiValidationError);
      assert.match(error.message, /\/deals\//);
      return true;
    });
  });

  it("throws ApiError status 0 on transport failure", async () => {
    const client = new MidmanClient("http://api.test", async () => {
      throw new Error("down");
    });
    await assert.rejects(() => client.health(), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      return true;
    });
  });

  it("refuses to propose settlement without the live settlementNonce (no fetch)", async () => {
    let fetched = false;
    const client = new MidmanClient("http://api.test", async () => {
      fetched = true;
      return jsonResponse(200, fixtures.proposal);
    });
    // Guard throws synchronously (before any fetch) — assert.throws, not rejects.
    assert.throws(
      () =>
        client.proposeSettlement(DEAL, {
          sellerAwardUnits: "100",
          buyerCostUnits: "10",
          sellerCostUnits: "10",
          expectedPhase: 4,
          settlementNonce: "",
        }),
      ApiValidationError,
    );
    assert.equal(fetched, false);
  });

  it("uploadEvidence passes prebuilt bytes + content-type + signed headers through", async () => {
    const seen = {};
    const body = new Uint8Array([1, 2, 3]);
    const uploadResult = {
      seq: 0,
      fileHash: H1,
      commitment: H2,
      receipt: { payload: "p", signature: "0x1234", signer: A },
      scan: { status: "deferred" },
    };
    const client = new MidmanClient("http://api.test", async (url, init) => {
      seen.url = url;
      seen.init = init;
      return jsonResponse(200, uploadResult);
    });
    const result = await client.uploadEvidence(DEAL, body, "multipart/form-data; boundary=x", { "x-wallet-address": A });
    assert.equal(result.fileHash, H1);
    assert.match(seen.url, /\/evidence$/);
    assert.equal(seen.init.headers["content-type"], "multipart/form-data; boundary=x");
    assert.equal(seen.init.headers["x-wallet-address"], A);
    assert.deepEqual(new Uint8Array(seen.init.body), body);
  });

  it("health validates the full shape", async () => {
    const payload = { ok: true, degraded: false, chainId: 8453, rpc: true, hub: null };
    const client = new MidmanClient("http://api.test", async () => jsonResponse(200, payload));
    assert.deepEqual(await client.health(), payload);
  });
});
