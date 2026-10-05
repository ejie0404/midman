// Unit tests for apps/web/lib/funding.ts + wallet event confirmation
// (audit findings #6 and #8).
//
// Mocked fetch + fake wallet/public clients. No network, no keys.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData } from "viem";
import { DEAL_TERMS_FIELDS, HUB_ABI } from "@midman/chain";
import {
  parseFundingBundle,
  fetchFundingBundle,
  fetchFundingStatus,
  signDealTerms,
  signAllowance,
  signReadiness,
  assembleRelayPayload,
  buildFundCalldata,
  buildApproveCalldata,
  directFund,
  submitRelayFund,
  waitForFundingEvent,
} from "../lib/funding.ts";
import { validateRelayFundPayload } from "@midman/api-client";
import { confirmEvent, TxRevertedError, EventNotFoundError } from "../lib/wallet.ts";
import { ApiError } from "../lib/api.ts";

const HUB = "0x1111111111111111111111111111111111111111";
const OTHER_HUB = "0x9999999999999999999999999999999999999999";
const TOKEN = "0x2222222222222222222222222222222222222222";
const DEAL = `0x${"ab".repeat(32)}`;
const OTHER_DEAL = `0x${"ef".repeat(32)}`;
const AGREEMENT = `0x${"cd".repeat(32)}`;
const ZERO = `0x${"00".repeat(32)}`;
const ZERO_ADDR = `0x${"00".repeat(20)}`;
const TX_APPROVE = `0x${"a1".repeat(32)}`;
const TX_FUND = `0x${"f1".repeat(32)}`;
const BUYER = "0x4444444444444444444444444444444444444444";
const SELLER = "0x5555555555555555555555555555555555555555";

function fullTerms(overrides = {}) {
  // Wire fidelity: uints are decimal strings (JSON has no bigint).
  return {
    dealId: DEAL,
    termsVersion: "1",
    buyerAddress: BUYER,
    sellerAddress: SELLER,
    sellerPayoutAddress: SELLER,
    buyerRefundAddress: BUYER,
    buyerBondRefundAddress: BUYER,
    sellerBondRefundAddress: SELLER,
    token: TOKEN,
    principal: "100000000",
    quotedPlatformFee: "1000000",
    buyerFeeBps: "5000",
    agreementHash: AGREEMENT,
    feePolicyId: ZERO,
    deliveryPeriodSeconds: "3600",
    inspectionPeriodSeconds: "43200",
    categoryPolicyId: ZERO,
    readinessPolicyId: ZERO,
    readinessConsentHash: ZERO,
    evidencePolicyId: ZERO,
    bondPolicyId: ZERO,
    arbitrationPolicyId: ZERO,
    outagePolicyId: ZERO,
    catastrophicPolicyId: ZERO,
    platformFeeRecipient: "0x6666666666666666666666666666666666666666",
    arbitrationCostRecipient: "0x7777777777777777777777777777777777777777",
    fundingDeadline: "1999999999",
    nonce: `0x${"01".repeat(32)}`,
    salt: `0x${"02".repeat(32)}`,
    factory: ZERO_ADDR,
    implementation: ZERO_ADDR,
    custodyAddress: HUB,
    ...overrides,
  };
}

function typedData(overrides = {}) {
  return {
    domain: { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: HUB },
    types: { DealTerms: DEAL_TERMS_FIELDS },
    primaryType: "DealTerms",
    message: fullTerms(),
    ...overrides,
  };
}

function allowanceEnvelope() {
  return {
    domain: { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: HUB },
    types: { FundWithAllowance: [] },
    primaryType: "FundWithAllowance",
    message: {
      dealId: DEAL,
      agreementDigest: AGREEMENT,
      payer: BUYER,
      amount: "100500000",
      paymentSalt: ZERO,
      nonce: `0x${"03".repeat(32)}`,
      expiresAt: "1999999999",
    },
  };
}

