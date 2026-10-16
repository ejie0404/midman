// Funding-flow tests (audit finding #6): full 32-field DealTerms typed data,
// fund() calldata encoding, payment-nonce parity, deal-signature verification
// and idempotent relay-fund enqueue. Real viem keys + MemoryStore; the
// contract's field order is asserted against specs/contract-spec.json.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, encodeAbiParameters, keccak256, recoverTypedDataAddress } from "viem";
import { HUB_ABI, TYPES as EIP712_TYPES } from "@midman/chain";
import { validateFundingBundle, validateRelayFundPayload } from "@midman/api-client";

import { MemoryStore } from "../dist/db.js";
import { registerRoutes } from "../dist/routes.js";
import { buildCanonicalTerms } from "../dist/terms.js";
import { buildFullTerms } from "../dist/fullTerms.js";
import { buildFundingBundle, storeDealSignature, ALLOWANCE_WINDOW_SECONDS } from "../dist/funding.js";
import {
  dealTermsTypedData,
  fundWithAllowanceTypedData,
  fundingAdmissionTypedData,
  readinessConsentTypedData,
  buildFundCalldata,
  buildApproveCalldata,
  paymentNonce,
  ERC20_APPROVE_ABI,
} from "../dist/chainActions.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453;
const NOW = 1_700_000_000;

const BUYER_KEY = `0x${"11".repeat(32)}`;
const SELLER_KEY = `0x${"22".repeat(32)}`;
const THIRD_KEY = `0x${"33".repeat(32)}`;
const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);
const outsider = privateKeyToAccount(THIRD_KEY);

const spec = JSON.parse(readFileSync(new URL("../../../specs/contract-spec.json", import.meta.url), "utf8"));
const SPEC_TERMS = spec.dealTermsTypes;

function bytes32(seed) {
  return `0x${Buffer.from(seed).toString("hex").padStart(64, "0").slice(0, 64)}`;
}

const BASE_POLICIES = {
  fee: bytes32("fee-policy"),
  category: bytes32("category-policy"),
  evidence: bytes32("evidence-policy"),
  bond: bytes32("bond-policy"),
  arbitration: bytes32("arbitration-policy"),
  outage: bytes32("outage-policy"),
  catastrophic: bytes32("catastrophic-policy"),
};

function makeTerms(overrides = {}) {
  return buildCanonicalTerms(
    {
      buyer: buyer.address,
      seller: seller.address,
      principalUnits: "100000000",
      buyerFeeBps: 10000,
      deliverySeconds: 3600,
      inspectionSeconds: 43200,
      category: "GAME_ITEM",
      agreementHash: bytes32("agreement-hash"),
      policyIds: { ...BASE_POLICIES },
      platformFeeRecipient: buyer.address,
      arbitrationCostRecipient: seller.address,
      hub: HUB,
      token: USDC,
      chainId: CHAIN_ID,
      ...overrides,
    },
    NOW,
  );
}

async function makeDraft(overrides = {}) {
  const store = new MemoryStore();
  const terms = makeTerms(overrides);
  const id = `draft_${terms.dealId.slice(2, 14)}`;
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
  return { store, id, dealId: terms.dealId, terms };
}

function makeDeps(store, reader = null) {
  return { store, reader, indexer: null, hub: HUB, usdc: USDC, chainId: CHAIN_ID, rpcConfigured: false };
}

function makeApp(store, reader = null) {
  const app = Fastify({ logger: false });
  registerRoutes(app, { store, reader, indexer: null, hub: HUB, usdc: USDC, chainId: CHAIN_ID, rpcConfigured: false });
  return app;
}

const toHexSig = (n) => `0x${n.toString(16).padStart(130, "0")}`;
const sigBuyerHex = `0x${"ab".repeat(65)}`;
const sigSellerHex = `0x${"cd".repeat(65)}`;

