import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requestChallenge,
  verifyChallenge,
  getSession,
  signIn,
  logout,
  isUnauthorized,
} from "../lib/session.ts";
import {
  acceptInvitation,
  clearInviteFromLocation,
  InviteError,
  readInviteToken,
  stripInviteToken,
} from "../lib/invite.ts";
import {
  agreementBindingFromDefaults,
  describeAgreement,
  validateDealDefaults,
  withAgreementBinding,
} from "../lib/dealDefaults.ts";
import {
  buildMutualSettlementTypedData,
  fetchReviewCase,
  listSettlementProposals,
  proposeSettlement,
} from "../lib/review.ts";
import { ApiError, ApiValidationError, requireSettlementNonce } from "@midman/api-client";

const BASE = "http://api.test";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x9999999999999999999999999999999999999999";
const DEAL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NONCE = "0x2222222222222222222222222222222222222222222222222222222222222222";
const HASH = "0x3333333333333333333333333333333333333333333333333333333333333333";
const AUTH = { address: WALLET, signMessage: async () => "0xsig" };

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function policyIds() {
  const out = {};
  const keys = ["fee", "category", "readiness", "evidence", "bond", "arbitration", "outage", "catastrophic"];
  keys.forEach((key, index) => {
    out[key] = `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`;
  });
  return out;
}

function validDefaults() {
  return {
    hub: "0x00000000000000000000000000000000000000aa",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chainId: 8453,
    policyIds: policyIds(),
    platformFeeRecipient: "0x4444444444444444444444444444444444444444",
    arbitrationCostRecipient: "0x5555555555555555555555555555555555555555",
  };
}