// Canonical wire bundle: exact @midman/api-client field names, decimal
// strings for uints. This is the shape the real API emits.
function rawBundle(overrides = {}) {
  return {
    draftId: "draft_test",
    dealId: DEAL,
    chainId: 8453,
    hub: HUB,
    token: TOKEN,
    principalUnits: "100000000",
    fundedUnits: "100500000",
    prepaidBuyerFeeUnits: "500000",
    agreementDigest: AGREEMENT,
    dealTermsTypedData: typedData(),
    fullTerms: fullTerms(),
    signatures: { buyer: null, seller: null },
    allowance: {
      paymentSalt: ZERO,
      nonce: `0x${"03".repeat(32)}`,
      expiresAt: "1999999999",
      typedData: allowanceEnvelope(),
    },
    readiness: {
      required: false,
      note: "no-readiness policy",
      attestedAt: "0",
      nonce: ZERO,
      expiresAt: "0",
      typedData: null,
    },
    admission: {
      note: "admission required",
      granted: {
        minPolicyId: ZERO,
        admissionNonce: `0x${"04".repeat(32)}`,
        expiresAt: "1999999999",
        signature: "0xad",
      },
    },
    requiredSignatures: ["buyer", "seller"],
    relayActionTemplate: { action: "fund", params: { dealId: DEAL } },
    ...overrides,
  };
}

function parsedBundle(overrides = {}) {
  return parseFundingBundle(rawBundle(overrides), "draft_test");
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dealFundedLog({ hub = HUB, dealId = DEAL } = {}) {
  const topics = encodeEventTopics({ abi: HUB_ABI, eventName: "DealFunded", args: { dealId } });
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [AGREEMENT, 100000000n, 100500000n],
  );
  return {
    address: hub,
    topics,
    data,
    blockNumber: 10n,
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: TX_FUND,
    blockHash: ZERO,
    removed: false,
  };
}

function disputeOpenedLog({ hub = HUB, dealId = DEAL } = {}) {
  const topics = encodeEventTopics({ abi: HUB_ABI, eventName: "DisputeOpened", args: { dealId } });
  const data = encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }], [1700000000n, 1700003600n]);
  return {
    address: hub,
    topics,
    data,
    blockNumber: 11n,
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: TX_FUND,
    blockHash: ZERO,
    removed: false,
  };
}

function receipt({ status = "success", logs = [], hash = TX_FUND } = {}) {
  return { status, logs, transactionHash: hash, blockNumber: 10n, blockHash: ZERO, logsBloom: ZERO };
}

function fakeWallet({ chainId = 8453, hashes = [TX_APPROVE, TX_FUND] } = {}) {
  const sent = [];
  return {
    sent,
    async getChainId() {
      return chainId;
    },
    async sendTransaction(args) {
      sent.push(args);
      return hashes[sent.length - 1] ?? TX_FUND;
    },
  };
}

function fakePublic({ receipts = {}, allowance = 0n } = {}) {
  const waits = [];
  return {
    waits,
    async waitForTransactionReceipt({ hash }) {
      waits.push(hash);
      const found = receipts[hash];
      if (!found) throw new Error(`no fake receipt for ${hash}`);
      return found;
    },
    async readContract() {
      return allowance;
    },
  };
}

function fakeSigner() {
  const calls = [];
  return {
    calls,
    async signTypedData(args) {
      calls.push(args);
      return `0x${"77".repeat(65)}`;
    },
  };
}

// ---- Bundle fetch / validate ----

