// Gasless deposit (EIP-3009): bundle parsing, ReceiveWithAuthorization
// signing in the token's own domain, and relay struct assembly.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { validateRelayFundPayload } from "@midman/api-client";
import { DEAL_TERMS_FIELDS } from "@midman/chain";
import {
  assembleRelayPayload,
  assembleStructs,
  parseFundingBundle,
  readTokenDomain,
  signPayment3009,
  splitSignature,
} from "../lib/funding.ts";

const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const HUB = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const DEAL = `0x${"ab".repeat(32)}`;
const ZERO = `0x${"00".repeat(32)}`;
const NONCE = `0x${"09".repeat(32)}`;

function rawBundle(payment3009) {
  const SELLER = "0x5555555555555555555555555555555555555555";
  const ZERO_ADDR = `0x${"00".repeat(20)}`;
  const message = {
    dealId: DEAL,
    termsVersion: "1",
    buyerAddress: buyer.address,
    sellerAddress: SELLER,
    sellerPayoutAddress: SELLER,
    buyerRefundAddress: buyer.address,
    buyerBondRefundAddress: buyer.address,
    sellerBondRefundAddress: SELLER,
    token: TOKEN,
    principal: "100000000",
    quotedPlatformFee: "1000000",
    buyerFeeBps: "5000",
    agreementHash: `0x${"cd".repeat(32)}`,
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
  };
  return {
    draftId: "draft_test",
    dealId: DEAL,
    chainId: 8453,
    hub: HUB,
    token: TOKEN,
    principalUnits: "100000000",
    fundedUnits: "100500000",
    prepaidBuyerFeeUnits: "500000",
    agreementDigest: `0x${"cd".repeat(32)}`,
    dealTermsTypedData: { domain: { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: HUB }, types: { DealTerms: DEAL_TERMS_FIELDS }, primaryType: "DealTerms", message },
    fullTerms: message,
    signatures: { buyer: "0xb1", seller: "0x5e" },
    allowance: { paymentSalt: ZERO, nonce: `0x${"03".repeat(32)}`, expiresAt: "1999999999", typedData: { domain: { name: "MidmanEscrow", version: "1", chainId: 8453, verifyingContract: HUB }, types: { FundWithAllowance: [] }, primaryType: "FundWithAllowance", message: { dealId: DEAL, agreementDigest: `0x${"cd".repeat(32)}`, payer: buyer.address, amount: "100500000", paymentSalt: ZERO, nonce: `0x${"03".repeat(32)}`, expiresAt: "1999999999" } } },
    readiness: { required: false, note: "no-readiness policy", attestedAt: "0", nonce: ZERO, expiresAt: "0", typedData: null },
    admission: { note: "admission required", granted: { minPolicyId: ZERO, admissionNonce: `0x${"04".repeat(32)}`, expiresAt: "1999999999", signature: "0xad" } },
    ...(payment3009 === undefined
      ? {
          payment3009: {
            from: buyer.address,
            to: HUB,
            value: "100500000",
            validAfter: "0",
            validBefore: "1999999999",
            paymentSalt: `0x${"07".repeat(32)}`,
            nonce: NONCE,
          },
        }
      : payment3009 === null
        ? {}
        : { payment3009 }),
    requiredSignatures: ["buyer", "seller"],
    relayActionTemplate: { action: "fund", params: { dealId: DEAL } },
  };
}

const wallet = { signTypedData: (args) => buyer.signTypedData(args) };
const domain = { name: "USD Coin", version: "2" };

describe("gasless deposit (EIP-3009)", () => {
  it("parses the payment params and rejects a bundle that redirects them", () => {
    const bundle = parseFundingBundle(rawBundle(), "draft_test");
    assert.equal(bundle.payment3009.value, 100500000n);
    assert.equal(bundle.payment3009.nonce, NONCE);
    assert.equal(parseFundingBundle(rawBundle(null), "d").payment3009, null, "older APIs omit it");
    const redirected = rawBundle();
    redirected.payment3009.to = TOKEN;
    assert.throws(() => parseFundingBundle(redirected, "d"), /must be the hub/);
    const wrongAmount = rawBundle();
    wrongAmount.payment3009.value = "1";
    assert.throws(() => parseFundingBundle(wrongAmount, "d"), /must equal fundedUnits/);
  });

  it("signs ReceiveWithAuthorization in the token's domain for exactly this deposit", async () => {
    const bundle = parseFundingBundle(rawBundle(), "draft_test");
    const sig = await signPayment3009(buyer.address, bundle, { walletClient: wallet, tokenDomain: domain });
    const signature = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}`;
    const recovered = await recoverTypedDataAddress({
      domain: { ...domain, chainId: 8453, verifyingContract: TOKEN },
      types: {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: { from: buyer.address, to: HUB, value: 100500000n, validAfter: 0n, validBefore: 1999999999n, nonce: NONCE },
      signature,
    });
    assert.equal(recovered, buyer.address);
    await assert.rejects(
      signPayment3009("0x5555555555555555555555555555555555555555", bundle, { walletClient: wallet, tokenDomain: domain }),
      /only the buyer/,
    );
  });

  it("assembles a use3009 relay payload with the allowance slot left absent", async () => {
    const bundle = parseFundingBundle(rawBundle(), "draft_test");
    const payment = await signPayment3009(buyer.address, bundle, { walletClient: wallet, tokenDomain: domain });
    const structs = assembleStructs(bundle, { buyer: "0xb1", seller: "0x5e", payment });
    assert.equal(structs.pay.use3009, true);
    assert.equal(structs.pay.paymentSalt, `0x${"07".repeat(32)}`);
    assert.equal(structs.pay.v, payment.v);
    assert.equal(structs.allowance.nonce, ZERO);
    const payload = assembleRelayPayload(bundle, { buyer: "0xb1", seller: "0x5e", payment });
    validateRelayFundPayload(payload);
    assert.equal(payload.pay.use3009, true);
  });

  it("still requires the allowance signature on the approve path", () => {
    const bundle = parseFundingBundle(rawBundle(), "draft_test");
    assert.throws(() => assembleStructs(bundle, { buyer: "0xb1", seller: "0x5e" }), /allowance intent/);
  });

  it("splits 65-byte signatures and refuses smart-wallet signatures", () => {
    const r = "11".repeat(32);
    const s = "22".repeat(32);
    assert.deepEqual(splitSignature(`0x${r}${s}1b`), { r: `0x${r}`, s: `0x${s}`, v: 27 });
    assert.equal(splitSignature(`0x${r}${s}01`).v, 28, "yParity form normalizes to 27/28");
    assert.throws(() => splitSignature(`0x${"aa".repeat(200)}`), /standard wallet signature/);
  });

  it("reads the token domain via EIP-5267, falling back to name()/version()", async () => {
    const eip5267 = { readContract: async ({ functionName }) => (functionName === "eip712Domain" ? ["0x0f", "MockUSDC", "1"] : null) };
    assert.deepEqual(await readTokenDomain(TOKEN, { publicClient: eip5267 }), { name: "MockUSDC", version: "1" });
    const fiatToken = {
      readContract: async ({ functionName }) => {
        if (functionName === "eip712Domain") throw new Error("not implemented");
        return functionName === "name" ? "USD Coin" : "2";
      },
    };
    assert.deepEqual(await readTokenDomain(TOKEN, { publicClient: fiatToken }), { name: "USD Coin", version: "2" });
  });
});
