// Round-2 Phase 2 authorization tests.
//
// Builds a fresh Fastify app per test with the declarative guard
// (registerAuthGuards), real routes, and REAL viem keys. Asserts the
// ROUTE_PERMISSIONS register covers every registered route, that anonymous /
// unrelated-wallet / wrong-operator callers are denied, that invitations are
// durable and single-use, that draft identity is bound to the session (body
// wallets ignored), that reviewers are deal-scoped, that assignment requires
// the arbitration operator, and that a chain-read failure never leaks draft
// terms.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryStore } from "../dist/db.js";
import { registerRoutes } from "../dist/routes.js";
import { registerAuthGuards, registerAuthRoutes, getRegisteredRouteKeys } from "../dist/auth/middleware.js";
import { issueLoginChallenge, verifyLoginSignature, __resetChallengesForTests } from "../dist/auth/challenge.js";
import { __resetSessionsForTests } from "../dist/auth/session.js";
import {
  ROUTE_PERMISSIONS,
  missingRoutePermissions,
} from "../dist/auth/routePermissions.js";
import {
  __resetInvitationsForTests,
  recordInvitation,
  revokeInvitation,
} from "../dist/auth/permissions.js";
import { __resetAuthPersistenceForTests } from "../dist/auth/persistence.js";
import { registerEvidenceRoutes } from "../dist/evidence/routes.js";
import {
  registerCategoryRoutes,
  registerMessageRoutes,
  registerCommitmentRoutes,
} from "../dist/categories/routes.js";
import { registerReviewRoutes } from "../dist/review/routes.js";
import {
  assignReviewers,
  listAssignmentAudit,
  __resetReviewRegistryForTests,
} from "../dist/review/registry.js";

const KEYS = {
  buyer: "0x1111111111111111111111111111111111111111111111111111111111111111",
  seller: "0x2222222222222222222222222222222222222222222222222222222222222222",
  outsider: "0x3333333333333333333333333333333333333333333333333333333333333333",
  revA: "0x4444444444444444444444444444444444444444444444444444444444444444",
  revB: "0x5555555555555555555555555555555555555555555555555555555555555555",
  revC: "0x6666666666666666666666666666666666666666666666666666666666666666",
  revD: "0x7777777777777777777777777777777777777777777777777777777777777777",
  arb: "0x8888888888888888888888888888888888888888888888888888888888888888",
  relay: "0x9999999999999999999999999999999999999999999999999999999999999999",
};

const accounts = Object.fromEntries(
  Object.entries(KEYS).map(([name, key]) => [name, privateKeyToAccount(key)]),
);
const { buyer, seller, outsider, revA, revB, revC, revD, arb, relay } = accounts;

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SESSION_SECRET = "authz-test-session-secret-0123456789";

process.env["SESSION_SECRET"] = SESSION_SECRET;
// Global reviewer roster: includes assigned (revA/revB) and unassigned (revC/
// revD) wallets so unassigned denial can be attributed to the guard.
process.env["REVIEWER_WALLETS"] = [revA, revB, revC, revD].map((a) => a.address).join(",");
process.env["OPERATOR_ARBITRATION_WALLETS"] = arb.address;
process.env["OPERATOR_RELAY_WALLETS"] = relay.address;
delete process.env["EVIDENCE_SUPERVISOR"];
delete process.env["POLICIES_ADDRESS"];

const NOW = () => Math.floor(Date.now() / 1_000);

const DEAL = `0x${"aa".repeat(32)}`;
const DEAL2 = `0x${"bb".repeat(32)}`;
const DEAL3 = `0x${"cc".repeat(32)}`;

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cookieOf(res) {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value, "expected a Set-Cookie header");
  return value.split(";")[0];
}

async function issueChallenge(app, account) {
  const res = await app.inject({ method: "POST", url: "/auth/challenge", payload: { wallet: account.address } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  return res.json();
}

async function signIn(app, account) {
  const issued = await issueChallenge(app, account);
  const signature = await account.signMessage({ message: issued.message });
  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { wallet: account.address, nonce: issued.challenge.nonce, signature },
  });
  assert.equal(verify.statusCode, 200, JSON.stringify(verify.json()));
  return { issued, signature, cookie: cookieOf(verify) };
}

