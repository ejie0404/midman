import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  previewAward,
  quorumProgress,
  disputeStages,
  exhaustedRightsNote,
  expectedPhaseForName,
  buildRulingTypedData,
  buildVetoTypedData,
  buildMutualSettlementTypedData,
  signTypedDataWithWallet,
  fetchReviewQueue,
  isAssignedToMe,
  isReviewMissing,
  isReviewerDenied,
  RULING_FIELD_ORDER,
  VETO_FIELD_ORDER,
  MUTUAL_SETTLEMENT_FIELD_ORDER,
} from "../lib/review.ts";
import { ApiError } from "../lib/api.ts";

const P = "100000000"; // 100 USDC
const F = "1000000"; // 1 USDC quoted fee
const BOND = "5000000"; // 5 USDC minimum bond

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("award preview vectors (exact strings, S=70/100 incl. costs)", () => {
  it("S=70 splits fee and bonds exactly", () => {
    const preview = previewAward({
      principalUnits: P,
      quotedFeeUnits: F,
      buyerFeeBps: 5000,
      sellerAwardUnits: "70000000",
      claimantBondUnits: BOND,
      respondentBondUnits: BOND,
    });
    assert.equal(preview.earnedFeeUnits, "700000");
    assert.equal(preview.buyerFeeUnits, "350000");
    assert.equal(preview.sellerFeeUnits, "350000");
    assert.equal(preview.prepaidBuyerFeeUnits, "500000");
    assert.equal(preview.buyerClaimUnits, "30150000");
    assert.equal(preview.sellerClaimUnits, "69650000");
    assert.equal(preview.fundedUnits, "100500000");
    assert.equal(preview.buyerCostUnits, "3500000");
    assert.equal(preview.sellerCostUnits, "1500000");
    // Conservation: buyerClaim + sellerClaim + earned == principal + prepaid.
    assert.equal(BigInt(preview.buyerClaimUnits) + BigInt(preview.sellerClaimUnits) + BigInt(preview.earnedFeeUnits), 100500000n);
  });

  it("S=100 awards everything to the seller with full buyer bond cost", () => {
    const preview = previewAward({
      principalUnits: P,
      quotedFeeUnits: F,
      buyerFeeBps: 5000,
      sellerAwardUnits: P,
      claimantBondUnits: BOND,
      respondentBondUnits: BOND,
    });
    assert.equal(preview.earnedFeeUnits, "1000000");
    assert.equal(preview.buyerClaimUnits, "0");
    assert.equal(preview.sellerClaimUnits, "99500000");
    assert.equal(preview.buyerCostUnits, "5000000");
    assert.equal(preview.sellerCostUnits, "0");
  });

  it("S=0 refunds the buyer with full seller bond cost", () => {
    const preview = previewAward({
      principalUnits: P,
      quotedFeeUnits: F,
      buyerFeeBps: 5000,
      sellerAwardUnits: "0",
      claimantBondUnits: BOND,
      respondentBondUnits: BOND,
    });
    assert.equal(preview.earnedFeeUnits, "0");
    assert.equal(preview.buyerClaimUnits, "100500000");
    assert.equal(preview.sellerClaimUnits, "0");
    assert.equal(preview.buyerCostUnits, "0");
    assert.equal(preview.sellerCostUnits, "5000000");
  });

  it("rejects out-of-range awards and defaults bonds to zero", () => {
    assert.throws(
      () =>
        previewAward({ principalUnits: P, quotedFeeUnits: F, buyerFeeBps: 5000, sellerAwardUnits: "100000001" }),
      RangeError,
    );
    const noBonds = previewAward({
      principalUnits: P,
      quotedFeeUnits: F,
      buyerFeeBps: 5000,
      sellerAwardUnits: "70000000",
    });
    assert.equal(noBonds.buyerCostUnits, "0");
    assert.equal(noBonds.sellerCostUnits, "0");
  });
});

describe("quorum math (recusal exclusion, duplicates)", () => {
  const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  it("excludes recused signers (case-insensitive)", () => {
    const progress = quorumProgress([A, B], [B.toLowerCase()], 2);
    assert.equal(progress.have, 1);
    assert.equal(progress.complete, false);
    assert.equal(progress.excludedRecused, 1);
    assert.deepEqual(progress.distinct, [A.toLowerCase()]);
  });

  it("dedupes repeat signatures from the same signer", () => {
    const progress = quorumProgress([A, A.toLowerCase(), B], [], 2);
    assert.equal(progress.have, 2);
    assert.equal(progress.complete, true);
    assert.equal(progress.excludedDuplicates, 1);
  });

  it("a recused duplicate counts once as recused", () => {
    const progress = quorumProgress([B, B], [B], 1);
    assert.equal(progress.have, 0);
    assert.equal(progress.complete, false);
    assert.equal(progress.excludedRecused, 2);
  });

  it("reaches quorum with distinct eligible signers", () => {
    const C = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const progress = quorumProgress([A, B, C], [C], 2);
    assert.equal(progress.have, 2);
    assert.equal(progress.need, 2);
    assert.equal(progress.complete, true);
  });
});

