// EIP-712 consolidation tests for the canonical @midman/chain module.
// Run: node --test test/eip712-consolidation.test.mjs (from packages/chain,
// after `pnpm --filter @midman/chain build` so dist/ is fresh).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  TYPES,
  TYPE_STRINGS,
  typeHash,
  structHash,
  domainSeparator,
  digest,
  evidenceFilesHash,
  buildDomain,
} from "../dist/eip712.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Type-string literals below are pasted from
// packages/contracts/src/DealTypes.sol (MidmanDK *_TYPEHASH constants,
// cited per entry). Any contract-side drift must update BOTH the contract
// and @midman/chain; the on-chain DigestParity tests then re-pin digests.
const DEAL_TYPES_SOL = "../../../packages/contracts/src/DealTypes.sol";
const EXPECTED_STRINGS = {
  // DealTypes.sol lines 237-239 (DEAL_TERMS_TYPEHASH).
  DealTerms:
    "DealTerms(bytes32 dealId,uint32 termsVersion,address buyerAddress,address sellerAddress,address sellerPayoutAddress,address buyerRefundAddress,address buyerBondRefundAddress,address sellerBondRefundAddress,address token,uint256 principal,uint256 quotedPlatformFee,uint16 buyerFeeBps,bytes32 agreementHash,bytes32 feePolicyId,uint32 deliveryPeriodSeconds,uint32 inspectionPeriodSeconds,bytes32 categoryPolicyId,bytes32 readinessPolicyId,bytes32 readinessConsentHash,bytes32 evidencePolicyId,bytes32 bondPolicyId,bytes32 arbitrationPolicyId,bytes32 outagePolicyId,bytes32 catastrophicPolicyId,address platformFeeRecipient,address arbitrationCostRecipient,uint64 fundingDeadline,bytes32 nonce,bytes32 salt,address factory,address implementation,address custodyAddress)",
  // DealTypes.sol lines 240-241 (REVOKE_TYPEHASH).
  RevokeTerms:
    "RevokeTerms(bytes32 dealId,bytes32 agreementDigest,address revoker,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 242-244 (DELIVER_TYPEHASH).
  MarkDelivered:
    "MarkDelivered(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 manifestHash,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 245-247 (DISPUTE_TYPEHASH).
  OpenDispute:
    "OpenDispute(bytes32 dealId,bytes32 agreementDigest,address actor,uint8 reasonCode,bytes32 initialCommitment,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 248-250 (ESCALATE_TYPEHASH).
  EscalateDispute:
    "EscalateDispute(bytes32 dealId,bytes32 agreementDigest,address actor,uint256 collateralAmount,uint8 collateralSource,bytes32 bondPolicyId,bytes32 claimId,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 251-253 (APPROVE_TYPEHASH).
  ApproveSeller:
    "ApproveSeller(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 terminalPolicyVersion,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 254-256 (REFUND_TYPEHASH).
  RefundBuyer:
    "RefundBuyer(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 terminalPolicyVersion,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 257-259 (SETTLE_TYPEHASH).
  MutualSettlement:
    "MutualSettlement(bytes32 dealId,bytes32 agreementDigest,uint256 sellerAward,uint256 buyerBondCost,uint256 sellerBondCost,uint8 expectedPhase,bytes32 settlementNonce,uint64 expiresAt)",
  // DealTypes.sol lines 277-279 (RESERVE_TYPEHASH).
  ReserveExistingClaim:
    "ReserveExistingClaim(bytes32 dealId,bytes32 agreementDigest,address owner,bytes32 sourceClaimId,uint256 amount,uint8 party,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 260-262 (EVIDENCE_TYPEHASH).
  EvidenceManifest:
    "EvidenceManifest(bytes32 dealId,bytes32 agreementDigest,address uploader,uint32 sequence,bytes32 prevCommitment,bytes32[] fileHashes,bytes32 metadataCommitment,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 263-265 (RULING_TYPEHASH).
  Ruling:
    "Ruling(bytes32 dealId,bytes32 agreementDigest,bytes32 arbitrationPolicyId,uint8 origin,bytes32 rulingNonce,uint256 sellerAward,uint256 buyerBondCost,uint256 sellerBondCost,bytes32 evidenceCommitment,uint64 authEpoch,uint64 queueExpiry)",
  // DealTypes.sol lines 266-267 (VETO_TYPEHASH): field name is `expiresAt`
  // (the Solidity VetoSig member carrying the value is named `expiry`, but
  // the EIP-712 type string — the only thing the typehash commits to — says
  // `expiresAt`).
  VetoRuling:
    "VetoRuling(bytes32 dealId,bytes32 rulingDigest,address authority,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 268-270 (ADMISSION_TYPEHASH).
  FundingAdmission:
    "FundingAdmission(bytes32 agreementDigest,bytes32 minPolicyId,bytes32 admissionNonce,uint64 expiresAt,bool expectedUnfunded)",
  // DealTypes.sol lines 271-273 (ALLOWANCE_TYPEHASH).
  FundWithAllowance:
    "FundWithAllowance(bytes32 dealId,bytes32 agreementDigest,address payer,uint256 amount,bytes32 paymentSalt,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 274-276 (BOND_INTENT_TYPEHASH).
  BondIntent:
    "BondIntent(bytes32 dealId,bytes32 agreementDigest,address party,uint256 amount,bool useExistingClaim,bytes32 claimId,bytes32 nonce,uint64 expiresAt)",
  // DealTypes.sol lines 280-282 (READINESS_TYPEHASH).
  ReadinessConsent:
    "ReadinessConsent(bytes32 dealId,bytes32 agreementDigest,address buyer,uint64 attestedAt,bytes32 nonce,uint64 expiresAt)",
};

