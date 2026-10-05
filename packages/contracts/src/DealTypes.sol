// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Shared storage types, constants, errors and events for the Midman
/// hub system. Imported by MidmanHub (storage + funding + exits) and
/// HubDispute (delegatecall dispute machine). Single custody address and
/// single EIP-712 domain are preserved: the library executes in hub context.
struct DealTerms {
    bytes32 dealId;
    uint32 termsVersion;
    address buyerAddress;
    address sellerAddress;
    address sellerPayoutAddress;
    address buyerRefundAddress;
    address buyerBondRefundAddress;
    address sellerBondRefundAddress;
    address token;
    uint256 principal;
    uint256 quotedPlatformFee;
    uint16 buyerFeeBps;
    bytes32 agreementHash;
    bytes32 feePolicyId;
    uint32 deliveryPeriodSeconds;
    uint32 inspectionPeriodSeconds;
    bytes32 categoryPolicyId;
    bytes32 readinessPolicyId;
    bytes32 readinessConsentHash;
    bytes32 evidencePolicyId;
    bytes32 bondPolicyId;
    bytes32 arbitrationPolicyId;
    bytes32 outagePolicyId;
    bytes32 catastrophicPolicyId;
    address platformFeeRecipient;
    address arbitrationCostRecipient;
    uint64 fundingDeadline;
    bytes32 nonce;
    bytes32 salt;
    address factory;
    address implementation;
    address custodyAddress;
}

struct Deal {
    bool funded;
    uint8 phase;
    bytes32 termsHash;
    address buyer;
    address seller;
    address sellerPayout;
    address buyerRefund;
    address buyerBondRefund;
    address sellerBondRefund;
    uint256 principal;
    uint256 quotedFee;
    uint16 buyerFeeBps;
    uint256 prepaidBuyerFee;
    uint32 deliveryPeriod;
    uint32 inspectionPeriod;
    bytes32 bondPolicyId;
    bytes32 arbitrationPolicyId;
    bytes32 outagePolicyId;
    address platformFeeRecipient;
    address arbitrationCostRecipient;
    uint64 fundedAt;
    uint64 deliveredAt;
    uint64 disputeOpenedAt;
    uint64 escalatedAt;
    uint64 fallbackStartedAt;
    bool disputeUsed;
    uint8 tier;
    uint8 primaryQuorum;
    uint8 fallbackQuorum;
    uint64 execDelay;
    uint256 claimantBond;
    uint256 respondentBond;
    bytes32 deliveryManifest;
    bytes32 manifestHead;
    uint32 manifestCount;
    uint256 settlementNonce;
    bool rulingQueued;
    uint8 rulingOrigin;
    uint64 rulingExecuteAt;
    uint64 rulingEpoch;
    uint256 rulingSellerAward;
    uint256 rulingBuyerCost;
    uint256 rulingSellerCost;
    bytes32 rulingDigest;
}

struct Claim {
    address recipient;
    uint256 amount;
}

struct Ledger {
    uint256 escrow;
    uint256 bonds;
    uint256 claims;
}

struct Payment3009 {
    uint256 validAfter;
    uint256 validBefore;
    bytes32 paymentSalt;
    uint8 v;
    bytes32 r;
    bytes32 s;
    bool use3009;
}

struct AllowanceIntent {
    bytes32 paymentSalt;
    bytes32 nonce;
    uint64 expiresAt;
    bytes signature;
}

struct Admission {
    bytes32 minPolicyId;
    bytes32 admissionNonce;
    uint64 expiresAt;
    bytes signature;
}

struct ReadinessAuth {
    uint64 attestedAt;
    bytes32 nonce;
    uint64 expiresAt;
    bytes signature;
}

struct RulingAuth {
    uint8 origin;
    bytes32 rulingNonce;
    uint256 sellerAward;
    uint256 buyerCost;
    uint256 sellerCost;
    bytes32 evidenceCommitment;
    uint64 authEpoch;
    uint64 queueExpiry;
    bytes[] signatures;
}

struct VetoSig {
    address authority;
    bytes32 nonce;
    uint64 expiry;
    bytes signature;
}

/// @notice Owner authorization to reserve one of their vested claims as a
/// bond for a specific deal. The owner MUST be the claim's recipient; the
/// posting party cannot spend another wallet's claim. Bound to the exact
/// claim, target deal, amount, party, nonce and expiry. Matches the
/// ReserveExistingClaim row of the signed-policy action schema.
struct ReserveAuth {
    address owner;
    bytes32 sourceClaimId;
    uint256 amount;
    uint8 party; // 0 = claimant (buyer), 1 = respondent (seller)
    bytes32 nonce;
    uint64 expiresAt;
    bytes signature;
}

/// @notice All hub state in one storage struct so the dispute library takes a
/// single storage reference (delegatecall preserves hub context).
struct HubState {
    mapping(bytes32 => Deal) deals;
    mapping(bytes32 => Claim) claims;
    mapping(bytes32 => bool) usedAgreementNonce;
    mapping(bytes32 => bool) revokedTerms;
    mapping(bytes32 => bool) usedActionNonce;
    mapping(bytes32 => bool) usedAdmissionNonce;
    mapping(bytes32 => bool) usedRulingNonce;
    Ledger ledger;
    bool fundingPaused;
    uint64 pendingUnpauseAt;
    bool unpauseProposed;
}