function manifestEntry(overrides = {}) {
  return {
    dealId: DEAL,
    seq: 0,
    uploader: WALLET,
    kind: "delivery",
    description: "delivery evidence",
    fileHash: HASH,
    prevHash: HASH,
    head: HASH,
    scan: { status: "clean" },
    filename: null,
    mimetype: null,
    size: null,
    at: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function awardDraft() {
  return {
    dealId: DEAL,
    agreementDigest: HASH,
    arbitrationPolicyId: HASH,
    origin: 0,
    rulingNonce: NONCE,
    sellerAward: "70000000",
    buyerCost: "3500000",
    sellerCost: "1500000",
    earnedFeePreview: "350000",
    evidenceCommitment: HASH,
    authEpoch: "1",
    queueExpiry: "2000000",
    rulingDigest: NONCE,
    domain: { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: "0x00000000000000000000000000000000000000aa" },
    types: { Ruling: [] },
    primaryType: "Ruling",
    message: {
      dealId: DEAL,
      agreementDigest: HASH,
      arbitrationPolicyId: HASH,
      origin: 0,
      rulingNonce: NONCE,
      sellerAward: "70000000",
      buyerBondCost: "3500000",
      sellerBondCost: "1500000",
      evidenceCommitment: HASH,
      authEpoch: "1",
      queueExpiry: "2000000",
    },
    createdAt: "2026-10-05T00:00:00.000Z",
  };
}

function serverCaseBundle() {
  return {
    dealId: DEAL,
    chain: { principal: "100000000", quotedFee: "500000", buyerFeeBps: "10000", phase: "5" },
    evidence: { head: HASH, entries: [manifestEntry()] },
    deliveryForm: null,
    primary: [WALLET],
    fallback: [],
    recusals: [],
    remainingEligible: { primary: [WALLET], fallback: [] },
    drafts: [awardDraft()],
    approvals: [
      { rulingDigest: NONCE, origin: 0, have: 1, need: 2, signers: [WALLET], complete: false },
    ],
    quorumNeed: 2,
  };
}

describe("Phase 4 web: session flow (wallet connection alone is NOT auth)", () => {
  it("signIn runs challenge -> sign -> verify -> session with credentials include", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      assert.equal(init.credentials, "include");
      if (String(url).endsWith("/auth/challenge")) {
        return jsonResponse(200, {
          challenge: { domain: "midman.local", chainId: 8453, wallet: WALLET, nonce: NONCE, expiresAt: 1_100 },
          message: "SIGN THIS EXACT MESSAGE",
          uri: "https://midman.local",
          expiresAt: 1_100,
        });
      }
      if (String(url).endsWith("/auth/verify")) {
        const body = JSON.parse(init.body);
        assert.equal(body.nonce, NONCE);
        assert.equal(body.signature, "0xsig");
        return jsonResponse(200, { ok: true, wallet: WALLET, expiresAt: 2_000 });
      }
      if (String(url).endsWith("/auth/session")) {
        return jsonResponse(200, { authenticated: true, wallet: WALLET, issuedAt: 1_000, expiresAt: 2_000 });
      }
      throw new Error(`unexpected ${url}`);
    };
    let signedMessage = null;
    const signer = { address: WALLET, signMessage: async (m) => { signedMessage = m; return "0xsig"; } };
    const session = await signIn(signer, { fetchImpl, baseUrl: BASE, chainId: 8453 });
    assert.equal(signedMessage, "SIGN THIS EXACT MESSAGE");
    assert.equal(session.wallet, WALLET);
    assert.equal(session.expiresAt, 2_000);
    assert.equal(seen.length, 3);
  });

  it("getSession returns anonymous when unauthenticated and isUnauthorized flags 401", async () => {
    const anon = await getSession({ fetchImpl: async () => jsonResponse(200, { authenticated: false }), baseUrl: BASE });
    assert.deepEqual(anon, { authenticated: false });
    assert.equal(isUnauthorized(new ApiError(401, "no session")), true);
    assert.equal(isUnauthorized(new ApiError(500, "boom")), false);
  });

  it("requestChallenge surfaces ApiError on non-2xx", async () => {
    const error = await requestChallenge(WALLET, 8453, {
      fetchImpl: async () => jsonResponse(400, { error: "Invalid wallet address" }),
      baseUrl: BASE,
    }).then(() => null, (e) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
  });

  it("logout POSTs to /auth/logout and resolves", async () => {
    let called = false;
    await logout({
      fetchImpl: async (url, init) => {
        called = true;
        assert.ok(String(url).endsWith("/auth/logout"));
        assert.equal(init.method, "POST");
        return jsonResponse(200, { ok: true });
      },
      baseUrl: BASE,
    });
    assert.equal(called, true);
  });

  it("verifyChallenge rejects a response that is not ok:true", async () => {
    const error = await verifyChallenge(
      { nonce: NONCE, wallet: WALLET, signature: "0xsig" },
      { fetchImpl: async () => jsonResponse(200, { authenticated: false }), baseUrl: BASE },
    ).then(() => null, (e) => e);
    assert.ok(error instanceof ApiError);
  });
});

describe("Phase 4 web: invitation token acceptance + URL cleanup", () => {
  it("reads the invite token from the URL fragment", () => {
    assert.equal(readInviteToken("#invite=abc123"), "abc123");
    assert.equal(readInviteToken("#foo=1&invite=xyz"), "xyz");
    assert.equal(readInviteToken("#nothing"), null);
  });

  it("strips only the invite token from the fragment", () => {
    assert.equal(stripInviteToken("#invite=abc&x=1"), "#x=1");
    assert.equal(stripInviteToken("#invite=abc"), "");
    assert.equal(stripInviteToken("#keep=1"), "#keep=1");
  });

  it("POSTs the token to /drafts/:id/accept after an authenticated session", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      assert.equal(init.credentials, "include");
      if (String(url).endsWith("/auth/session")) {
        return jsonResponse(200, { authenticated: true, wallet: WALLET, issuedAt: 1, expiresAt: 2 });
      }
      if (String(url).endsWith(`/drafts/${DEAL}/accept`)) {
        const body = JSON.parse(init.body);
        assert.equal(body.invitationToken, "secret-token");
        return jsonResponse(200, { ok: true, counterpartyAddress: WALLET });
      }
      throw new Error(`unexpected ${url}`);
    };
    const result = await acceptInvitation(DEAL, "secret-token", { fetchImpl, baseUrl: BASE });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
  });

  it("maps wrong-wallet / expired / consumed invite failures to reasons", async () => {
    const make = (message) =>
      acceptInvitation(DEAL, "secret-token", {
        fetchImpl: async (url) => {
          if (String(url).endsWith("/auth/session")) {
            return jsonResponse(200, { authenticated: true, wallet: WALLET, issuedAt: 1, expiresAt: 2 });
          }
          return jsonResponse(403, { error: message });
        },
        baseUrl: BASE,
      });
    const wrong = await make("Invalid invitation token (wrong-wallet)").then(() => null, (e) => e);
    assert.ok(wrong instanceof InviteError && wrong.reason === "wrong-wallet");
    const expired = await make("Invalid invitation token (expired)").then(() => null, (e) => e);
    assert.ok(expired instanceof InviteError && expired.reason === "expired");
    const consumed = await make("Invalid invitation token (consumed)").then(() => null, (e) => e);
    assert.ok(consumed instanceof InviteError && consumed.reason === "consumed");
  });

  it("refuses to POST without a session (wallet connection is not auth)", async () => {
    let accepted = false;
    const error = await acceptInvitation(DEAL, "secret-token", {
      fetchImpl: async (url) => {
        if (String(url).endsWith("/accept")) accepted = true;
        return jsonResponse(200, { authenticated: false });
      },
      baseUrl: BASE,
    }).then(() => null, (e) => e);
    assert.ok(error instanceof InviteError);
    assert.equal(error.reason, "not-authenticated");
    assert.equal(accepted, false);
  });

  it("clears the token from the visible URL after success", () => {
    const replaced = [];
    const history = { replaceState: (_data, _title, url) => replaced.push(url) };
    const next = clearInviteFromLocation(
      { pathname: "/deals/x/review", search: "?a=1", hash: "#invite=secret" },
      history,
    );
    assert.equal(next, "/deals/x/review?a=1");
    assert.deepEqual(replaced, ["/deals/x/review?a=1"]);
  });
});