describe("canonical type strings match DealTypes.sol", () => {
  it("covers every contract action (16)", () => {
    assert.deepEqual(Object.keys(TYPE_STRINGS).sort(), Object.keys(EXPECTED_STRINGS).sort());
    assert.deepEqual(Object.keys(TYPES).sort(), Object.keys(EXPECTED_STRINGS).sort());
  });
  it("equals the DealTypes.sol literals character-for-character", () => {
    assert.deepEqual({ ...TYPE_STRINGS }, EXPECTED_STRINGS);
  });
  it("field arrays reconstruct each type string exactly", () => {
    for (const action of Object.keys(EXPECTED_STRINGS)) {
      const rebuilt = `${action}(${TYPES[action].map((f) => `${f.type} ${f.name}`).join(",")})`;
      assert.equal(rebuilt, EXPECTED_STRINGS[action], `${action} field order/names`);
    }
  });
  it("typeHash equals keccak256 of the contract string", () => {
    for (const action of Object.keys(EXPECTED_STRINGS)) {
      const expected = keccak256(Buffer.from(EXPECTED_STRINGS[action], "utf8"));
      assert.equal(typeHash(action), expected, `${action} typehash`);
    }
  });
});

describe("DigestParity vector reproduced off-chain", () => {
  // Fixed vector from packages/contracts/test/DigestParity.t.sol
  // (chain 8453, hub 0x00..00aa).
  const BUYER = "0x1111111111111111111111111111111111111111";
  const SELLER = "0x2222222222222222222222222222222222222222";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const HUB = "0x00000000000000000000000000000000000000AA";
  const EXPECTED_STRUCT = "0xaba36be58e620311090653518dad915d624cf182de91867c8f20a4e3fa37edc0";
  const EXPECTED_DIGEST = "0x9f2e8d55198db46098fc63e3085dcc747841d9a36cd0747271105150f475394b";
  const hex32 = (n) => `0x${n.toString(16).padStart(64, "0")}`;
  const params = [
    "bytes32", "uint32", "address", "address", "address", "address", "address", "address",
    "address", "uint256", "uint256", "uint16", "bytes32", "bytes32", "uint32", "uint32",
    "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32",
    "address", "address", "uint64", "bytes32", "bytes32", "address", "address", "address",
  ].map((type) => ({ type }));
  const values = [
    `0x${"11".repeat(32)}`, 1, BUYER, SELLER, SELLER, BUYER, BUYER, SELLER, USDC,
    100_000_000n, 500_000n, 10_000, hex32(1), `0x${"aa".repeat(32)}`, 3_600, 43_200,
    `0x${"bb".repeat(32)}`, `0x${"cc".repeat(32)}`, `0x${"00".repeat(32)}`,
    `0x${"dd".repeat(32)}`, `0x${"ee".repeat(32)}`, `0x${"ff".repeat(32)}`,
    hex32(5), hex32(6), BUYER, SELLER, 100_604_800, `0x${"33".repeat(32)}`,
    `0x${"44".repeat(32)}`, `0x${"00".repeat(20)}`, `0x${"00".repeat(20)}`, HUB,
  ];

  it("structHash matches the on-chain struct hash", () => {
    assert.equal(structHash("DealTerms", params, values), EXPECTED_STRUCT);
  });
  it("full digest (domain + 0x1901) matches the on-chain digest", () => {
    assert.deepEqual(buildDomain(8453, HUB), {
      name: "MidmanEscrow",
      version: "1",
      chainId: 8453,
      verifyingContract: HUB,
    });
    assert.equal(digest(domainSeparator(8453, HUB), structHash("DealTerms", params, values)), EXPECTED_DIGEST);
  });
});

