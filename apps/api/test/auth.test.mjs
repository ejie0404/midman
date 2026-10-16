// Wallet-auth + permissions end-to-end tests (audit finding #5).
//
// Builds a fresh Fastify app per test: real routes (registerRoutes) + our
// guards (registerAuthGuards) + the auth endpoints (registerAuthRoutes),
// using REAL viem keys and the documented login message format.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryStore } from "../dist/db.js";
import { registerRoutes } from "../dist/routes.js";
import { registerAuthGuards, registerAuthRoutes } from "../dist/auth/middleware.js";
import { issueLoginChallenge, __resetChallengesForTests } from "../dist/auth/challenge.js";
import {
  signSessionToken,
  sessionSecret,
  __resetSessionsForTests,
  SESSION_IDLE_SECONDS,
  MIN_SESSION_SECRET_LENGTH,
} from "../dist/auth/session.js";
import { __resetInvitationsForTests } from "../dist/auth/permissions.js";

const BUYER_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const SELLER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const OUTSIDER_KEY = "0x3333333333333333333333333333333333333333333333333333333333333333";
const RELAY_KEY = "0x4444444444444444444444444444444444444444444444444444444444444444";
const GOVERNANCE_KEY = "0x5555555555555555555555555555555555555555555555555555555555555555";
const ADMISSION_KEY = "0x6666666666666666666666666666666666666666666666666666666666666666";

const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);
const outsider = privateKeyToAccount(OUTSIDER_KEY);
const relayOperator = privateKeyToAccount(RELAY_KEY);
const governance = privateKeyToAccount(GOVERNANCE_KEY);
const admissionOperator = privateKeyToAccount(ADMISSION_KEY);

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SESSION_SECRET = "test-session-secret-0123456789";

process.env["SESSION_SECRET"] = SESSION_SECRET;
process.env["OPERATOR_RELAY_WALLETS"] = relayOperator.address;
process.env["OPERATOR_GOVERNANCE_WALLETS"] = governance.address;
process.env["OPERATOR_ADMISSION_WALLETS"] = admissionOperator.address;

const NOW = () => Math.floor(Date.now() / 1_000);

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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

function makeApp({ indexer = null } = {}) {
  const store = new MemoryStore();
  const deps = { store, reader: null, indexer, hub: HUB_ADDR, usdc: USDC, chainId: 8453, rpcConfigured: false };
  const app = Fastify({ logger: false });
  registerAuthGuards(app, deps);
  registerRoutes(app, deps);
  registerAuthRoutes(app, deps);
  return { app, store, deps };
}

