// GET /me/deals: the session wallet's own deals, nobody else's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryStore } from "../dist/db.js";
import { registerRoutes } from "../dist/routes.js";
import { registerAuthGuards, registerAuthRoutes } from "../dist/auth/middleware.js";
import { registerMeRoutes } from "../dist/me.js";

process.env["SESSION_SECRET"] ??= "test-session-secret-0123456789";

const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"22".repeat(32)}`);
const outsider = privateKeyToAccount(`0x${"33".repeat(32)}`);
const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEAL_ID = `0x${"ab".repeat(32)}`;

function draftBody(counterparty) {
  return {
    terms: {
      buyer: buyer.address,
      seller: counterparty.address,
      principalUnits: "100000000",
      buyerFeeBps: 10000,
      deliverySeconds: 3600,
      inspectionSeconds: 43200,
      category: "GAME_ITEM",
      agreementHash: `0x${"00".repeat(31)}01`,
      policyIds: { fee: "0xfee" },
      platformFeeRecipient: buyer.address,
      arbitrationCostRecipient: seller.address,
      hub: HUB,
      token: USDC,
      chainId: 8453,
    },
  };
}

function makeApp(reader = null) {
  const store = new MemoryStore();
  const deps = { store, reader, indexer: null, hub: HUB, usdc: USDC, chainId: 8453, rpcConfigured: reader !== null };
  const app = Fastify({ logger: false });
  registerAuthGuards(app, deps);
  registerRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerMeRoutes(app, deps);
  return { app, store };
}

async function signIn(app, account) {
  const issued = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { wallet: account.address } })).json();
  const signature = await account.signMessage({ message: issued.message });
  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { wallet: account.address, nonce: issued.challenge.nonce, signature },
  });
  assert.equal(verify.statusCode, 200);
  const raw = verify.headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : raw).split(";")[0];
}

describe("GET /me/deals", () => {
  it("requires a session", async () => {
    const { app } = makeApp();
    assert.equal((await app.inject({ method: "GET", url: "/me/deals" })).statusCode, 401);
  });

  it("lists drafts where the wallet is buyer or seller, with its role and counterparty", async () => {
    const { app } = makeApp();
    const buyerCookie = await signIn(app, buyer);
    const create = (counterparty) =>
      app.inject({ method: "POST", url: "/drafts", headers: { cookie: buyerCookie }, payload: draftBody(counterparty) });
    const withSeller = (await create(seller)).json();
    const withOutsider = (await create(outsider)).json();

    const mine = (await app.inject({ method: "GET", url: "/me/deals", headers: { cookie: buyerCookie } })).json();
    assert.deepEqual(
      mine.deals.map((d) => d.draftId),
      [withOutsider.id, withSeller.id],
      "newest first",
    );
    assert.equal(mine.deals[0].role, "buyer");
    assert.equal(mine.deals[1].counterparty, seller.address);
    assert.equal(mine.deals[1].principalUnits, "100000000");

    const sellerCookie = await signIn(app, seller);
    const theirs = (await app.inject({ method: "GET", url: "/me/deals", headers: { cookie: sellerCookie } })).json();
    assert.deepEqual(theirs.deals.map((d) => d.draftId), [withSeller.id], "only deals the seller is party to");
    assert.equal(theirs.deals[0].role, "seller");
    assert.equal(theirs.deals[0].counterparty, buyer.address);
  });

  it("adds the chain phase for funded deals and tolerates read failures", async () => {
    const reader = {
      getDeal: async (_hub, dealId) => {
        if (dealId === DEAL_ID) return { funded: true, phase: 1 };
        throw new Error("rpc down");
      },
    };
    const { app, store } = makeApp(reader);
    const cookie = await signIn(app, buyer);
    const created = (await app.inject({ method: "POST", url: "/drafts", headers: { cookie }, payload: draftBody(seller) })).json();
    await app.inject({ method: "POST", url: "/drafts", headers: { cookie }, payload: draftBody(outsider) });
    // Point the first draft at a deal id the fake chain reports as funded.
    const draft = await store.getDraft(created.id);
    await store.createDraft({ ...draft, dealId: DEAL_ID });

    const { deals } = (await app.inject({ method: "GET", url: "/me/deals", headers: { cookie } })).json();
    const funded = deals.find((d) => d.draftId === created.id);
    assert.equal(funded.chainPhase, "DELIVERED");
    assert.ok(deals.some((d) => d.chainPhase === null), "a failed chain read degrades to null");
  });
});