describe("evidence file-set hash parity", () => {
  // Vectors mirrored by packages/contracts/test/EvidenceHashParity.t.sol
  // (keccak256(abi.encodePacked(...)) of the same arrays).
  const F1 = `0x${"11".repeat(32)}`;
  const F2 = `0x${"22".repeat(32)}`;
  const F3 = `0x${"33".repeat(32)}`;
  it("matches the packed-encoding vector (not abi.encode)", () => {
    assert.equal(evidenceFilesHash([F1, F2, F3]), "0x41524791bda53e6da2158f10c15e3672835515d6135111d11c7e9880cfcbe573");
    assert.equal(evidenceFilesHash([]), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(evidenceFilesHash([F1]), "0xb569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf816");
  });
  it("differs from the pre-fix abi.encode formula", () => {
    const wrong = keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [[F1, F2, F3]]));
    assert.equal(wrong, "0xb33141e287cdbb973ab6ab9cbd034a9f5772a7a2abd29f3b67efbbb90c107c7f");
    assert.notEqual(evidenceFilesHash([F1, F2, F3]), wrong);
  });
});

describe("no duplicate type strings outside the canonical module", () => {
  const ACTIONS = Object.keys(EXPECTED_STRINGS).join("|");
  const TYPE_STRING_RE = new RegExp(`"(${ACTIONS})\\(`);
  const OWNERS = ["fullTerms.ts", "journey.ts", "commitments.ts"].map(
    (f) => `../../../apps/api/src/${f}`,
  );
  const REVIEW = ["awards.ts", "proposals.ts", "routes.ts", "approvals.ts"].map(
    (f) => `../../../apps/api/src/review/${f}`,
  );
  const WEB = ["../../../apps/web/lib/wallet.ts", "../../../apps/web/lib/review.ts"];
  const files = [...OWNERS, ...REVIEW, ...WEB];
  for (const rel of files) {
    it(`${rel} has no local "<Action>(..." type-string literal`, () => {
      const src = readFileSync(path.join(here, rel), "utf8");
      assert.ok(!TYPE_STRING_RE.test(src), `duplicate EIP-712 type string in ${rel}`);
    });
  }
  it("refactored owners import the canonical definitions", () => {
    for (const rel of [...OWNERS, "../../../apps/api/src/review/awards.ts", "../../../apps/api/src/review/proposals.ts", "../../../apps/api/src/review/routes.ts", "../../../apps/web/lib/wallet.ts"]) {
      const src = readFileSync(path.join(here, rel), "utf8");
      assert.ok(src.includes('"@midman/chain"') || src.includes("'@midman/chain'"), `missing @midman/chain import in ${rel}`);
    }
  });
  it("contract source still carries the cited typehash lines", () => {
    // Multi-line keccak256("...") literals: compare whitespace-insensitively.
    const sol = readFileSync(path.join(here, DEAL_TYPES_SOL), "utf8").replace(/\s+/g, "");
    for (const s of Object.values(EXPECTED_STRINGS)) {
      assert.ok(sol.includes(`"${s.replace(/\s+/g, "")}"`), `DealTypes.sol no longer contains: ${s.slice(0, 40)}...`);
    }
  });
});
