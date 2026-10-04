import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { confirmationLevel, mayShipIrreversible } from "../dist/confirmations.js";
import { decodeHubLog } from "../dist/reader.js";
import { buildRecoveryPackage, emergencyCalldata } from "../dist/recovery.js";

describe("confirmation policy", () => {
  it("orders pending < included < safe < finalized", () => {
    assert.equal(confirmationLevel({ txBlock: null, safeBlock: null, finalizedBlock: null }), "pending");
    assert.equal(confirmationLevel({ txBlock: 10n, safeBlock: null, finalizedBlock: null }), "included");
    assert.equal(confirmationLevel({ txBlock: 10n, safeBlock: 12n, finalizedBlock: null }), "safe");
    assert.equal(confirmationLevel({ txBlock: 10n, safeBlock: 12n, finalizedBlock: 10n }), "finalized");
    assert.equal(confirmationLevel({ txBlock: 11n, safeBlock: 10n, finalizedBlock: 9n }), "included");
  });
  it("gates irreversible shipment on safe", () => {
    assert.equal(mayShipIrreversible("included"), false);
    assert.equal(mayShipIrreversible("safe"), true);
    assert.equal(mayShipIrreversible("finalized"), true);
  });
});

describe("hub log decoding", () => {
  it("returns null for unknown logs", () => {
    assert.equal(
      decodeHubLog({
        data: "0x",
        topics: ["0x0000000000000000000000000000000000000000000000000000000000000000"],
      }),
      null,
    );
  });
});

describe("recovery package", () => {
  const zero = "0x0000000000000000000000000000000000000000000000000000000000000000";
  it("embeds emergency calldata for direct submission", () => {
    const calldata = emergencyCalldata(zero);
    for (const key of ["refundForNonDelivery", "finalizeAfterTimeout", "catastrophicEscape", "claimBuyerPrincipal"]) {
      assert.match(calldata[key], /^0x[0-9a-f]+$/);
    }
  });
  it("builds a versioned package", () => {
    const pkg = buildRecoveryPackage({
      chainId: 8453,
      hub: "0x0000000000000000000000000000000000000001",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      dealId: zero,
      agreementDigest: zero,
      canonicalTerms: { principal: "100000000" },
      signatures: { buyer: zero, seller: zero },
      policyIds: { fee: "0xfee" },
      relevantTransactions: [],
      indexerTip: null,
    });
    assert.equal(pkg.version, 1);
    assert.equal(pkg.chainId, 8453);
    assert.ok(pkg.note.includes("authoritative"));
  });
});