describe("Phase 4 web: agreement construction from verified configuration", () => {
  it("validates the /config/deal-defaults shape and rejects a partial policy map", () => {
    const good = validateDealDefaults(validDefaults());
    assert.equal(Object.keys(good.policyIds).length, 8);
    const bad = { ...validDefaults(), policyIds: { fee: HASH } };
    assert.throws(() => validateDealDefaults(bad), ApiValidationError);
  });

  it("binds the eight real policy ids and configured recipients (never the creator wallet)", () => {
    const defaults = validateDealDefaults(validDefaults());
    const binding = agreementBindingFromDefaults(defaults);
    assert.deepEqual(binding.policyIds, policyIds());
    assert.equal(binding.platformFeeRecipient, defaults.platformFeeRecipient);
    assert.equal(binding.arbitrationCostRecipient, defaults.arbitrationCostRecipient);
    assert.notEqual(binding.platformFeeRecipient, WALLET);
    const merged = withAgreementBinding({ buyer: OTHER, seller: WALLET }, defaults);
    assert.equal(Object.keys(merged.policyIds).length, 8);
    assert.equal(merged.platformFeeRecipient, defaults.platformFeeRecipient);
    assert.equal(merged.hub, defaults.hub);
    assert.equal(merged.token, defaults.usdc);
    const display = describeAgreement(defaults);
    assert.equal(display.policies.length, 8);
  });
});

describe("Phase 4 web: shared-client mismatch surfaces an error (never empty)", () => {
  it("rejects a legacy case bundle shape with ApiValidationError", async () => {
    const error = await fetchReviewCase(DEAL, AUTH, async () =>
      jsonResponse(200, { deal: {}, evidence: { manifest: [], head: HASH }, awards: [], quorum: { primary: 1, fallback: 1 } }),
    ).then(() => null, (e) => e);
    assert.ok(error instanceof ApiValidationError);
  });

  it("adapts a valid server case bundle to the workspace view model", async () => {
    const bundle = await fetchReviewCase(DEAL, AUTH, async () => jsonResponse(200, serverCaseBundle()));
    assert.equal(bundle.evidence.manifest.length, 1);
    assert.equal(bundle.evidence.manifest[0].uploadedAt, "2026-10-05T00:00:00.000Z");
    assert.equal(bundle.awards.length, 1);
    assert.equal(bundle.awards[0].sellerAwardUnits, "70000000");
    assert.equal(bundle.approvals.need, 2);
    assert.equal(bundle.quorum.primary, 2);
  });

  it("rejects a legacy bare-array proposals list (never silently empty)", async () => {
    const error = await listSettlementProposals(DEAL, AUTH, async () => jsonResponse(200, [])).then(
      () => null,
      (e) => e,
    );
    assert.ok(error instanceof ApiValidationError);
  });
});

describe("Phase 4 web: settlement nonce required + identical payload", () => {
  it("requireSettlementNonce rejects absent/random values", () => {
    assert.throws(() => requireSettlementNonce(undefined), ApiValidationError);
    assert.throws(() => requireSettlementNonce("0x1234"), ApiValidationError);
    assert.equal(requireSettlementNonce(NONCE), NONCE);
  });

  it("web proposeSettlement refuses to POST without a live nonce", async () => {
    let posted = false;
    const error = await proposeSettlement(
      DEAL,
      { sellerAwardUnits: "1", buyerCostUnits: "0", sellerCostUnits: "0", expectedPhase: 4 },
      AUTH,
      async () => {
        posted = true;
        return jsonResponse(200, {});
      },
    ).then(() => null, (e) => e);
    assert.ok(error instanceof ApiValidationError);
    assert.equal(posted, false);
  });

  it("both parties sign the identical MutualSettlement typed-data payload", () => {
    const envelope = buildMutualSettlementTypedData({
      chainId: 8453,
      hub: "0x00000000000000000000000000000000000000aa",
      dealId: DEAL,
      agreementDigest: HASH,
      sellerAwardUnits: "60000000",
      buyerCostUnits: "1000000",
      sellerCostUnits: "1000000",
      expectedPhase: 4,
      settlementNonce: NONCE,
      expiresAt: 2_000_000,
    });
    assert.equal(envelope.message.settlementNonce, NONCE);
    // The exact same envelope is what both the proposer and counterparty sign.
    const again = buildMutualSettlementTypedData({
      chainId: 8453,
      hub: "0x00000000000000000000000000000000000000aa",
      dealId: DEAL,
      agreementDigest: HASH,
      sellerAwardUnits: "60000000",
      buyerCostUnits: "1000000",
      sellerCostUnits: "1000000",
      expectedPhase: 4,
      settlementNonce: NONCE,
      expiresAt: 2_000_000,
    });
    assert.deepEqual(envelope.message, again.message);
  });
});
