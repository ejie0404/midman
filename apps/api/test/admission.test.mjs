// Automated funding admission: risk rules, idempotency and a signature the
// hub's ADMISSION_TYPEHASH check accepts (recovers to the admission signer).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

import { MemoryStore } from "../dist/db.js";
import { registerRoutes } from "../dist/routes.js";
import { buildCanonicalTerms } from "../dist/terms.js";
import { buildFullTerms } from "../dist/fullTerms.js";
import { storeDealSignature } from "../dist/funding.js";
import { dealTermsTypedData, fundingAdmissionTypedData } from "../dist/chainActions.js";
import { requestAdmission, admissionRulesFromEnv } from "../dist/admission/service.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PLATFORM = "0x000000000000000000000000000000000000fee1";
const ARBITRATION = "0x000000000000000000000000000000000000a4b1";
const NOW = 1_700_000_000;
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const POLICY_IDS = {
  fee: h(1),
  category: h(2),
  readiness: h(3),
  evidence: h(4),
  bond: h(5),
  arbitration: h(6),
  outage: h(7),
  catastrophic: h(8),
};

const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"22".repeat(32)}`);
const signer = privateKeyToAccount(`0x${"44".repeat(32)}`);

const ENV = {
  HUB_ADDRESS: HUB,
  USDC_ADDRESS: USDC,
  BASE_CHAIN_ID: "8453",
  MIDMAN_POLICY_IDS: JSON.stringify(POLICY_IDS),
  PLATFORM_FEE_RECIPIENT: PLATFORM,
  ARBITRATION_COST_RECIPIENT: ARBITRATION,
};

let counter = 0;

async function signedDraft(store, overrides = {}, { sign = true } = {}) {
  const terms = buildCanonicalTerms(
    {
      buyer: buyer.address,
      seller: seller.address,
      principalUnits: "100000000",
      buyerFeeBps: 10000,
      deliverySeconds: 3600,
      inspectionSeconds: 43200,
      category: "GAME_ITEM",
      agreementHash: h(0xabc),
      policyIds: { ...POLICY_IDS },
      platformFeeRecipient: PLATFORM,
      arbitrationCostRecipient: ARBITRATION,
      hub: HUB,
      token: USDC,
      chainId: 8453,
      ...overrides,
    },
    NOW,
  );
  const id = `draft_test_${++counter}`;
  await store.createDraft({
    id,
    dealId: terms.dealId,
    creatorWallet: buyer.address,
    counterpartyHint: seller.address,
    counterpartyAddress: seller.address,
    terms,
    signatures: {},
    admission: null,
    revocationNote: null,
    status: "draft",
  });
  if (sign) {
    const { fullTerms } = buildFullTerms(terms, HUB);
    const typed = dealTermsTypedData(8453, HUB, fullTerms);
    for (const [role, account] of [
      ["buyer", buyer],
      ["seller", seller],
    ]) {
      await storeDealSignature(store, id, role, await account.signTypedData(typed));
    }
  }
  return { id, terms };
}

const run = (store, id, env = ENV, reader = null) =>
  requestAdmission({ store, reader, hub: HUB }, id, { env, signer, nowSeconds: NOW, rules: admissionRulesFromEnv(env) });

describe("automated admission", () => {
  it("grants a signature the hub accepts: admission signer over the agreement digest", async () => {
    const store = new MemoryStore();
    const { id, terms } = await signedDraft(store);
    const decision = await run(store, id);
    assert.equal(decision.ok, true, decision.reason);
    const { admission } = decision;
    assert.equal(admission.minPolicyId, POLICY_IDS.category, "bound to the signed category policy");
    assert.equal(admission.expiresAt, String(NOW + 86_400));

    const { agreementDigest } = buildFullTerms(terms, HUB);
    const typed = fundingAdmissionTypedData({
      chainId: 8453,
      hub: HUB,
      agreementDigest,
      minPolicyId: admission.minPolicyId,
      admissionNonce: admission.admissionNonce,
      expiresAt: admission.expiresAt,
      expectedUnfunded: true,
    });
    const recovered = await recoverTypedDataAddress({ ...typed, signature: admission.signature });
    assert.equal(recovered, signer.address);

    const stored = await store.getDraft(id);
    assert.equal(stored.status, "admitted");
    assert.equal(stored.admission.signature, admission.signature);
  });

  it("is idempotent while the grant is unexpired", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store);
    const first = await run(store, id);
    const second = await run(store, id);
    assert.equal(second.reused, true);
    assert.equal(second.admission.signature, first.admission.signature);
  });

  it("refuses until both parties signed the full terms", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store, {}, { sign: false });
    const decision = await run(store, id);
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 409);
  });

  it("refuses a draft whose fee recipient differs from the deployment", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store, { platformFeeRecipient: seller.address });
    const decision = await run(store, id);
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /platformFeeRecipient/);
  });

  it("enforces the kill switch, denylist, per-deal cap and pair cap", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store);
    assert.equal((await run(store, id, { ...ENV, ADMISSION_PAUSED: "1" })).status, 503);
    assert.equal((await run(store, id, { ...ENV, ADMISSION_DENYLIST: seller.address })).status, 403);
    const capped = await run(store, id, { ...ENV, ADMISSION_MAX_PRINCIPAL_UNITS: "50000000" });
    assert.match(capped.reason, /per-deal limit/);

    // Pair cap: first deal (100.5 USDC funded) fits a 150 USDC window, the second does not.
    const env = { ...ENV, AGGREGATE_PAIR_CAP_UNITS_PER_24H: "150000000" };
    assert.equal((await run(store, id, env)).ok, true);
    const { id: second } = await signedDraft(store);
    const split = await run(store, second, env);
    assert.equal(split.ok, false);
    assert.match(split.reason, /24h volume limit/);
  });

  it("enforces the exposure cap and fails closed when liabilities are unreadable", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store);
    const env = { ...ENV, ADMISSION_MAX_EXPOSURE_UNITS: "1000000000" };
    const full = { getLiabilities: async () => 950_000_000n };
    assert.match((await run(store, id, env, full)).reason, /exposure limit/);
    const broken = { getLiabilities: async () => Promise.reject(new Error("rpc down")) };
    assert.equal((await run(store, id, env, broken)).status, 503);
    const roomy = { getLiabilities: async () => 0n };
    assert.equal((await run(store, id, env, roomy)).ok, true);
  });

  it("reports 503 when no admission key is configured", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store);
    const decision = await requestAdmission({ store, reader: null, hub: HUB }, id, { env: ENV, signer: null });
    assert.equal(decision.status, 503);
  });

  it("is reachable over HTTP at POST /drafts/:id/admission/request", async () => {
    const store = new MemoryStore();
    const { id } = await signedDraft(store);
    const app = Fastify({ logger: false });
    registerRoutes(app, { store, reader: null, indexer: null, hub: HUB, usdc: USDC, chainId: 8453, rpcConfigured: false });
    await app.ready();
    // No ADMISSION_SIGNER_KEY in the test process env -> 503, never a silent grant.
    const res = await app.inject({ method: "POST", url: `/drafts/${id}/admission/request` });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});