describe("funding bundle parsing (finding #6: full DealTerms)", () => {
  it("parses a valid bundle and normalizes integer fields to bigint", () => {
    const b = parsedBundle();
    assert.equal(b.dealId, DEAL);
    assert.equal(b.chainId, 8453);
    assert.equal(b.token, TOKEN);
    assert.equal(b.principalUnits, "100000000");
    assert.equal(b.fundedUnits, "100500000");
    assert.equal(b.prepaidBuyerFeeUnits, "500000");
    assert.equal(b.readiness.required, false);
    assert.equal(b.allowance.paymentSalt, ZERO);
    assert.equal(b.allowance.expiresAt, 1999999999n);
    assert.equal(b.admission.granted.signature, "0xad");
    assert.equal(b.dealTermsTypedData.types.DealTerms.length, 32);
    assert.equal(b.dealTermsTypedData.domain.name, "MidmanEscrow");
    assert.equal(typeof b.dealTermsTypedData.message.principal, "bigint");
    assert.equal(b.fullTerms.principal, 100000000n);
    assert.equal(b.fullTerms.buyerFeeBps, 5000n);
  });

  it("rejects alias/legacy field names instead of null-filling (no silent drift)", () => {
    const raw = rawBundle();
    delete raw.token;
    raw.usdc = TOKEN;
    assert.throws(() => parseFundingBundle(raw, "d"), /token/);
    const raw2 = rawBundle();
    delete raw2.allowance;
    raw2.allowanceIntent = { paymentSalt: ZERO, nonce: ZERO, expiresAt: "1", typedData: allowanceEnvelope() };
    assert.throws(() => parseFundingBundle(raw2, "d"), /allowance/);
    const raw3 = rawBundle();
    delete raw3.principalUnits;
    raw3.principal = "100000000";
    assert.throws(() => parseFundingBundle(raw3, "d"), /principalUnits/);
  });

  it("rejects a bundle missing fundedUnits", () => {
    const raw = rawBundle();
    delete raw.fundedUnits;
    assert.throws(() => parseFundingBundle(raw, "d"), /fundedUnits/);
  });

  it("rejects the legacy 5-field MidmanDraft acceptance envelope", () => {
    const legacy = {
      domain: { name: "MidmanDraft", version: "1", chainId: 8453, verifyingContract: HUB },
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
      message: { dealId: DEAL, principal: "1", quotedPlatformFee: "1", buyer: BUYER, seller: SELLER },
    };
    assert.throws(() => parsedBundle({ dealTermsTypedData: legacy }), /32 canonical fields|MidmanEscrow/);
  });

  it("fetchFundingBundle GETs /drafts/:id/funding-bundle with mocked fetch", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, rawBundle());
    };
    const b = await fetchFundingBundle("draft_abc", { fetchImpl });
    assert.equal(b.fundedUnits, "100500000");
    assert.match(calls[0].url, /\/drafts\/draft_abc\/funding-bundle$/);
    assert.equal(calls[0].init.method, "GET");
  });

  it("fetchFundingBundle throws ApiError(status) when the endpoint is missing", async () => {
    const fetchImpl = async () => jsonResponse(404, { error: "not found" });
    await assert.rejects(() => fetchFundingBundle("draft_missing", { fetchImpl }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 404);
      return true;
    });
  });
});

// ---- signDealTerms message shape ----