async function issueChallenge(app, account) {
  const res = await app.inject({ method: "POST", url: "/auth/challenge", payload: { wallet: account.address } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  return res.json();
}

function cookieOf(res) {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value, "expected a Set-Cookie header");
  return value.split(";")[0];
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
  const bodyHash = sha256hex(bodyBytes);
  const expiry = String(NOW() + 300);
  const message = `${method.toUpperCase()}\n${url}\n${bodyHash}\n${expiry}`;
  const signature = await account.signMessage({ message });
  return { "x-wallet-address": account.address, "x-wallet-expiry": expiry, "x-wallet-signature": signature };
}

async function createDraft(app) {
  const res = await app.inject({ method: "POST", url: "/drafts", payload: draftBody() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  return res.json();
}

beforeEach(() => {
  __resetChallengesForTests();
  __resetSessionsForTests();
  __resetInvitationsForTests();
});

describe("login challenge -> session", () => {
  it("issues a challenge with the frozen purpose and signs in a session cookie", async () => {
    const { app } = makeApp();
    const account = buyer;
    const issued = await issueChallenge(app, account);
    assert.equal(issued.challenge.purpose, "Midman sign-in only, no funds authorized");
    assert.equal(issued.challenge.wallet, account.address);
    assert.equal(issued.challenge.chainId, 8453);
    assert.match(issued.challenge.nonce, /^0x[0-9a-fA-F]{64}$/);
    assert.ok(issued.message.includes("Midman sign-in only, no funds authorized"));
    assert.ok(issued.message.includes(`${account.address}`));

    const signature = await account.signMessage({ message: issued.message });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: account.address, nonce: issued.challenge.nonce, signature },
    });
    assert.equal(verify.statusCode, 200);
    const cookie = cookieOf(verify);
    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().authenticated, true);
    assert.equal(session.json().wallet, account.address);
  });

  it("sets httpOnly + Secure + SameSite=Lax on the session cookie", async () => {
    const { app } = makeApp();
    const issued = await issueChallenge(app, buyer);
    const signature = await buyer.signMessage({ message: issued.message });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: buyer.address, nonce: issued.challenge.nonce, signature },
    });
    const raw = verify.headers["set-cookie"];
    const setCookie = Array.isArray(raw) ? raw[0] : raw;
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("Secure"));
    assert.ok(setCookie.includes("SameSite=Lax"));
  });

  it("rejects a forged/unknown challenge nonce", async () => {
    const { app } = makeApp();
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const signature = await buyer.signMessage({ message: "not a real challenge" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: buyer.address, nonce, signature },
    });
    assert.equal(res.statusCode, 401);
  });

  it("rejects an expired challenge", async () => {
    const { app } = makeApp();
    const crafted = issueLoginChallenge({
      domain: "midman.local",
      chainId: 8453,
      wallet: buyer.address,
      ttlSeconds: 10,
      nowSeconds: NOW() - 100,
    });
    const signature = await buyer.signMessage({ message: crafted.message });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: buyer.address, nonce: crafted.challenge.nonce, signature },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /expired/i);
  });

  it("rejects reusing a challenged nonce a second time", async () => {
    const { app } = makeApp();
    const issued = await issueChallenge(app, buyer);
    const signature = await buyer.signMessage({ message: issued.message });
    const payload = { wallet: buyer.address, nonce: issued.challenge.nonce, signature };
    assert.equal((await app.inject({ method: "POST", url: "/auth/verify", payload })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/auth/verify", payload })).statusCode, 401);
  });

  it("rejects a domain mismatch on verify", async () => {
    const { app } = makeApp();
    const issued = await issueChallenge(app, buyer);
    const signature = await buyer.signMessage({ message: issued.message });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: buyer.address, nonce: issued.challenge.nonce, signature, domain: "evil.example" },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /domain/i);
  });

  it("rejects a chain mismatch on verify", async () => {
    const { app } = makeApp();
    const issued = await issueChallenge(app, buyer);
    const signature = await buyer.signMessage({ message: issued.message });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: buyer.address, nonce: issued.challenge.nonce, signature, chainId: 1 },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /chain/i);
  });

  it("rejects an unknown challenge domain even with a valid signature", async () => {
    const { app } = makeApp();
    const crafted = issueLoginChallenge({ domain: "evil.example", chainId: 8453, wallet: buyer.address });
    const signature = await buyer.signMessage({ message: crafted.message });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { wallet: buyer.address, nonce: crafted.challenge.nonce, signature },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /domain/i);
  });

  it("rejects a session token forged with the wrong secret", async () => {
    const { app } = makeApp();
    const now = NOW();
    const forged = signSessionToken(
      { wallet: buyer.address, issuedAt: now, expiresAt: now + 3600, lastSeen: now, nonce: "forged" },
      "attacker-secret-value-1234567890",
    );
    const res = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: `midman_session=${forged}` } });
    assert.equal(res.json().authenticated, false);
  });

  it("rejects an absolutely-expired session token", async () => {
    const { app } = makeApp();
    const now = NOW();
    const expired = signSessionToken({
      wallet: buyer.address,
      issuedAt: now - 100_000,
      expiresAt: now - 10,
      lastSeen: now - 10,
      nonce: "expired",
    });
    const res = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: `midman_session=${expired}` } });
    assert.equal(res.json().authenticated, false);
  });

  it("rejects an idle-expired session token", async () => {
    const { app } = makeApp();
    const now = NOW();
    const idle = signSessionToken({
      wallet: buyer.address,
      issuedAt: now - 100_000,
      expiresAt: now + 100_000,
      lastSeen: now - (SESSION_IDLE_SECONDS + 60),
      nonce: "idle",
    });
    const res = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: `midman_session=${idle}` } });
    assert.equal(res.json().authenticated, false);
  });

  it("logout revokes the session so the old cookie stops working", async () => {
    const { app } = makeApp();
    const { cookie } = await signIn(app, buyer);
    assert.equal((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } })).statusCode, 200);
    const res = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    assert.equal(res.json().authenticated, false);
  });
});