/// @notice Locked domain identifiers, phases, claim kinds, typehashes and time
/// constants. Field order in type strings matches specs/phase2-threat-model.md.
library MidmanDK {
    // Phases (spec order).
    uint8 internal constant PH_AWAITING_DELIVERY = 0;
    uint8 internal constant PH_DELIVERED = 1;
    uint8 internal constant PH_SELF_RESOLUTION = 2;
    uint8 internal constant PH_AWAITING_ESCALATION = 3;
    uint8 internal constant PH_EVIDENCE = 4;
    uint8 internal constant PH_PRIMARY_REVIEW = 5;
    uint8 internal constant PH_FALLBACK_REVIEW = 6;
    uint8 internal constant PH_RULING_PENDING = 7;
    uint8 internal constant PH_DEADLOCK = 8;
    uint8 internal constant PH_SETTLED = 9;

    // Claim kinds.
    uint8 internal constant CK_BUYER_PF = 0;
    uint8 internal constant CK_SELLER_PF = 1;
    uint8 internal constant CK_PLATFORM_FEE = 2;
    uint8 internal constant CK_BUYER_BOND = 3;
    uint8 internal constant CK_SELLER_BOND = 4;
    uint8 internal constant CK_ARB_COST = 5;

    // Ruling origins.
    uint8 internal constant ORIGIN_PRIMARY = 0;
    uint8 internal constant ORIGIN_FALLBACK = 1;

    // Settlement outcomes.
    uint8 internal constant OUT_NON_DELIVERY = 0;
    uint8 internal constant OUT_RELEASE = 1;
    uint8 internal constant OUT_REFUND = 2;
    uint8 internal constant OUT_MUTUAL = 3;
    uint8 internal constant OUT_TIMEOUT = 4;
    uint8 internal constant OUT_RULING = 5;
    uint8 internal constant OUT_CATASTROPHIC = 6;

    // Time constants (P-05/P-06/P-09).
    uint32 internal constant SELF_RESOLUTION_SECONDS = 86_400;
    uint32 internal constant ESCALATION_WINDOW_SECONDS = 86_400;
    uint32 internal constant RESPONDENT_EVIDENCE_SECONDS = 86_400;
    uint256 internal constant CATASTROPHIC_ESCAPE_SECONDS = 5_184_000;
    uint256 internal constant PRIMARY_REVIEW_SECONDS = 604_800;
    uint256 internal constant FALLBACK_REVIEW_SECONDS = 604_800;
    uint32 internal constant DELIVERY_MIN_SECONDS = 3_600;
    uint32 internal constant DELIVERY_MAX_SECONDS = 2_592_000;
    uint32 internal constant INSPECTION_MAX_SECONDS = 1_209_600;
    uint64 internal constant READINESS_MAX_AGE_SECONDS = 7_200;
    // P-11: readiness is REQUIRED iff the pricing tier is <= 3h
    // (deliveryPeriodSeconds + inspectionPeriodSeconds <= 10,800); otherwise the
    // signed readiness policy must be a registered no-readiness policy.
    uint32 internal constant READINESS_TIER_MAX_SECONDS = 10_800;
    uint256 internal constant UNPAUSE_DELAY = 24 hours;
    uint8 internal constant VETO_QUORUM = 2;

    uint256 internal constant TIER1_MAX = 1_000_000_000;
    uint256 internal constant TIER2_MAX = 10_000_000_000;

    bytes4 internal constant EIP1271_MAGIC = 0x1626ba7e;

    bytes32 internal constant DEAL_TERMS_TYPEHASH = keccak256(
        "DealTerms(bytes32 dealId,uint32 termsVersion,address buyerAddress,address sellerAddress,address sellerPayoutAddress,address buyerRefundAddress,address buyerBondRefundAddress,address sellerBondRefundAddress,address token,uint256 principal,uint256 quotedPlatformFee,uint16 buyerFeeBps,bytes32 agreementHash,bytes32 feePolicyId,uint32 deliveryPeriodSeconds,uint32 inspectionPeriodSeconds,bytes32 categoryPolicyId,bytes32 readinessPolicyId,bytes32 readinessConsentHash,bytes32 evidencePolicyId,bytes32 bondPolicyId,bytes32 arbitrationPolicyId,bytes32 outagePolicyId,bytes32 catastrophicPolicyId,address platformFeeRecipient,address arbitrationCostRecipient,uint64 fundingDeadline,bytes32 nonce,bytes32 salt,address factory,address implementation,address custodyAddress)"
    );
    bytes32 internal constant REVOKE_TYPEHASH =
        keccak256("RevokeTerms(bytes32 dealId,bytes32 agreementDigest,address revoker,bytes32 nonce,uint64 expiresAt)");
    bytes32 internal constant DELIVER_TYPEHASH = keccak256(
        "MarkDelivered(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 manifestHash,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant DISPUTE_TYPEHASH = keccak256(
        "OpenDispute(bytes32 dealId,bytes32 agreementDigest,address actor,uint8 reasonCode,bytes32 initialCommitment,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant ESCALATE_TYPEHASH = keccak256(
        "EscalateDispute(bytes32 dealId,bytes32 agreementDigest,address actor,uint256 collateralAmount,uint8 collateralSource,bytes32 bondPolicyId,bytes32 claimId,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant APPROVE_TYPEHASH = keccak256(
        "ApproveSeller(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 terminalPolicyVersion,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant REFUND_TYPEHASH = keccak256(
        "RefundBuyer(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 terminalPolicyVersion,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant SETTLE_TYPEHASH = keccak256(
        "MutualSettlement(bytes32 dealId,bytes32 agreementDigest,uint256 sellerAward,uint256 buyerBondCost,uint256 sellerBondCost,uint8 expectedPhase,bytes32 settlementNonce,uint64 expiresAt)"
    );
    bytes32 internal constant EVIDENCE_TYPEHASH = keccak256(
        "EvidenceManifest(bytes32 dealId,bytes32 agreementDigest,address uploader,uint32 sequence,bytes32 prevCommitment,bytes32[] fileHashes,bytes32 metadataCommitment,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant RULING_TYPEHASH = keccak256(
        "Ruling(bytes32 dealId,bytes32 agreementDigest,bytes32 arbitrationPolicyId,uint8 origin,bytes32 rulingNonce,uint256 sellerAward,uint256 buyerBondCost,uint256 sellerBondCost,bytes32 evidenceCommitment,uint64 authEpoch,uint64 queueExpiry)"
    );
    bytes32 internal constant VETO_TYPEHASH =
        keccak256("VetoRuling(bytes32 dealId,bytes32 rulingDigest,address authority,bytes32 nonce,uint64 expiresAt)");
    bytes32 internal constant ADMISSION_TYPEHASH = keccak256(
        "FundingAdmission(bytes32 agreementDigest,bytes32 minPolicyId,bytes32 admissionNonce,uint64 expiresAt,bool expectedUnfunded)"
    );
    bytes32 internal constant ALLOWANCE_TYPEHASH = keccak256(
        "FundWithAllowance(bytes32 dealId,bytes32 agreementDigest,address payer,uint256 amount,bytes32 paymentSalt,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant BOND_INTENT_TYPEHASH = keccak256(
        "BondIntent(bytes32 dealId,bytes32 agreementDigest,address party,uint256 amount,bool useExistingClaim,bytes32 claimId,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant RESERVE_TYPEHASH = keccak256(
        "ReserveExistingClaim(bytes32 dealId,bytes32 agreementDigest,address owner,bytes32 sourceClaimId,uint256 amount,uint8 party,bytes32 nonce,uint64 expiresAt)"
    );
    bytes32 internal constant READINESS_TYPEHASH = keccak256(
        "ReadinessConsent(bytes32 dealId,bytes32 agreementDigest,address buyer,uint64 attestedAt,bytes32 nonce,uint64 expiresAt)"
    );
}