describe("signDealTerms signs the canonical 32-field struct", () => {
  it("passes MidmanEscrow domain + 32 fields + bigint message to signTypedData", async () => {
    const signer = fakeSigner();
    const b = parsedBundle();
    const sig = await signDealTerms(BUYER, b.dealTermsTypedData, { walletClient: signer });
    assert.match(sig, /^0x/);
    assert.equal(signer.calls.length, 1);
    const call = signer.calls[0];
    assert.equal(call.domain.name, "MidmanEscrow");
    assert.equal(call.primaryType, "DealTerms");
    assert.equal(call.types.DealTerms.length, 32);
    assert.equal(typeof call.message.principal, "bigint");
    assert.equal(call.message.termsVersion, BigInt(1));
    // Field order must match the canonical contract order exactly.
    assert.deepEqual(
      call.types.DealTerms.map((f) => `${f.type} ${f.name}`),
      DEAL_TERMS_FIELDS.map((f) => `${f.type} ${f.name}`),
    );
  });

  it("rejects a MidmanDraft (5-field) envelope before signing", async () => {
    const signer = fakeSigner();
    const legacy = {
      domain: { name: "MidmanDraft", version: "1", chainId: 8453, verifyingContract: HUB },
      types: { DealTerms: DEAL_TERMS_FIELDS.slice(0, 5) },
      primaryType: "DealTerms",
      message: {},
    };
    await assert.rejects(() => signDealTerms(BUYER, legacy, { walletClient: signer }), /MidmanEscrow/);
    assert.equal(signer.calls.length, 0);
  });

  it("signAllowance / signReadiness use canonical FundWithAllowance + ReadinessConsent", async () => {
    const signer = fakeSigner();
    await signAllowance(
      BUYER,
      {
        dealId: DEAL,
        agreementDigest: AGREEMENT,
        payer: BUYER,
        amount: 100500000n,
        paymentSalt: ZERO,
        nonce: ZERO,
        expiresAt: 1999999999n,
      },
      { chainId: 8453, hub: HUB },
      { walletClient: signer },
    );
    await signReadiness(
      BUYER,
      { dealId: DEAL, agreementDigest: AGREEMENT, buyer: BUYER, attestedAt: 1n, nonce: ZERO, expiresAt: 1999999999n },
      { chainId: 8453, hub: HUB },
      { walletClient: signer },
    );
    assert.equal(signer.calls[0].primaryType, "FundWithAllowance");
    assert.equal(signer.calls[1].primaryType, "ReadinessConsent");
  });
});

// ---- Calldata ----

describe("calldata builders", () => {
  it("buildApproveCalldata encodes ERC20 approve(spender, amount)", () => {
    const data = buildApproveCalldata(HUB, "100500000");
    const decoded = decodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }], data });
    assert.equal(decoded.functionName, "approve");
    assert.equal(decoded.args[0].toLowerCase(), HUB.toLowerCase());
    assert.equal(decoded.args[1], 100500000n);
  });

  it("buildFundCalldata requires buyer, seller AND allowance signatures", () => {
    const b = parsedBundle();
    const full = { buyer: "0xbuyer", seller: "0xseller", allowance: `0x${"a1".repeat(65)}` };
    assert.throws(() => buildFundCalldata(b, { ...full, seller: "" }), /seller/);
    assert.throws(() => buildFundCalldata(b, { ...full, buyer: "" }), /buyer/);
    assert.throws(() => buildFundCalldata(b, { ...full, allowance: "" }), /allowance/);
  });

  it("buildFundCalldata encodes fund(...) with the full struct + both sigs", () => {
    const b = parsedBundle();
    const data = buildFundCalldata(b, {
      buyer: `0x${"b1".repeat(65)}`,
      seller: `0x${"c1".repeat(65)}`,
      allowance: `0x${"a1".repeat(65)}`,
    });
    const decoded = decodeFunctionData({ abi: HUB_ABI, data });
    assert.equal(decoded.functionName, "fund");
    assert.equal(decoded.args[0].dealId, DEAL);
    assert.equal(decoded.args[0].principal, 100000000n);
    assert.equal(decoded.args[0].buyerAddress.toLowerCase(), BUYER.toLowerCase());
    assert.match(decoded.args[1], /^0xb1/);
    assert.match(decoded.args[2], /^0xc1/);
  });
});

// ---- Direct path sequence ----