async function signedHeaders(account, method, url, bodyBytes = Buffer.alloc(0)) {
  const expiry = String(NOW() + 300);
  const message = `${method.toUpperCase()}\n${url}\n${sha256hex(bodyBytes)}\n${expiry}`;
  const signature = await account.signMessage({ message });
  return { "x-wallet-address": account.address, "x-wallet-expiry": expiry, "x-wallet-signature": signature };
}

async function authedCall(app, account, method, path, body) {
  const { cookie } = await signIn(app, account);
  const bodyBytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const headers = { cookie, ...(await signedHeaders(account, method, path, bodyBytes)) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method, url: path, headers, payload: body });
}

function draftBody(overrides = {}) {
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
      agreementHash: `0x${"01".repeat(32)}`,
      policyIds: { fee: "0xfee" },
      platformFeeRecipient: buyer.address,
      arbitrationCostRecipient: seller.address,
      hub: HUB_ADDR,
      token: USDC,
      chainId: 8453,
    },
    ...overrides,
  };
}

function makeApp({ indexer = null, reader = null } = {}) {
  const store = new MemoryStore();
  const deps = { store, reader, indexer, hub: HUB_ADDR, usdc: USDC, chainId: 8453, rpcConfigured: reader !== null };
  const app = Fastify({ logger: false });
  registerAuthGuards(app, deps);
  registerRoutes(app, deps);
  registerEvidenceRoutes(app, deps);
  registerCategoryRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerCommitmentRoutes(app, deps);
  registerReviewRoutes(app, deps);
  registerAuthRoutes(app, deps);
  return { app, store, deps };
}

async function seedDraft(store, { id, dealId, creatorWallet = buyer.address, status = "accepted" }) {
  await store.createDraft({
    id,
    dealId,
    creatorWallet,
    counterpartyHint: seller.address,
    counterpartyAddress: seller.address,
    terms: { buyer: buyer.address, seller: seller.address },
    signatures: {},
    admission: null,
    revocationNote: null,
    status,
  });
}

beforeEach(() => {
  __resetReviewRegistryForTests();
  __resetAuthPersistenceForTests();
  __resetSessionsForTests();
  __resetChallengesForTests();
  __resetInvitationsForTests();
});

describe("route-permission register coverage", () => {
  it("covers every registered route (fail closed) and exports PUBLIC explicitly", async () => {
    const { app } = makeApp();
    await app.ready();
    const keys = getRegisteredRouteKeys(app);
    assert.ok(keys.length > 10, `expected many registered routes, got ${keys.length}`);
    assert.deepEqual(missingRoutePermissions(keys), [], "every registered route must have a permission entry");
    assert.equal(ROUTE_PERMISSIONS["POST /drafts"].access, "public");
    assert.equal(ROUTE_PERMISSIONS["POST /auth/verify"].access, "public");
    assert.equal(ROUTE_PERMISSIONS["GET /drafts/:id/terms"].access, "creator-or-party");
    assert.equal(ROUTE_PERMISSIONS["POST /review/cases/:dealId/assign"].access, "assignment");
    assert.ok(ROUTE_PERMISSIONS["POST /indexer/tick"].roles.includes("relay"));
    await app.close();
  });

  it("denies an unregistered route for non-operators and allows an operator", async () => {
    const store = new MemoryStore();
    const deps = { store, reader: null, indexer: null, hub: HUB_ADDR, usdc: USDC, chainId: 8453, rpcConfigured: false };
    const app = Fastify({ logger: false });
    registerAuthGuards(app, deps);
    app.get("/mystery", async () => ({ ok: true }));
    registerAuthRoutes(app, deps);

    const anon = await app.inject({ method: "GET", url: "/mystery" });
    assert.equal(anon.statusCode, 401);

    const operator = await authedCall(app, relay, "GET", "/mystery");
    assert.equal(operator.statusCode, 200, JSON.stringify(operator.json()));
    await app.close();
  });
});