describe("session secret policy", () => {
  it("throws in production when SESSION_SECRET is missing", () => {
    assert.throws(() => sessionSecret({ NODE_ENV: "production" }), /SESSION_SECRET/);
  });

  it("falls back to an insecure dev secret outside production", () => {
    const secret = sessionSecret({});
    assert.ok(secret.length >= MIN_SESSION_SECRET_LENGTH);
  });
});

describe("login signature is sign-in only, never financial/request auth", () => {
  it("a login signature cannot satisfy an operator signed-request route", async () => {
    const stubIndexer = { async tick() { return { scannedTo: 0, added: 0, orphaned: 0, reorg: false }; } };
    const { app } = makeApp({ indexer: stubIndexer });
    const { cookie, signature: loginSignature } = await signIn(app, relayOperator);
    const expiry = String(NOW() + 300);
    const res = await app.inject({
      method: "POST",
      url: "/indexer/tick",
      headers: {
        cookie,
        "x-wallet-address": relayOperator.address,
        "x-wallet-expiry": expiry,
        "x-wallet-signature": loginSignature,
      },
    });
    assert.equal(res.statusCode, 401);
  });

  it("a login signature cannot satisfy an EIP-712 acceptance signature", async () => {
    const { app } = makeApp();
    const { id, terms } = await createDraft(app);
    await app.inject({ method: "POST", url: `/drafts/${id}/invite` });
    const { cookie, signature: loginSignature } = await signIn(app, seller);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/signatures`,
      headers: { cookie },
      payload: { role: "seller", signature: loginSignature },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(terms.buyer);
  });
});

describe("draft accept requires the invited party + a valid invitation token", () => {
  it("rejects accept without an invitation token (403)", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    await app.inject({ method: "POST", url: `/drafts/${id}/invite` });
    const { cookie } = await signIn(app, seller);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      headers: { cookie },
      payload: { counterpartyAddress: seller.address },
    });
    assert.equal(res.statusCode, 403);
  });

  it("rejects accept with a wrong token (403)", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    await app.inject({ method: "POST", url: `/drafts/${id}/invite` });
    const { cookie } = await signIn(app, seller);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      headers: { cookie },
      payload: { counterpartyAddress: seller.address, invitationToken: randomBytes(32).toString("base64url") },
    });
    assert.equal(res.statusCode, 403);
  });

  it("accepts with the invited wallet + valid token (200)", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    const invite = (await app.inject({ method: "POST", url: `/drafts/${id}/invite` })).json();
    const { cookie } = await signIn(app, seller);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      headers: { cookie },
      payload: { counterpartyAddress: seller.address, invitationToken: invite.invitationToken },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(res.json().counterpartyAddress, seller.address);
  });

  it("rejects accept by a wallet that is not the invited counterparty (403)", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    const invite = (await app.inject({ method: "POST", url: `/drafts/${id}/invite` })).json();
    const { cookie } = await signIn(app, outsider);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/accept`,
      headers: { cookie },
      payload: { counterpartyAddress: outsider.address, invitationToken: invite.invitationToken },
    });
    assert.equal(res.statusCode, 403);
  });

  it("rejects signing by a non-party (403)", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    const { cookie } = await signIn(app, outsider);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${id}/signatures`,
      headers: { cookie },
      payload: { role: "seller", signature: "0x00" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("rejects anonymous draft reads and allows the creator (terms)", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    assert.equal((await app.inject({ method: "GET", url: `/drafts/${id}/terms` })).statusCode, 401);

    const { cookie } = await signIn(app, buyer);
    const res = await app.inject({ method: "GET", url: `/drafts/${id}/terms`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
  });

  it("rejects a non-party summary/download and allows a party", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    const { cookie: outsiderCookie } = await signIn(app, outsider);
    assert.equal(
      (await app.inject({ method: "GET", url: `/drafts/${id}/summary`, headers: { cookie: outsiderCookie } })).statusCode,
      403,
    );
    const { cookie: sellerCookie } = await signIn(app, seller);
    assert.equal(
      (await app.inject({ method: "GET", url: `/drafts/${id}/summary`, headers: { cookie: sellerCookie } })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/drafts/${id}/download`, headers: { cookie: sellerCookie } })).statusCode,
      200,
    );
  });
});