describe("directFund: approve THEN fund (never approve-only)", () => {
  it("sends approve to the token, then fund to the hub, and confirms DealFunded", async () => {
    const wallet = fakeWallet();
    const publicClient = fakePublic({
      receipts: { [TX_APPROVE]: receipt({ hash: TX_APPROVE }), [TX_FUND]: receipt({ logs: [dealFundedLog()] }) },
      allowance: 0n,
    });
    const result = await directFund(
      parsedBundle(),
      { buyer: `0x${"b1".repeat(65)}`, seller: `0x${"c1".repeat(65)}`, allowance: `0x${"a1".repeat(65)}` },
      { walletClient: wallet, publicClient, account: BUYER },
    );
    assert.equal(wallet.sent.length, 2);
    // 1) approve targets the USDC token
    assert.equal(wallet.sent[0].to.toLowerCase(), TOKEN.toLowerCase());
    const approveDecoded = decodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }], data: wallet.sent[0].data });
    assert.equal(approveDecoded.functionName, "approve");
    // 2) fund targets the hub
    assert.equal(wallet.sent[1].to.toLowerCase(), HUB.toLowerCase());
    assert.equal(decodeFunctionData({ abi: HUB_ABI, data: wallet.sent[1].data }).functionName, "fund");
    assert.equal(result.approveTxHash, TX_APPROVE);
    assert.equal(result.fundTxHash, TX_FUND);
    assert.equal(result.event.eventName, "DealFunded");
    assert.equal(result.event.args.dealId, DEAL);
  });

  it("skips approve when the on-chain allowance already covers the exact amount", async () => {
    const wallet = fakeWallet({ hashes: [TX_FUND] });
    const publicClient = fakePublic({
      receipts: { [TX_FUND]: receipt({ logs: [dealFundedLog()] }) },
      allowance: 100500000n,
    });
    const result = await directFund(
      parsedBundle(),
      { buyer: `0x${"b1".repeat(65)}`, seller: `0x${"c1".repeat(65)}`, allowance: `0x${"a1".repeat(65)}` },
      { walletClient: wallet, publicClient, account: BUYER },
    );
    assert.equal(wallet.sent.length, 1);
    assert.equal(wallet.sent[0].to.toLowerCase(), HUB.toLowerCase());
    assert.equal(result.approveTxHash, null);
    assert.equal(result.fundTxHash, TX_FUND);
  });

  it("throws TxRevertedError when the fund() receipt reverted (approve alone is not funding)", async () => {
    const wallet = fakeWallet();
    const publicClient = fakePublic({
      receipts: { [TX_APPROVE]: receipt({ hash: TX_APPROVE }), [TX_FUND]: receipt({ status: "reverted" }) },
      allowance: 0n,
    });
    await assert.rejects(
      () =>
        directFund(
          parsedBundle(),
          { buyer: `0x${"b1".repeat(65)}`, seller: `0x${"c1".repeat(65)}`, allowance: `0x${"a1".repeat(65)}` },
          { walletClient: wallet, publicClient, account: BUYER },
        ),
      (e) => {
        assert.ok(e instanceof TxRevertedError);
        return true;
      },
    );
    // It did attempt BOTH steps: approve then fund.
    assert.equal(wallet.sent.length, 2);
  });

  it("throws EventNotFoundError when fund() succeeds but DealFunded is absent", async () => {
    const wallet = fakeWallet();
    const publicClient = fakePublic({
      receipts: { [TX_APPROVE]: receipt({ hash: TX_APPROVE }), [TX_FUND]: receipt({ logs: [] }) },
      allowance: 0n,
    });
    await assert.rejects(
      () =>
        directFund(
          parsedBundle(),
          { buyer: `0x${"b1".repeat(65)}`, seller: `0x${"c1".repeat(65)}`, allowance: `0x${"a1".repeat(65)}` },
          { walletClient: wallet, publicClient, account: BUYER },
        ),
      (e) => {
        assert.ok(e instanceof EventNotFoundError);
        return true;
      },
    );
  });
});

// ---- Event confirmation semantics (finding #8) ----