describe("draft identity binding + claim", () => {
  it("derives creatorWallet from the session, ignoring the body wallet", async () => {
    const { app, store } = makeApp();
    const { cookie } = await signIn(app, buyer);
    const res = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { cookie },
      payload: draftBody({ creatorWallet: outsider.address }),
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    const { id } = res.json();
    const draft = await store.getDraft(id);
    assert.equal(draft.creatorWallet, buyer.address);
    await app.close();
  });

  it("creates an UNCLAIMED draft anonymously, then binds it on first claim", async () => {
    const { app, store } = makeApp();
    const res = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
    assert.equal(res.statusCode, 200);
    const { id } = res.json();
    assert.equal((await store.getDraft(id)).creatorWallet, "");

    const { cookie } = await signIn(app, buyer);
    const claim = await app.inject({ method: "POST", url: `/drafts/${id}/claim`, headers: { cookie } });
    assert.equal(claim.statusCode, 200, JSON.stringify(claim.json()));
    assert.equal(claim.json().claimed, true);
    assert.equal((await store.getDraft(id)).creatorWallet, buyer.address);

    const { cookie: outsiderCookie } = await signIn(app, outsider);
    const second = await app.inject({ method: "POST", url: `/drafts/${id}/claim`, headers: { cookie: outsiderCookie } });
    assert.equal(second.statusCode, 403);
    await app.close();
  });
});

describe("agreement endpoint access", () => {
  it("rejects anonymous and unrelated-wallet reads of draft terms", async () => {
    const { app } = makeApp();
    const created = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
    const { id } = created.json();
    assert.equal((await app.inject({ method: "GET", url: `/drafts/${id}/terms` })).statusCode, 401);

    const { cookie } = await signIn(app, outsider);
    const res = await app.inject({ method: "GET", url: `/drafts/${id}/terms`, headers: { cookie } });
    assert.equal(res.statusCode, 403);

    const { cookie: sellerCookie } = await signIn(app, seller);
    assert.equal(
      (await app.inject({ method: "GET", url: `/drafts/${id}/terms`, headers: { cookie: sellerCookie } })).statusCode,
      200,
    );
    await app.close();
  });

  it("denies a non-party signing attempt and allows the party", async () => {
    const { app } = makeApp();
    const created = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
    const { id } = created.json();
    const { cookie: outsiderCookie } = await signIn(app, outsider);
    const denied = await app.inject({
      method: "POST",
      url: `/drafts/${id}/signatures`,
      headers: { cookie: outsiderCookie },
      payload: { role: "seller", signature: "0x00" },
    });
    assert.equal(denied.statusCode, 403);
    await app.close();
  });
});