describe("countdown stage mapping from fixture timestamps", () => {
  const OPENED = 1_000_000;
  const NEGOTIATION_END = OPENED + 86_400;
  const ESCALATION_END = NEGOTIATION_END + 86_400;

  function byId(stages, id) {
    const found = stages.find((s) => s.id === id);
    assert.ok(found, `stage ${id} present`);
    return found;
  }

  it("maps negotiation active and escalation active just after the freeze", () => {
    const stages = disputeStages({ disputeOpenedAtUnix: OPENED }, OPENED + 3_600);
    assert.equal(byId(stages, "negotiation").state, "active");
    assert.equal(byId(stages, "negotiation").deadlineUnix, NEGOTIATION_END);
    assert.equal(byId(stages, "escalation").state, "active");
    assert.equal(byId(stages, "escalation").deadlineUnix, ESCALATION_END);
    assert.equal(byId(stages, "escape").deadlineUnix, OPENED + 5_184_000);
    assert.equal(stages.length, 7);
  });

  it("marks escalation lapsed with an exhausted-rights explainer when no bond was posted", () => {
    const now = ESCALATION_END + 10;
    const stages = disputeStages({ disputeOpenedAtUnix: OPENED, disputeUsed: true }, now);
    assert.equal(byId(stages, "negotiation").state, "done");
    assert.equal(byId(stages, "escalation").state, "lapsed");
    const note = exhaustedRightsNote({ disputeOpenedAtUnix: OPENED, disputeUsed: true }, now);
    assert.ok(note && note.includes("lapsed"));
  });

  it("marks escalation done once the bond is posted and tolerates missing timestamps", () => {
    const stages = disputeStages(
      { disputeOpenedAtUnix: OPENED, escalatedAtUnix: OPENED + 1_000, disputeUsed: true },
      OPENED + 2_000,
    );
    assert.equal(byId(stages, "escalation").state, "done");
    assert.equal(byId(stages, "evidence").state, "active");
    assert.equal(byId(stages, "primary").state, "active");
    assert.equal(exhaustedRightsNote({ disputeOpenedAtUnix: OPENED, escalatedAtUnix: OPENED + 1_000 }, OPENED + 2_000), null);

    const unknown = disputeStages({}, OPENED);
    assert.equal(byId(unknown, "negotiation").state, "unknown");
    assert.equal(byId(unknown, "escape").deadlineUnix, null);
  });

  it("maps ruling delay and fallback activation", () => {
    const stages = disputeStages(
      {
        disputeOpenedAtUnix: OPENED,
        escalatedAtUnix: OPENED + 1_000,
        fallbackStartUnix: OPENED + 700_000,
        rulingExecuteAtUnix: OPENED + 800_000,
      },
      OPENED + 750_000,
    );
    assert.equal(byId(stages, "primary").state, "done");
    assert.equal(byId(stages, "fallback").state, "active");
    assert.equal(byId(stages, "ruling").state, "active");
  });
});

describe("typed-data field order for Ruling/Veto builders", () => {
  const RULING_INPUT = {
    chainId: 8453,
    hub: "0x0000000000000000000000000000000000000001",
    dealId: `0x${"11".repeat(32)}`,
    agreementDigest: `0x${"22".repeat(32)}`,
    arbitrationPolicyId: `0x${"33".repeat(32)}`,
    origin: 0,
    rulingNonce: `0x${"44".repeat(32)}`,
    sellerAwardUnits: "70000000",
    buyerCostUnits: "3500000",
    sellerCostUnits: "1500000",
    evidenceCommitment: `0x${"55".repeat(32)}`,
    authEpoch: 1,
    queueExpiry: 2_000_000,
  };

  it("orders Ruling fields exactly per contract", () => {
    const envelope = buildRulingTypedData(RULING_INPUT);
    assert.equal(envelope.primaryType, "Ruling");
    assert.deepEqual(Object.keys(envelope.message), [...RULING_FIELD_ORDER]);
    assert.deepEqual(
      envelope.types["Ruling"].map((f) => f.name),
      [...RULING_FIELD_ORDER],
    );
    assert.equal(envelope.message["sellerAward"], 70000000n);
    assert.equal(envelope.domain["name"], "MidmanEscrow");
  });

  it("orders VetoRuling fields with no award/recipient (cancel-only)", () => {
    const envelope = buildVetoTypedData({
      chainId: 8453,
      hub: RULING_INPUT.hub,
      dealId: RULING_INPUT.dealId,
      rulingDigest: `0x${"66".repeat(32)}`,
      authority: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      nonce: `0x${"77".repeat(32)}`,
      expiresAt: 2_000_000,
    });
    assert.equal(envelope.primaryType, "VetoRuling");
    assert.deepEqual(Object.keys(envelope.message), [...VETO_FIELD_ORDER]);
    assert.deepEqual(
      envelope.types["VetoRuling"].map((f) => f.name),
      [...VETO_FIELD_ORDER],
    );
    assert.ok(!("sellerAward" in envelope.message) && !("recipient" in envelope.message));
  });

  it("orders MutualSettlement fields for countersigning", () => {
    const envelope = buildMutualSettlementTypedData({
      chainId: 8453,
      hub: RULING_INPUT.hub,
      dealId: RULING_INPUT.dealId,
      agreementDigest: RULING_INPUT.agreementDigest,
      sellerAwardUnits: "50000000",
      buyerCostUnits: "2500000",
      sellerCostUnits: "2500000",
      expectedPhase: 2,
      settlementNonce: `0x${"88".repeat(32)}`,
      expiresAt: 2_000_000,
    });
    assert.deepEqual(Object.keys(envelope.message), [...MUTUAL_SETTLEMENT_FIELD_ORDER]);
  });

  it("signs envelopes through the injected wallet client (server never sees keys)", async () => {
    const seen = [];
    const client = {
      signTypedData: async (args) => {
        seen.push(args);
        return "0xsig";
      },
    };
    const envelope = buildRulingTypedData(RULING_INPUT);
    const sig = await signTypedDataWithWallet(client, "0xreviewer", envelope);
    assert.equal(sig, "0xsig");
    assert.equal(seen[0].primaryType, "Ruling");
    assert.equal(seen[0].account, "0xreviewer");
  });
});