describe("operator routes require session AND signed request", () => {
  const stubIndexer = { async tick() { return { scannedTo: 0, added: 0, orphaned: 0, reorg: false }; } };

  it("indexer tick is 401 for an anonymous caller", async () => {
    const { app } = makeApp({ indexer: stubIndexer });
    assert.equal((await app.inject({ method: "POST", url: "/indexer/tick" })).statusCode, 401);
  });

  it("indexer tick is 401 for a session without a signed request", async () => {
    const { app } = makeApp({ indexer: stubIndexer });
    const { cookie } = await signIn(app, relayOperator);
    assert.equal((await app.inject({ method: "POST", url: "/indexer/tick", headers: { cookie } })).statusCode, 401);
  });

  it("indexer tick is 403 for a signed-in non-operator", async () => {
    const { app } = makeApp({ indexer: stubIndexer });
    const { cookie } = await signIn(app, outsider);
    const headers = { cookie, ...(await signedHeaders(outsider, "POST", "/indexer/tick")) };
    assert.equal((await app.inject({ method: "POST", url: "/indexer/tick", headers })).statusCode, 403);
  });

  it("indexer tick is 200 for a relay operator with session + signed request", async () => {
    const { app } = makeApp({ indexer: stubIndexer });
    const { cookie } = await signIn(app, relayOperator);
    const headers = { cookie, ...(await signedHeaders(relayOperator, "POST", "/indexer/tick")) };
    const res = await app.inject({ method: "POST", url: "/indexer/tick", headers });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  });

  it("indexer tick is 200 for a governance operator too", async () => {
    const { app } = makeApp({ indexer: stubIndexer });
    const { cookie } = await signIn(app, governance);
    const headers = { cookie, ...(await signedHeaders(governance, "POST", "/indexer/tick")) };
    assert.equal((await app.inject({ method: "POST", url: "/indexer/tick", headers })).statusCode, 200);
  });

  it("admission is 200 only for the admission operator with session + signed request", async () => {
    const { app } = makeApp();
    const { id } = await createDraft(app);
    // Canonical admission struct (exact @midman/api-client shape).
    const admissionBody = {
      admission: {
        minPolicyId: `0x${"aa".repeat(32)}`,
        admissionNonce: `0x${"bb".repeat(32)}`,
        expiresAt: "1999999999",
        signature: `0x${"cc".repeat(65)}`,
      },
    };

    const { cookie: outsiderCookie } = await signIn(app, outsider);
    const outsiderHeaders = {
      cookie: outsiderCookie,
      "content-type": "application/json",
      ...(await signedHeaders(outsider, "POST", `/drafts/${id}/admission`, Buffer.from(JSON.stringify(admissionBody)))),
    };
    assert.equal(
      (await app.inject({ method: "POST", url: `/drafts/${id}/admission`, headers: outsiderHeaders, payload: admissionBody }))
        .statusCode,
      403,
    );

    const { cookie } = await signIn(app, admissionOperator);
    const headers = {
      cookie,
      "content-type": "application/json",
      ...(await signedHeaders(admissionOperator, "POST", `/drafts/${id}/admission`, Buffer.from(JSON.stringify(admissionBody)))),
    };
    const res = await app.inject({ method: "POST", url: `/drafts/${id}/admission`, headers, payload: admissionBody });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  });
});

describe("relay status redaction", () => {
  async function submitRelay(app) {
    // Fail-closed relay auth: submit with the relay operator session + signed
    // request (the legacy unauthenticated path is gone).
    const { cookie } = await signIn(app, relayOperator);
    const payload = { idempotencyKey: "k1", action: "openDispute", params: { dealId: "0x01", secret: "s3cr3t" } };
    const res = await app.inject({
      method: "POST",
      url: "/relay/submit",
      headers: {
        cookie,
        "content-type": "application/json",
        ...(await signedHeaders(relayOperator, "POST", "/relay/submit", Buffer.from(JSON.stringify(payload)))),
      },
      payload,
    });
    assert.equal(res.statusCode, 200);
  }

  it("redacts relay params for anonymous callers", async () => {
    const { app } = makeApp();
    await submitRelay(app);
    const res = await app.inject({ method: "GET", url: "/relay/k1" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.redacted, true);
    assert.equal(body.status, "queued");
    assert.ok(!("params" in body));
  });

  it("shows relay params to an operator with session + signed request", async () => {
    const { app } = makeApp();
    await submitRelay(app);
    const { cookie } = await signIn(app, relayOperator);
    const headers = { cookie, ...(await signedHeaders(relayOperator, "GET", "/relay/k1")) };
    const res = await app.inject({ method: "GET", url: "/relay/k1", headers });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().params, { dealId: "0x01", secret: "s3cr3t" });
  });
});