describe("durable invitations", () => {
  async function claimedDraft(app) {
    const { cookie } = await signIn(app, buyer);
    const res = await app.inject({ method: "POST", url: "/drafts", headers: { cookie }, payload: draftBody() });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    return res.json();
  }

  it("requires the creator to issue an invite on a claimed draft", async () => {
    const { app } = makeApp();
    const { id } = await claimedDraft(app);
    const { cookie: outsiderCookie } = await signIn(app, outsider);
    const denied = await app.inject({ method: "POST", url: `/drafts/${id}/invite`, headers: { cookie: outsiderCookie } });
    assert.equal(denied.statusCode, 403);

    const { cookie } = await signIn(app, buyer);
    const allowed = await app.inject({ method: "POST", url: `/drafts/${id}/invite`, headers: { cookie } });
    assert.equal(allowed.statusCode, 200);
    assert.equal(typeof allowed.json().invitationToken, "string");
    await app.close();
  });

  it("issues -> accepts with the intended wallet (happy path)", async () => {
    const { app, store } = makeApp();
    const { id } = await claimedDraft(app);
    const { cookie: buyerCookie } = await signIn(app, buyer);
    const invite = (
      await app.inject({ method: "POST", url: `/drafts/${id}/invite`, headers: { cookie: buyerCookie } })
    ).json();
    const { cookie } = await signIn(app, seller);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      headers: { cookie },
      payload: { counterpartyAddress: outsider.address, invitationToken: invite.invitationToken },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    // Body wallet ignored: the acceptor is the session wallet.
    assert.equal(res.json().counterpartyAddress, seller.address);
    assert.equal((await store.getDraft(id)).counterpartyAddress, seller.address);
    await app.close();
  });

  it("rejects a wrong wallet, a wrong token, an expired token, a revoked token, and a replay", async () => {
    const { app } = makeApp();
    const { id } = await claimedDraft(app);
    const { cookie: buyerCookie } = await signIn(app, buyer);
    const invite = (
      await app.inject({ method: "POST", url: `/drafts/${id}/invite`, headers: { cookie: buyerCookie } })
    ).json();
    const token = invite.invitationToken;

    const { cookie: outsiderCookie } = await signIn(app, outsider);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/drafts/${id}/accept`,
          headers: { cookie: outsiderCookie },
          payload: { counterpartyAddress: outsider.address, invitationToken: token },
        })
      ).statusCode,
      403,
      "wrong wallet",
    );

    const { cookie: sellerCookie } = await signIn(app, seller);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/drafts/${id}/accept`,
          headers: { cookie: sellerCookie },
          payload: { counterpartyAddress: seller.address, invitationToken: randomBytes(32).toString("base64url") },
        })
      ).statusCode,
      403,
      "wrong token",
    );

    // Expired: overwrite the stored invitation with a past expiry.
    recordInvitation(id, token, new Date(Date.now() - 1_000).toISOString(), seller.address);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/drafts/${id}/accept`,
          headers: { cookie: sellerCookie },
          payload: { counterpartyAddress: seller.address, invitationToken: token },
        })
      ).statusCode,
      403,
      "expired",
    );

    // Revoked.
    const { cookie: buyerCookie2 } = await signIn(app, buyer);
    const reissued = (
      await app.inject({ method: "POST", url: `/drafts/${id}/invite`, headers: { cookie: buyerCookie2 } })
    ).json();
    revokeInvitation(id);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/drafts/${id}/accept`,
          headers: { cookie: sellerCookie },
          payload: { counterpartyAddress: seller.address, invitationToken: reissued.invitationToken },
        })
      ).statusCode,
      403,
      "revoked",
    );

    // Consumed/replay.
    const fresh = await claimedDraft(app);
    const { cookie: buyerCookie3 } = await signIn(app, buyer);
    const invite3 = (
      await app.inject({ method: "POST", url: `/drafts/${fresh.id}/invite`, headers: { cookie: buyerCookie3 } })
    ).json();
    const acceptBody = { counterpartyAddress: seller.address, invitationToken: invite3.invitationToken };
    const first = await app.inject({
      method: "POST",
      url: `/drafts/${fresh.id}/accept`,
      headers: { cookie: sellerCookie },
      payload: acceptBody,
    });
    assert.equal(first.statusCode, 200);
    const replay = await app.inject({
      method: "POST",
      url: `/drafts/${fresh.id}/accept`,
      headers: { cookie: sellerCookie },
      payload: acceptBody,
    });
    assert.equal(replay.statusCode, 403, "replay");
    await app.close();
  });
});