describe("review queue wrapper (mocked fetch)", () => {
  const auth = { address: "0xabc", signMessage: async () => "0xsig" };

  it("validates the server queue shape and adapts it for the workspace", async () => {
    const fetchImpl = async (url, init) => {
      assert.ok(String(url).endsWith("/review/queue"));
      assert.equal(init.method, "GET");
      assert.ok(init.headers["x-wallet-signature"]);
      return jsonResponse(200, {
        queue: [
          {
            dealId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            source: "chain",
            phase: "PRIMARY_REVIEW",
            phaseIndex: 5,
            inDispute: true,
            stage: "PRIMARY_REVIEW",
            deadlines: {
              evidenceEnd: "2500000",
              primaryEnd: "3000000",
              fallbackEnd: "3500000",
              escapeAt: "9000000",
              secondsToEvidenceEnd: 100000,
              secondsToEscape: 6000000,
            },
            primaryEligible: ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
            fallbackEligible: [],
            recusals: 0,
          },
          {
            dealId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            source: "projection",
            phase: "FALLBACK_REVIEW",
            phaseIndex: null,
            inDispute: null,
            stage: "unknown",
            deadlines: {
              evidenceEnd: null,
              primaryEnd: null,
              fallbackEnd: null,
              escapeAt: null,
              secondsToEvidenceEnd: null,
              secondsToEscape: null,
            },
            primaryEligible: [],
            fallbackEligible: ["0xabc0000000000000000000000000000000000000"],
            recusals: 1,
          },
        ],
        filtered: "dispute phases 2-8 first",
      });
    };
    const queue = await fetchReviewQueue(auth, fetchImpl);
    assert.equal(queue.length, 2);
    assert.equal(queue[0]?.panel, "primary");
    assert.equal(queue[1]?.panel, "fallback");
    assert.ok(queue[1]?.deadlineUnix === 0);
    assert.equal(isAssignedToMe(queue[0], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
    assert.equal(isAssignedToMe(queue[1], "0xabc0000000000000000000000000000000000000"), true);
    assert.equal(isAssignedToMe(queue[1], "0xother"), false);
    assert.equal(isAssignedToMe(queue[0], null), false);
  });

  it("throws ApiValidationError (never an empty queue) on a shape mismatch", async () => {
    const bad = await fetchReviewQueue(auth, async () => jsonResponse(200, [{ dealId: "legacy" }])).then(
      () => null,
      (error) => error,
    );
    assert.ok(bad, "mismatched queue payload must reject");
    assert.match(String(bad.message), /expected|queue/i);
  });

  it("surfaces missing-backend and denied statuses for UI fallback", async () => {
    const missing = await fetchReviewQueue(auth, async () => jsonResponse(404, { error: "nope" })).then(
      () => null,
      (error) => error,
    );
    assert.ok(missing instanceof ApiError && isReviewMissing(missing));
    assert.equal(isReviewerDenied(new ApiError(403, "denied")), true);
    assert.equal(isReviewMissing(new ApiError(500, "boom")), false);
  });

  it("maps phase names to expectedPhase uint8", () => {
    assert.equal(expectedPhaseForName("SELF_RESOLUTION"), 2);
    assert.equal(expectedPhaseForName("EVIDENCE"), 4);
    assert.equal(expectedPhaseForName("BOGUS"), 5);
    assert.equal(expectedPhaseForName(null), 5);
  });
});