function relayBody(overrides = {}) {
  return {
    sigBuyer: sigBuyerHex,
    sigSeller: sigSellerHex,
    pay: {
      validAfter: "0",
      validBefore: String(NOW + 3600),
      paymentSalt: bytes32("payment-salt"),
      v: "27",
      r: bytes32("r"),
      s: bytes32("s"),
      use3009: false,
    },
    allowance: {
      paymentSalt: bytes32("payment-salt"),
      nonce: bytes32("allowance-nonce"),
      expiresAt: String(NOW + 3600),
      signature: `0x${"11".repeat(65)}`,
    },
    admission: {
      minPolicyId: bytes32("min-policy"),
      admissionNonce: bytes32("admission-nonce"),
      expiresAt: String(NOW + 86_400),
      signature: `0x${"22".repeat(65)}`,
    },
    readiness: {
      attestedAt: String(NOW),
      nonce: bytes32("readiness-nonce"),
      expiresAt: String(NOW + 7200),
      signature: `0x${"33".repeat(65)}`,
    },
    idempotencyKey: "fund-test-1",
    ...overrides,
  };
}

async function signDealTerms(account, typed) {
  return account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: "DealTerms",
    message: typed.message,
  });
}

describe("funding bundle + chain actions (audit #6)", () => {
  it("1. bundle exposes the full 32-field DealTerms in canonical order", async () => {
    const { store, id, dealId } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    assert.equal(bundle.dealId, dealId);
    assert.deepEqual(Object.keys(bundle.fullTerms), SPEC_TERMS.map((f) => f.name));
    assert.equal(Object.keys(bundle.fullTerms).length, 32);
    for (const field of SPEC_TERMS) {
      assert.equal(typeof bundle.fullTerms[field.name], "string", field.name);
    }
    assert.deepEqual([...bundle.requiredSignatures], ["buyer", "seller"]);
    assert.equal(bundle.fundedUnits, "100500000");
    assert.equal(bundle.prepaidBuyerFeeUnits, "500000");
    assert.equal(bundle.token, USDC);
    assert.equal(bundle.hub, HUB);
    assert.equal(bundle.chainId, CHAIN_ID);
    assert.equal(bundle.draftId, id);
    assert.equal(bundle.principalUnits, "100000000");
    assert.deepEqual(bundle.signatures, { buyer: null, seller: null });
    assert.equal(bundle.allowance.paymentSalt, bundle.allowance.typedData.message.paymentSalt);
    assert.equal(bundle.allowance.nonce, bundle.allowance.typedData.message.nonce);
    assert.equal(bundle.allowance.expiresAt, bundle.allowance.typedData.message.expiresAt.toString());
    assert.deepEqual(bundle.relayActionTemplate, { action: "fund", params: { dealId } });
    assert.match(bundle.admission.note, /FundingAdmission is required/);
    assert.equal(bundle.admission.granted, null);
  });

  it("2. bundle agreementDigest matches buildFullTerms", async () => {
    const { store, id, terms } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const direct = buildFullTerms(terms, HUB);
    assert.equal(bundle.agreementDigest, direct.agreementDigest);
    assert.deepEqual(bundle.fullTerms, direct.fullTerms);
  });

  it("3. dealTermsTypedData keeps canonical field order/types and bigint uints", async () => {
    const { store, id } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const typed = bundle.dealTermsTypedData;
    assert.equal(typed.primaryType, "DealTerms");
    assert.deepEqual(typed.domain, { name: "MidmanEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: HUB });
    assert.deepEqual(typed.types.DealTerms, EIP712_TYPES.DealTerms);
    assert.deepEqual(Object.keys(typed.message), SPEC_TERMS.map((f) => f.name));
    for (const field of EIP712_TYPES.DealTerms) {
      const value = typed.message[field.name];
      if (field.type.startsWith("uint")) assert.equal(typeof value, "bigint", `${field.name} should be bigint`);
      else assert.equal(typeof value, "string", `${field.name} should be string`);
    }
    // domain-independent parity with the struct hash used by the contract.
    assert.equal(typed.message.dealId, bundle.fullTerms.dealId);
  });

  it("4. buildFundCalldata decodes back to the exact struct + sigs/pay/allowance", async () => {
    const { store, id } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const pay = {
      validAfter: 0,
      validBefore: NOW + 60,
      paymentSalt: bytes32("pay-salt"),
      v: 28,
      r: bytes32("pay-r"),
      s: bytes32("pay-s"),
      use3009: false,
    };
    const allowance = {
      paymentSalt: bytes32("pay-salt"),
      nonce: bytes32("allow-nonce"),
      expiresAt: NOW + 100,
      signature: `0x${"44".repeat(20)}`,
    };
    const admission = {
      minPolicyId: bytes32("min-policy"),
      admissionNonce: bytes32("adm-nonce"),
      expiresAt: NOW + 200,
      signature: `0x${"55".repeat(20)}`,
    };
    const readiness = {
      attestedAt: NOW - 10,
      nonce: bytes32("ready-nonce"),
      expiresAt: NOW + 300,
      signature: `0x${"66".repeat(20)}`,
    };
    const data = buildFundCalldata({
      fullTerms: bundle.fullTerms,
      sigBuyer: sigBuyerHex,
      sigSeller: sigSellerHex,
      pay,
      allowance,
      admission,
      readiness,
    });
    assert.match(data, /^0x[0-9a-fA-F]+$/);
    const decoded = decodeFunctionData({ abi: HUB_ABI, data });
    assert.equal(decoded.functionName, "fund");
    assert.equal(decoded.args.length, 7);
    const [terms, sigB, sigS, payOut, allowOut, admOut, readOut] = decoded.args;
    for (const field of SPEC_TERMS) {
      const got = String(terms[field.name]);
      const want = bundle.fullTerms[field.name];
      if (field.type === "address") assert.equal(got.toLowerCase(), want.toLowerCase(), field.name);
      else assert.equal(got, want, field.name);
    }
    assert.equal(sigB, sigBuyerHex);
    assert.equal(sigS, sigSellerHex);
    assert.equal(payOut["paymentSalt"], pay.paymentSalt);
    assert.equal(payOut["validBefore"].toString(), String(pay.validBefore));
    assert.equal(payOut["v"], 28);
    assert.equal(payOut["use3009"], false);
    assert.equal(allowOut["nonce"], allowance.nonce);
    assert.equal(allowOut["expiresAt"].toString(), String(allowance.expiresAt));
    assert.equal(allowOut["signature"], allowance.signature);
    assert.equal(admOut["admissionNonce"], admission.admissionNonce);
    assert.equal(readOut["nonce"], readiness.nonce);
  });

  it("5. paymentNonce equals keccak256(abi.encode(dealId, digest, salt))", async () => {
    const { store, id, dealId } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [dealId, bundle.agreementDigest, bundle.allowance.paymentSalt],
      ),
    );
    assert.equal(paymentNonce(dealId, bundle.agreementDigest, bundle.allowance.paymentSalt), expected);
  });

  it("6. buildApproveCalldata encodes approve(spender, amount) and validates token", async () => {
    const spender = HUB;
    const data = buildApproveCalldata(USDC, spender, "100500000");
    const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data });
    assert.equal(decoded.functionName, "approve");
    assert.equal(decoded.args[0].toLowerCase(), spender.toLowerCase());
    assert.equal(decoded.args[1], 100500000n);
    assert.throws(() => buildApproveCalldata("0xnot-an-address", spender, 1n), /Invalid address/);
  });

  it("7. allowanceTypedData signs and recovers to the buyer with the funded amount", async () => {
    const { store, id } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const typed = bundle.allowance.typedData;
    assert.equal(typed.primaryType, "FundWithAllowance");
    assert.deepEqual(
      typed.types.FundWithAllowance.map((f) => f.name),
      ["dealId", "agreementDigest", "payer", "amount", "paymentSalt", "nonce", "expiresAt"],
    );
    assert.equal(typed.message.payer, buyer.address);
    assert.equal(typed.message.amount, 100500000n);
    assert.equal(typed.message.paymentSalt, bundle.allowance.paymentSalt);
    assert.equal(typed.message.nonce, bundle.allowance.nonce);
    assert.equal(bundle.allowance.expiresAt, String(NOW + ALLOWANCE_WINDOW_SECONDS));
    const signature = await buyer.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: "FundWithAllowance",
      message: typed.message,
    });
    const recovered = await recoverTypedDataAddress({
      domain: typed.domain,
      types: typed.types,
      primaryType: "FundWithAllowance",
      message: typed.message,
      signature,
    });
    assert.equal(recovered.toLowerCase(), buyer.address.toLowerCase());
  });

  it("8. deals longer than 3h are flagged no-readiness with no readiness payload", async () => {
    const { store, id } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    assert.equal(bundle.readiness.required, false);
    assert.equal(bundle.readiness.typedData, null);
    assert.match(bundle.readiness.note, /longer than 3h/);
  });

  it("9. <=3h deals with a readiness policy require a signable ReadinessConsent", async () => {
    const { store, id } = await makeDraft({
      category: "INSTANT_CODE",
      deliverySeconds: 3600,
      inspectionSeconds: 3600,
      policyIds: { ...BASE_POLICIES, readiness: bytes32("readiness-policy") },
    });
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    assert.equal(bundle.readiness.required, true);
    assert.ok(bundle.readiness.typedData);
    const typed = bundle.readiness.typedData;
    assert.equal(typed.primaryType, "ReadinessConsent");
    assert.equal(typed.message.buyer, buyer.address);
    assert.deepEqual(
      typed.types.ReadinessConsent.map((f) => f.name),
      ["dealId", "agreementDigest", "buyer", "attestedAt", "nonce", "expiresAt"],
    );
    const signature = await buyer.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: "ReadinessConsent",
      message: typed.message,
    });
    const recovered = await recoverTypedDataAddress({
      domain: typed.domain,
      types: typed.types,
      primaryType: "ReadinessConsent",
      message: typed.message,
      signature,
    });
    assert.equal(recovered.toLowerCase(), buyer.address.toLowerCase());
  });

  it("10. <=3h deals without a readiness policy return null + explanatory note", async () => {
    const { store, id } = await makeDraft({
      category: "INSTANT_CODE",
      deliverySeconds: 3600,
      inspectionSeconds: 3600,
    });
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    assert.equal(bundle.readiness.required, null);
    assert.equal(bundle.readiness.typedData, null);
    assert.match(bundle.readiness.note, /no readiness policy/i);
  });

  it("11. storeDealSignature verifies and persists buyer + seller signatures", async () => {
    const { store, id } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const buyerSig = await signDealTerms(buyer, bundle.dealTermsTypedData);
    const sellerSig = await signDealTerms(seller, bundle.dealTermsTypedData);
    const buyerResult = await storeDealSignature(store, id, "buyer", buyerSig);
    assert.equal(buyerResult.ok, true);
    assert.equal(buyerResult.signer.toLowerCase(), buyer.address.toLowerCase());
    const sellerResult = await storeDealSignature(store, id, "seller", sellerSig);
    assert.equal(sellerResult.role, "seller");
    const draft = await store.getDraft(id);
    assert.equal(draft.signatures["dealTerms:buyer"], buyerSig);
    assert.equal(draft.signatures["dealTerms:seller"], sellerSig);
  });

  it("12. storeDealSignature rejects an outsider, a tampered signature and unknown drafts", async () => {
    const { store, id } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const outsiderSig = await signDealTerms(outsider, bundle.dealTermsTypedData);
    await assert.rejects(() => storeDealSignature(store, id, "buyer", outsiderSig), /expected party/);
    const buyerSig = await signDealTerms(buyer, bundle.dealTermsTypedData);
    const tampered = `0x${buyerSig[2] === "0" ? "1" : "0"}${buyerSig.slice(3)}`;
    await assert.rejects(() => storeDealSignature(store, id, "buyer", tampered), /expected party|Unrecoverable/);
    await assert.rejects(() => storeDealSignature(store, "missing", "buyer", buyerSig), (error) => error.statusCode === 404);
    await assert.rejects(() => storeDealSignature(store, id, "arbiter", buyerSig), /buyer or seller/);
  });

  it("13. GET /drafts/:id/funding-bundle returns the bundle; 404/403 handled", async () => {
    const { store, id } = await makeDraft();
    const app = makeApp(store);
    await app.ready();
    const ok = await app.inject({ method: "GET", url: `/drafts/${id}/funding-bundle` });
    assert.equal(ok.statusCode, 200);
    const body = ok.json();
    assert.deepEqual(Object.keys(body.fullTerms), SPEC_TERMS.map((f) => f.name));
    assert.equal(body.requiredSignatures.length, 2);
    assert.equal((await app.inject({ method: "GET", url: "/drafts/nope/funding-bundle" })).statusCode, 404);
    await store.updateDraft(id, { status: "revocation-noted" });
    assert.equal((await app.inject({ method: "GET", url: `/drafts/${id}/funding-bundle` })).statusCode, 403);
  });

  it("14. POST /drafts/:id/deal-signatures accepts valid parties and rejects outsiders", async () => {
    const { store, id } = await makeDraft();
    const app = makeApp(store);
    await app.ready();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const buyerSig = await signDealTerms(buyer, bundle.dealTermsTypedData);
    const good = await app.inject({
      method: "POST",
      url: `/drafts/${id}/deal-signatures`,
      payload: { role: "buyer", signature: buyerSig },
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().signer.toLowerCase(), buyer.address.toLowerCase());
    const outsiderSig = await signDealTerms(outsider, bundle.dealTermsTypedData);
    const bad = await app.inject({
      method: "POST",
      url: `/drafts/${id}/deal-signatures`,
      payload: { role: "seller", signature: outsiderSig },
    });
    assert.equal(bad.statusCode, 400);
    const persisted = await store.getDraft(id);
    assert.equal(persisted.signatures["dealTerms:buyer"], buyerSig);
  });

  it("15. POST /drafts/:id/relay-fund enqueues a fund job idempotently", async () => {
    const { store, id, dealId } = await makeDraft();
    const app = makeApp(store);
    await app.ready();
    const first = await app.inject({ method: "POST", url: `/drafts/${id}/relay-fund`, payload: relayBody() });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().inserted, true);
    const job = await store.getRelay("fund-test-1");
    assert.equal(job.action, "fund");
    assert.equal(job.queue, "relay");
    assert.equal(job.params.dealId, dealId);
    assert.match(job.params.data, /^0x[0-9a-fA-F]+$/);
    const second = await app.inject({ method: "POST", url: `/drafts/${id}/relay-fund`, payload: relayBody() });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().inserted, false);
    assert.equal(second.json().status, "queued");
    assert.equal((await store.listQueuedRelay("relay", 10)).length, 1);
  });

  it("16. relay-fund rejects missing signatures/key and unknown drafts", async () => {
    const { store, id } = await makeDraft();
    const app = makeApp(store);
    await app.ready();
    const noKey = await app.inject({
      method: "POST",
      url: `/drafts/${id}/relay-fund`,
      payload: relayBody({ idempotencyKey: "" }),
    });
    assert.equal(noKey.statusCode, 400);
    const noSigs = await app.inject({
      method: "POST",
      url: `/drafts/${id}/relay-fund`,
      payload: relayBody({ sigBuyer: "not-hex" }),
    });
    assert.equal(noSigs.statusCode, 400);
    const missing = await app.inject({ method: "POST", url: "/drafts/nope/relay-fund", payload: relayBody() });
    assert.equal(missing.statusCode, 404);
  });

  it("17. GET /drafts/:id/funding-status is unconfigured without a reader and chain-first with one", async () => {
    const { store, id, dealId } = await makeDraft();
    const unconfigured = makeApp(store, null);
    await unconfigured.ready();
    const offRes = await unconfigured.inject({ method: "GET", url: `/drafts/${id}/funding-status` });
    assert.equal(offRes.statusCode, 200);
    assert.equal(offRes.json().source, "unconfigured");

    const stubReader = {
      async getDeal() {
        return {
          funded: true,
          phase: 1,
          settlementNonce: 7n,
          fundedAt: 1_000_000n,
          termsHash: bytes32("terms"),
        };
      },
    };
    const onchain = makeApp(store, stubReader);
    await onchain.ready();
    const onRes = await onchain.inject({ method: "GET", url: `/drafts/${id}/funding-status` });
    assert.equal(onRes.statusCode, 200);
    const status = onRes.json();
    assert.equal(status.source, "chain");
    assert.equal(status.dealId, dealId);
    assert.equal(status.funded, true);
    assert.equal(status.phase, "DELIVERED");
    assert.equal(status.settlementNonce, "7");
    assert.equal(status.fundedAt, "1000000");
  });

  it("18. allowance/admission typed-data builders match canonical field order", async () => {
    const allowance = fundWithAllowanceTypedData({
      chainId: CHAIN_ID,
      hub: HUB,
      dealId: bytes32("deal"),
      agreementDigest: bytes32("digest"),
      payer: buyer.address,
      amountUnits: "100500000",
      paymentSalt: bytes32("salt"),
      nonce: bytes32("nonce"),
      expiresAt: NOW + 100,
    });
    assert.deepEqual(
      allowance.types.FundWithAllowance.map((f) => f.name),
      EIP712_TYPES.FundWithAllowance.map((f) => f.name),
    );
    assert.equal(allowance.message.amount, 100500000n);
    assert.equal(allowance.domain.verifyingContract, HUB);

    const admission = fundingAdmissionTypedData({
      chainId: CHAIN_ID,
      hub: HUB,
      agreementDigest: bytes32("digest"),
      minPolicyId: bytes32("min"),
      admissionNonce: bytes32("adm"),
      expiresAt: NOW + 100,
      expectedUnfunded: true,
    });
    assert.deepEqual(
      admission.types.FundingAdmission.map((f) => f.name),
      ["agreementDigest", "minPolicyId", "admissionNonce", "expiresAt", "expectedUnfunded"],
    );
    assert.equal(admission.message.expectedUnfunded, true);

    const readiness = readinessConsentTypedData({
      chainId: CHAIN_ID,
      hub: HUB,
      dealId: bytes32("deal"),
      agreementDigest: bytes32("digest"),
      buyer: buyer.address,
      attestedAt: NOW,
      nonce: bytes32("nonce"),
      expiresAt: NOW + 100,
    });
    assert.deepEqual(
      readiness.types.ReadinessConsent.map((f) => f.name),
      EIP712_TYPES.ReadinessConsent.map((f) => f.name),
    );
    void toHexSig;
  });

  it("19. wire bundle validates against the canonical @midman/api-client schema", async () => {
    const { store, id } = await makeDraft();
    const deps = makeDeps(store);
    const asWire = (bundle) =>
      JSON.parse(JSON.stringify(bundle, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
    // Unsigned draft: null signatures, null admission — still validates.
    const unsigned = validateFundingBundle(asWire(await buildFundingBundle(store, deps, id, NOW)));
    assert.deepEqual(unsigned.signatures, { buyer: null, seller: null });
    assert.equal(unsigned.admission.granted, null);
    assert.equal(unsigned.token, USDC);
    assert.equal(unsigned.principalUnits, "100000000");
    assert.equal(unsigned.allowance.typedData.primaryType, "FundWithAllowance");
    // Recorded signatures + granted admission surface in later bundles.
    const bundle = await buildFundingBundle(store, deps, id, NOW);
    const buyerSig = await signDealTerms(buyer, bundle.dealTermsTypedData);
    const sellerSig = await signDealTerms(seller, bundle.dealTermsTypedData);
    await storeDealSignature(store, id, "buyer", buyerSig);
    await storeDealSignature(store, id, "seller", sellerSig);
    const grantSig = `0x${"99".repeat(65)}`;
    await store.updateDraft(id, {
      admission: {
        minPolicyId: bytes32("min"),
        admissionNonce: bytes32("nonce"),
        expiresAt: String(NOW + 86_400),
        signature: grantSig,
      },
    });
    const signed = validateFundingBundle(asWire(await buildFundingBundle(store, deps, id, NOW)));
    assert.equal(signed.signatures.buyer, buyerSig);
    assert.equal(signed.signatures.seller, sellerSig);
    assert.equal(signed.admission.granted.signature, grantSig);
    // The relay payload shape the web posts validates too.
    const relay = validateRelayFundPayload({ ...relayBody(), idempotencyKey: "wire-1" });
    assert.equal(relay.sigBuyer, sigBuyerHex);
    assert.equal(relay.allowance.expiresAt, String(NOW + 3600));
  });
});

describe("gasless deposit parameters", () => {
  it("bind the EIP-3009 authorization to the buyer, the hub, the exact amount and this deal", async () => {
    const { store, id, terms } = await makeDraft();
    const bundle = await buildFundingBundle(store, makeDeps(store), id, NOW);
    const { agreementDigest } = buildFullTerms(terms, HUB);
    assert.equal(bundle.payment3009.from.toLowerCase(), buyer.address.toLowerCase());
    assert.equal(bundle.payment3009.to, HUB);
    assert.equal(bundle.payment3009.value, terms.fundedUnits);
    assert.equal(bundle.payment3009.validAfter, "0");
    assert.equal(bundle.payment3009.validBefore, String(NOW + 3_600));
    // Exactly the nonce MidmanHub.fund() derives: keccak256(abi.encode(dealId, digest, paymentSalt)).
    assert.equal(bundle.payment3009.nonce, paymentNonce(terms.dealId, agreementDigest, bundle.payment3009.paymentSalt));
  });
});