describe("challenge replay + login signature separation", () => {
  it("rejects a replayed (consumed) challenge nonce", async () => {
    const { app } = makeApp();
    const issued = await issueChallenge(app, buyer);
    const signature = await buyer.signMessage({ message: issued.message });
    const payload = { wallet: buyer.address, nonce: issued.challenge.nonce, signature };
    assert.equal((await app.inject({ method: "POST", url: "/auth/verify", payload })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/auth/verify", payload })).statusCode, 401);
    await app.close();
  });

  it("rejects a login signature presented as an operator request signature", async () => {
    const stubIndexer = { async tick() { return { scannedTo: 0, added: 0, orphaned: 0, reorg: false }; } };
    const { app } = makeApp({ indexer: stubIndexer });
    const { cookie, signature } = await signIn(app, relay);
    const res = await app.inject({
      method: "POST",
      url: "/indexer/tick",
      headers: {
        cookie,
        "x-wallet-address": relay.address,
        "x-wallet-expiry": String(NOW() + 300),
        "x-wallet-signature": signature,
      },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

describe("EIP-1271 contract-wallet login", () => {
  it("falls back to the contract-wallet verifier and rechecks its verdict", async () => {
    const contract = "0x0000000000000000000000000000000000000123";
    const issued = issueLoginChallenge({ domain: "midman.local", chainId: 8453, wallet: contract });
    const ok = await verifyLoginSignature({
      nonce: issued.challenge.nonce,
      wallet: contract,
      signature: "0x1234",
      expectedChainId: 8453,
      contractWallet: { async verifyMessage() { return true; } },
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));

    const issued2 = issueLoginChallenge({ domain: "midman.local", chainId: 8453, wallet: contract });
    const bad = await verifyLoginSignature({
      nonce: issued2.challenge.nonce,
      wallet: contract,
      signature: "0x1234",
      expectedChainId: 8453,
      contractWallet: { async verifyMessage() { return false; } },
    });
    assert.equal(bad.ok, false);
  });
});

describe("reviewer access is deal-scoped", () => {
  it("denies unassigned reviewers across case/evidence/messages and allows assigned ones", async () => {
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_rev", dealId: DEAL });
    assignReviewers(DEAL, { primary: [revA.address], fallback: [revB.address] });

    // Unassigned reviewer (global roster only): guard denies on every surface.
    const { cookie: revCCookie } = await signIn(app, revC);
    const caseRes = await app.inject({ method: "GET", url: `/review/cases/${DEAL}`, headers: { cookie: revCCookie } });
    assert.equal(caseRes.statusCode, 403, "unassigned review case");

    const evHeaders = { cookie: revCCookie, ...(await signedHeaders(revC, "GET", `/deals/${DEAL}/evidence`)) };
    const evRes = await app.inject({ method: "GET", url: `/deals/${DEAL}/evidence`, headers: evHeaders });
    assert.equal(evRes.statusCode, 403, "unassigned evidence");

    const msgHeaders = { cookie: revCCookie, ...(await signedHeaders(revC, "GET", `/deals/${DEAL}/messages`)) };
    const msgRes = await app.inject({ method: "GET", url: `/deals/${DEAL}/messages`, headers: msgHeaders });
    assert.equal(msgRes.statusCode, 403, "unassigned messages");

    // Assigned reviewer: allowed.
    const { cookie: revACookie } = await signIn(app, revA);
    const okCaseHeaders = {
      cookie: revACookie,
      ...(await signedHeaders(revA, "GET", `/review/cases/${DEAL}`)),
    };
    const okCase = await app.inject({ method: "GET", url: `/review/cases/${DEAL}`, headers: okCaseHeaders });
    assert.equal(okCase.statusCode, 200, JSON.stringify(okCase.json()));

    const okEvHeaders = { cookie: revACookie, ...(await signedHeaders(revA, "GET", `/deals/${DEAL}/evidence`)) };
    const okEv = await app.inject({ method: "GET", url: `/deals/${DEAL}/evidence`, headers: okEvHeaders });
    assert.equal(okEv.statusCode, 200, JSON.stringify(okEv.json()));

    const okMsgHeaders = { cookie: revACookie, ...(await signedHeaders(revA, "GET", `/deals/${DEAL}/messages`)) };
    const okMsg = await app.inject({ method: "GET", url: `/deals/${DEAL}/messages`, headers: okMsgHeaders });
    assert.equal(okMsg.statusCode, 200, JSON.stringify(okMsg.json()));
    await app.close();
  });

  it("grants NO reviewer access to a deal with no review case (403)", async () => {
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_nocase", dealId: DEAL2 });
    const { cookie } = await signIn(app, revC);
    const headers = { cookie, ...(await signedHeaders(revC, "GET", `/deals/${DEAL2}/evidence`)) };
    const res = await app.inject({ method: "GET", url: `/deals/${DEAL2}/evidence`, headers });
    assert.equal(res.statusCode, 403);
    await app.close();
  });
});

describe("assignment authority", () => {
  it("rejects a reviewer assigning itself (self-assignment attack)", async () => {
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_self", dealId: DEAL });
    // revA is a reviewer but NOT the arbitration operator.
    const res = await authedCall(app, revA, "POST", `/review/cases/${DEAL}/assign`, {
      primary: [revA.address],
      fallback: [revB.address],
    });
    assert.equal(res.statusCode, 403, JSON.stringify(res.json()));
    await app.close();
  });

  it("rejects a non-arbitration operator (relay) and requires an attestation without a chain panel", async () => {
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_arb", dealId: DEAL });

    const wrongOperator = await authedCall(app, relay, "POST", `/review/cases/${DEAL}/assign`, {
      primary: [revA.address],
      fallback: [revB.address],
      attestation: "vetted",
    });
    assert.equal(wrongOperator.statusCode, 403);

    const noAttestation = await authedCall(app, arb, "POST", `/review/cases/${DEAL}/assign`, {
      primary: [revA.address],
      fallback: [revB.address],
    });
    assert.equal(noAttestation.statusCode, 403, JSON.stringify(noAttestation.json()));
    await app.close();
  });

  it("lets the arbitration operator assign (with attestation), records an audit trail, and rejects participant conflicts", async () => {
    // arb must also satisfy the review handler's reviewer check.
    process.env["REVIEWER_WALLETS"] = [revA, revB, revC, revD, arb].map((a) => a.address).join(",");
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_ok", dealId: DEAL });

    const conflict = await authedCall(app, arb, "POST", `/review/cases/${DEAL}/assign`, {
      primary: [buyer.address],
      fallback: [revB.address],
      attestation: "manual",
    });
    assert.equal(conflict.statusCode, 403, "participant conflict");

    const overlap = await authedCall(app, arb, "POST", `/review/cases/${DEAL}/assign`, {
      primary: [revA.address],
      fallback: [revA.address],
      attestation: "manual",
    });
    assert.equal(overlap.statusCode, 400, "primary/fallback disjointness");

    const ok = await authedCall(app, arb, "POST", `/review/cases/${DEAL}/assign`, {
      primary: [revA.address, revB.address, arb.address],
      fallback: [revC.address, revD.address],
      attestation: "operator vetted off-chain panel",
    });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.json()));

    const audit = await listAssignmentAudit(DEAL);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "assign");
    assert.equal(audit[0].verified, false);
    assert.equal(audit[0].actor, arb.address);

    // A plain reviewer still cannot recuse/assign.
    const reviewerRecuse = await authedCall(app, revA, "POST", `/review/cases/${DEAL}/recuse`, {
      reviewer: revA.address,
      reason: "conflict",
    });
    assert.equal(reviewerRecuse.statusCode, 403);
    process.env["REVIEWER_WALLETS"] = [revA, revB, revC, revD].map((a) => a.address).join(",");
    await app.close();
  });
});

describe("chain-first reads never leak draft contents", () => {
  it("denies anonymous deal status when the chain read fails and returns no terms", async () => {
    const failingReader = { async getDeal() { throw new Error("rpc down"); } };
    const { app, store } = makeApp({ reader: failingReader });
    await seedDraft(store, { id: "d_status", dealId: DEAL });
    const res = await app.inject({ method: "GET", url: `/deals/${DEAL}/status` });
    assert.equal(res.statusCode, 401);
    assert.ok(!("terms" in res.json()), "must not leak draft terms");

    const { cookie } = await signIn(app, buyer);
    const partyRes = await app.inject({ method: "GET", url: `/deals/${DEAL}/status`, headers: { cookie } });
    assert.equal(partyRes.statusCode, 200, JSON.stringify(partyRes.json()));
    await app.close();
  });

  it("denies anonymous recovery (which carries canonical terms)", async () => {
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_recovery", dealId: DEAL });
    const res = await app.inject({ method: "GET", url: `/deals/${DEAL}/recovery` });
    assert.equal(res.statusCode, 401);
    assert.ok(!("terms" in res.json()));
    await app.close();
  });
});

describe("relay submit binding", () => {
  it("requires a party of a known deal and allows operators", async () => {
    const { app, store } = makeApp();
    await seedDraft(store, { id: "d_relay", dealId: DEAL });
    const payload = { idempotencyKey: "rk-1", action: "openDispute", params: { dealId: DEAL } };

    const anon = await app.inject({ method: "POST", url: "/relay/submit", payload });
    assert.equal(anon.statusCode, 401);

    const outsiderRes = await authedCall(app, outsider, "POST", "/relay/submit", payload);
    assert.equal(outsiderRes.statusCode, 403);

    const buyerRes = await authedCall(app, buyer, "POST", "/relay/submit", {
      idempotencyKey: "rk-2",
      action: "openDispute",
      params: { dealId: DEAL },
    });
    assert.equal(buyerRes.statusCode, 200, JSON.stringify(buyerRes.json()));

    const relayRes = await authedCall(app, relay, "POST", "/relay/submit", {
      idempotencyKey: "rk-3",
      action: "openDispute",
      params: { dealId: DEAL },
    });
    assert.equal(relayRes.statusCode, 200, JSON.stringify(relayRes.json()));
    await app.close();
  });
});