describe("confirmEvent requires the exact event + matching dealId", () => {
  it("returns the event when the log matches the expected dealId", () => {
    const confirmed = confirmEvent(receipt({ logs: [dealFundedLog()] }), HUB, "DealFunded", (args) => args.dealId === DEAL);
    assert.equal(confirmed.eventName, "DealFunded");
    assert.equal(confirmed.args.dealId, DEAL);
  });

  it("does NOT report frozen when DisputeOpened is for a different dealId", () => {
    const r = receipt({ logs: [disputeOpenedLog({ dealId: OTHER_DEAL })] });
    assert.throws(
      () => confirmEvent(r, HUB, "DisputeOpened", (args) => String(args.dealId).toLowerCase() === DEAL.toLowerCase()),
      EventNotFoundError,
    );
  });

  it("does NOT report frozen when the successful receipt has no DisputeOpened log", () => {
    assert.throws(
      () => confirmEvent(receipt({ logs: [] }), HUB, "DisputeOpened", (args) => args.dealId === DEAL),
      EventNotFoundError,
    );
  });

  it("confirms DisputeOpened only on the matching hub + dealId", () => {
    const wrongHub = receipt({ logs: [disputeOpenedLog({ hub: OTHER_HUB })] });
    assert.throws(() => confirmEvent(wrongHub, HUB, "DisputeOpened", () => true), EventNotFoundError);
    const ok = confirmEvent(receipt({ logs: [disputeOpenedLog()] }), HUB, "DisputeOpened", (args) => args.dealId === DEAL);
    assert.equal(ok.eventName, "DisputeOpened");
  });
});

// ---- Relay path ----

describe("relay funding path", () => {
  it("submitRelayFund POSTs the canonical sigBuyer/sigSeller + structs body", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(200, { idempotencyKey: "x", inserted: true, status: "queued" });
    };
    const payload = assembleRelayPayload(parsedBundle(), {
      buyer: `0x${"b1".repeat(65)}`,
      seller: `0x${"c1".repeat(65)}`,
      allowance: `0x${"a1".repeat(65)}`,
    });
    // The assembled body satisfies the canonical API contract verbatim.
    validateRelayFundPayload(payload);
    const res = await submitRelayFund("draft_r", payload, { fetchImpl });
    assert.equal(res.status, "queued");
    assert.match(calls[0].url, /\/drafts\/draft_r\/relay-fund$/);
    assert.match(calls[0].body.sigBuyer, /^0xb1/);
    assert.match(calls[0].body.sigSeller, /^0xc1/);
    assert.equal(calls[0].body.allowance.signature, `0x${"a1".repeat(65)}`);
    assert.equal(calls[0].body.admission.signature, "0xad");
    // Readiness is not required by this fixture: hub-ignored slot is explicit.
    assert.equal(calls[0].body.readiness.signature, "0x00");
    assert.ok(typeof calls[0].body.idempotencyKey === "string" && calls[0].body.idempotencyKey.length > 0);
  });

  it("waitForFundingEvent polls status then confirms DealFunded on the exact receipt", async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /funding-status$/);
      return jsonResponse(200, { status: "included", level: "included", txHash: TX_FUND });
    };
    const publicClient = fakePublic({ receipts: { [TX_FUND]: receipt({ logs: [dealFundedLog()] }) } });
    const result = await waitForFundingEvent("draft_r", HUB, DEAL, { fetchImpl, publicClient, intervalMs: 1 });
    assert.equal(result.txHash, TX_FUND);
    assert.equal(result.event.eventName, "DealFunded");
  });

  it("waitForFundingEvent throws when the relayer receipt reverted", async () => {
    const fetchImpl = async () => jsonResponse(200, { status: "included", txHash: TX_FUND });
    const publicClient = fakePublic({ receipts: { [TX_FUND]: receipt({ status: "reverted" }) } });
    await assert.rejects(
      () => waitForFundingEvent("draft_r", HUB, DEAL, { fetchImpl, publicClient, intervalMs: 1 }),
      TxRevertedError,
    );
  });

  it("fetchFundingStatus reports pending when no tx hash is present", async () => {
    const fetchImpl = async () => jsonResponse(200, { status: "queued" });
    const status = await fetchFundingStatus("draft_r", { fetchImpl });
    assert.equal(status.txHash, null);
    assert.equal(status.level, "pending");
    assert.equal(status.included, false);
  });
});