// ---- Errors ----
error Paused();
error BadTerms();
error AlreadyFunded();
error Revoked();
error Expired();
error BadSig();
error BadNonce();
error BadPhase();
error TooEarly();
error TooLate();
error DisputeExhausted();
error NoQuorum();
error BadAward();
error OutageUnknown();
error NotRole();
error NothingToRescue();
error NoClaim();

// ---- Events (indexer surface; always attributed to the hub) ----
event DealFunded(bytes32 indexed dealId, bytes32 agreementDigest, uint256 principal, uint256 funded);
event TermsRevoked(bytes32 indexed dealId, bytes32 agreementDigest);
event Delivered(bytes32 indexed dealId, uint64 deliveredAt, bytes32 manifestHash);
event Settled(
    bytes32 indexed dealId, uint8 outcome, uint256 sellerAward, uint256 earnedFee, uint256 buyerCost, uint256 sellerCost
);
event DisputeOpened(bytes32 indexed dealId, uint64 openedAt, uint64 escapeAt);
event Escalated(bytes32 indexed dealId, uint256 collateral, uint8 source);
event DisputeLapsed(bytes32 indexed dealId);
event BondPosted(bytes32 indexed dealId, uint8 party, uint256 amount, uint8 source);
event EvidenceCommitted(bytes32 indexed dealId, address uploader, uint32 sequence, bytes32 commitment);
event PhaseAdvanced(bytes32 indexed dealId, uint8 phase);
event RulingQueued(bytes32 indexed dealId, uint8 origin, uint64 executeAt, uint256 sellerAward);
event RulingVetoed(bytes32 indexed dealId, uint8 origin);
event DeadlockMarked(bytes32 indexed dealId);
event Escaped(bytes32 indexed dealId, uint256 buyerShare, uint256 sellerShare);
event Claimed(bytes32 indexed dealId, uint8 kind, address indexed recipient, uint256 amount);
event FundingPaused();
event FundingUnpauseProposed(uint64 effectiveAt);
event FundingUnpaused();
event ExcessRescued(address indexed to, uint256 amount);
