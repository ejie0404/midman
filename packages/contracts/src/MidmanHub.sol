// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Finance} from "./Finance.sol";
import {MidmanPolicies} from "./MidmanPolicies.sol";
import {HubDispute} from "./HubDispute.sol";
import {
    MidmanDK,
    HubState,
    DealTerms,
    Deal,
    Claim,
    Payment3009,
    AllowanceIntent,
    Admission,
    ReadinessAuth,
    RulingAuth,
    VetoSig,
    ReserveAuth,
    DealFunded,
    TermsRevoked,
    Claimed,
    FundingPaused,
    FundingUnpauseProposed,
    FundingUnpaused,
    ExcessRescued,
    Paused,
    BadTerms,
    AlreadyFunded,
    Revoked,
    Expired,
    BadSig,
    BadNonce,
    BadPhase,
    TooEarly,
    TooLate,
    NotRole,
    NothingToRescue,
    NoClaim
} from "./DealTypes.sol";

/// @notice Minimal EIP-3009 receive path used only for atomic deal funding.
interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice Hub custody for Midman V1 escrow. Selected by the Phase 2 default
/// rule (hub on tie/no-data; see specs/phase2-architecture.md). Holds all
/// state and funds; the dispute machine (T03-T23 settlement logic) executes
/// via DELEGATECALL to the immutable HubDispute library in hub context, so
/// this contract stays within EIP-170 while custody, domain, events and
/// liabilities remain on this single address.
contract MidmanHub is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    MidmanPolicies public immutable policies;

    HubState internal state;

    constructor(address usdc_, address policies_) EIP712("MidmanEscrow", "1") {
        require(usdc_ != address(0) && policies_ != address(0), BadTerms());
        require(IERC20Metadata(usdc_).decimals() == 6, BadTerms());
        usdc = IERC20(usdc_);
        policies = MidmanPolicies(policies_);
    }

    // ================= Signature helpers =================
    function _verify(address signer, bytes32 digest, bytes memory sig) internal view {
        if (signer.code.length > 0) {
            require(IERC1271(signer).isValidSignature(digest, sig) == MidmanDK.EIP1271_MAGIC, BadSig());
        } else {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
            require(err == ECDSA.RecoverError.NoError && recovered == signer, BadSig());
        }
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function agreementDigestOf(DealTerms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MidmanDK.DEAL_TERMS_TYPEHASH,
                    t.dealId,
                    t.termsVersion,
                    t.buyerAddress,
                    t.sellerAddress,
                    t.sellerPayoutAddress,
                    t.buyerRefundAddress,
                    t.buyerBondRefundAddress,
                    t.sellerBondRefundAddress,
                    t.token,
                    t.principal,
                    t.quotedPlatformFee,
                    t.buyerFeeBps,
                    t.agreementHash,
                    t.feePolicyId,
                    t.deliveryPeriodSeconds,
                    t.inspectionPeriodSeconds,
                    t.categoryPolicyId,
                    t.readinessPolicyId,
                    t.readinessConsentHash,
                    t.evidencePolicyId,
                    t.bondPolicyId,
                    t.arbitrationPolicyId,
                    t.outagePolicyId,
                    t.catastrophicPolicyId,
                    t.platformFeeRecipient,
                    t.arbitrationCostRecipient,
                    t.fundingDeadline,
                    t.nonce,
                    t.salt,
                    t.factory,
                    t.implementation,
                    t.custodyAddress
                )
            )
        );
    }

    /// @notice Exact EIP-712 digest for off-chain signing (relayers, SDKs).
    function actionDigest(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    // ================= T02 revoke (L-NONE) =================
    function revokeUnfundedTerms(
        DealTerms calldata t,
        address revoker,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig
    ) external {
        bytes32 digest = agreementDigestOf(t);
        require(!state.deals[t.dealId].funded, AlreadyFunded());
        require(revoker == t.buyerAddress || revoker == t.sellerAddress, BadSig());
        if (msg.sender != revoker) {
            require(_now() < expiresAt, Expired());
            bytes32 rdigest = _hashTypedDataV4(
                keccak256(abi.encode(MidmanDK.REVOKE_TYPEHASH, t.dealId, digest, revoker, nonce, expiresAt))
            );
            _verify(revoker, rdigest, sig);
        }
        state.revokedTerms[digest] = true;
        emit TermsRevoked(t.dealId, digest);
    }

    // ================= T01 fund (L-FUND) =================
    function fund(
        DealTerms calldata t,
        bytes calldata sigBuyer,
        bytes calldata sigSeller,
        Payment3009 calldata pay,
        AllowanceIntent calldata allowance,
        Admission calldata admission,
        ReadinessAuth calldata readiness
    ) external nonReentrant {
        require(!state.fundingPaused, Paused());
        require(!state.deals[t.dealId].funded, AlreadyFunded());
        require(!state.usedAgreementNonce[t.nonce], BadNonce());
        require(t.factory == address(0) && t.implementation == address(0), BadTerms());
        require(t.custodyAddress == address(this), BadTerms());
        require(t.token == address(usdc), BadTerms());
        require(t.buyerAddress != t.sellerAddress, BadTerms());
        require(t.buyerAddress != address(0) && t.sellerAddress != address(0), BadTerms());
        require(
            t.sellerPayoutAddress != address(0) && t.buyerRefundAddress != address(0)
                && t.buyerBondRefundAddress != address(0) && t.sellerBondRefundAddress != address(0),
            BadTerms()
        );

        bytes32 digest = agreementDigestOf(t);
        require(!state.revokedTerms[digest], Revoked());
        require(_now() < t.fundingDeadline, Expired());
        _verify(t.buyerAddress, digest, sigBuyer);
        _verify(t.sellerAddress, digest, sigSeller);

        require(t.principal >= Finance.MIN_PRINCIPAL, BadTerms());
        require(t.buyerFeeBps == 0 || t.buyerFeeBps == 5_000 || t.buyerFeeBps == 10_000, BadTerms());
        uint32 duration = t.deliveryPeriodSeconds + t.inspectionPeriodSeconds;
        require(t.quotedPlatformFee == Finance.ceilQuote(t.principal, duration), BadTerms());
        require(t.quotedPlatformFee <= t.principal, BadTerms());

        (bool feeExists,) = policies.feePolicies(t.feePolicyId);
        require(feeExists, BadTerms());
        (bool catExists,, uint32 catMin) = policies.categoryPolicies(t.categoryPolicyId);
        require(catExists, BadTerms());
        require(
            t.deliveryPeriodSeconds >= MidmanDK.DELIVERY_MIN_SECONDS
                && t.deliveryPeriodSeconds <= MidmanDK.DELIVERY_MAX_SECONDS,
            BadTerms()
        );
        require(
            t.inspectionPeriodSeconds >= catMin && t.inspectionPeriodSeconds <= MidmanDK.INSPECTION_MAX_SECONDS,
            BadTerms()
        );
        (bool readExists,, bool readRequired) = policies.readinessPolicies(t.readinessPolicyId);
        require(readExists, BadTerms());
        if (readRequired) {
            require(t.readinessConsentHash != bytes32(0), BadTerms());
            require(!state.usedActionNonce[readiness.nonce], BadNonce());
            require(_now() < readiness.expiresAt, Expired());
            require(
                readiness.attestedAt <= _now() && _now() - readiness.attestedAt <= MidmanDK.READINESS_MAX_AGE_SECONDS,
                Expired()
            );
            bytes32 rdigest = _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        MidmanDK.READINESS_TYPEHASH,
                        t.dealId,
                        digest,
                        t.buyerAddress,
                        readiness.attestedAt,
                        readiness.nonce,
                        readiness.expiresAt
                    )
                )
            );
            state.usedActionNonce[readiness.nonce] = true;
            _verify(t.buyerAddress, rdigest, readiness.signature);
        } else {
            require(t.readinessConsentHash == bytes32(0), BadTerms());
        }
        (bool evExists,) = policies.evidencePolicies(t.evidencePolicyId);
        require(evExists, BadTerms());
        (bool bondExists,,,) = policies.bondPolicies(t.bondPolicyId);
        require(bondExists, BadTerms());
        (bool arbExists,, uint8 tiersAllowed) = policies.arbitrationPolicies(t.arbitrationPolicyId);
        require(arbExists, BadTerms());
        (bool outExists,,,) = policies.outagePolicies(t.outagePolicyId);
        require(outExists, BadTerms());
        (bool escExists,) = policies.catastrophicPolicies(t.catastrophicPolicyId);
        require(escExists, BadTerms());
        require(t.platformFeeRecipient != address(0) && t.arbitrationCostRecipient != address(0), BadTerms());

        uint8 tier = t.principal <= MidmanDK.TIER1_MAX ? 0 : (t.principal <= MidmanDK.TIER2_MAX ? 1 : 2);
        require((tiersAllowed & (uint8(1) << tier)) != 0, BadTerms());

        require(!state.usedAdmissionNonce[admission.admissionNonce], BadNonce());
        require(_now() < admission.expiresAt, Expired());
        bytes32 adigest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MidmanDK.ADMISSION_TYPEHASH,
                    digest,
                    admission.minPolicyId,
                    admission.admissionNonce,
                    admission.expiresAt,
                    true
                )
            )
        );
        state.usedAdmissionNonce[admission.admissionNonce] = true;
        _verify(policies.admissionSigner(), adigest, admission.signature);

        uint256 prepaid = Finance.buyerFeeShare(t.quotedPlatformFee, t.buyerFeeBps);
        uint256 fundedAmount = t.principal + prepaid;

        state.usedAgreementNonce[t.nonce] = true;
        Deal storage d = state.deals[t.dealId];
        d.funded = true;
        d.phase = MidmanDK.PH_AWAITING_DELIVERY;
        d.termsHash = digest;
        d.buyer = t.buyerAddress;
        d.seller = t.sellerAddress;
        d.sellerPayout = t.sellerPayoutAddress;
        d.buyerRefund = t.buyerRefundAddress;
        d.buyerBondRefund = t.buyerBondRefundAddress;
        d.sellerBondRefund = t.sellerBondRefundAddress;
        d.principal = t.principal;
        d.quotedFee = t.quotedPlatformFee;
        d.buyerFeeBps = t.buyerFeeBps;
        d.prepaidBuyerFee = prepaid;
        d.deliveryPeriod = t.deliveryPeriodSeconds;
        d.inspectionPeriod = t.inspectionPeriodSeconds;
        d.bondPolicyId = t.bondPolicyId;
        d.arbitrationPolicyId = t.arbitrationPolicyId;
        d.outagePolicyId = t.outagePolicyId;
        d.platformFeeRecipient = t.platformFeeRecipient;
        d.arbitrationCostRecipient = t.arbitrationCostRecipient;
        d.fundedAt = _now();
        d.tier = tier;
        if (tier == 0) {
            d.primaryQuorum = 2;
            d.fallbackQuorum = 2;
            d.execDelay = 24 hours;
        } else if (tier == 1) {
            d.primaryQuorum = 3;
            d.fallbackQuorum = 3;
            d.execDelay = 48 hours;
        } else {
            d.primaryQuorum = 3;
            d.fallbackQuorum = 3;
            d.execDelay = 72 hours;
        }
        state.ledger.escrow += fundedAmount;

        if (pay.use3009) {
            bytes32 paymentNonce = keccak256(abi.encode(t.dealId, digest, pay.paymentSalt));
            IEIP3009(address(usdc)).receiveWithAuthorization(
                t.buyerAddress, address(this), fundedAmount, pay.validAfter, pay.validBefore, paymentNonce, pay.v, pay.r, pay.s
            );
        } else {
            require(_now() < allowance.expiresAt, Expired());
            require(!state.usedActionNonce[allowance.nonce], BadNonce());
            bytes32 idigest = _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        MidmanDK.ALLOWANCE_TYPEHASH,
                        t.dealId,
                        digest,
                        t.buyerAddress,
                        fundedAmount,
                        allowance.paymentSalt,
                        allowance.nonce,
                        allowance.expiresAt
                    )
                )
            );
            state.usedActionNonce[allowance.nonce] = true;
            _verify(t.buyerAddress, idigest, allowance.signature);
            usdc.safeTransferFrom(t.buyerAddress, address(this), fundedAmount);
        }
        emit DealFunded(t.dealId, digest, t.principal, fundedAmount);
    }

    // ================= Dispute-machine forwarders (delegate to HubDispute) =================
    // External behavior matches the spec transition table; logic executes in
    // hub context so state, funds, domain and events stay on this address.
    function _sep() internal view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function markDelivered(bytes32 dealId, bytes32 manifestHash, bytes32 nonce, uint64 expiresAt, bytes calldata sig)
        external
    {
        HubDispute.markDelivered(state, policies, _sep(), dealId, manifestHash, nonce, expiresAt, sig);
    }

    function refundForNonDelivery(bytes32 dealId) external {
        HubDispute.refundForNonDelivery(state, policies, dealId);
    }

    function approveSeller(bytes32 dealId, bytes32 terminalPolicyVersion, bytes32 nonce, uint64 expiresAt, bytes calldata sig)
        external
    {
        HubDispute.approveSeller(state, policies, _sep(), dealId, terminalPolicyVersion, nonce, expiresAt, sig);
    }

    function refundBuyer(bytes32 dealId, bytes32 terminalPolicyVersion, bytes32 nonce, uint64 expiresAt, bytes calldata sig)
        external
    {
        HubDispute.refundBuyer(state, policies, _sep(), dealId, terminalPolicyVersion, nonce, expiresAt, sig);
    }

    function mutualSettlement(
        bytes32 dealId,
        uint256 sellerAward,
        uint256 buyerCost,
        uint256 sellerCost,
        uint8 expectedPhase,
        bytes32 settlementNonce,
        uint64 expiresAt,
        bytes calldata sigBuyer,
        bytes calldata sigSeller
    ) external {
        HubDispute.mutualSettlement(
            state, policies, _sep(), dealId, sellerAward, buyerCost, sellerCost, expectedPhase, settlementNonce, expiresAt, sigBuyer, sigSeller
        );
    }

    function finalizeAfterTimeout(bytes32 dealId) external {
        HubDispute.finalizeAfterTimeout(state, policies, dealId);
    }

    function openDispute(bytes32 dealId, uint8 reasonCode, bytes32 initialCommitment, bytes32 nonce, uint64 expiresAt, bytes calldata sig)
        external
    {
        HubDispute.openDispute(state, policies, _sep(), dealId, reasonCode, initialCommitment, nonce, expiresAt, sig);
    }

    function advanceNegotiation(bytes32 dealId) external {
        HubDispute.advanceNegotiation(state, policies, dealId);
    }

    function escalate(
        bytes32 dealId,
        uint256 collateralAmount,
        uint8 collateralSource,
        bytes32 claimId,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig,
        ReserveAuth calldata reserve
    ) external nonReentrant {
        HubDispute.escalate(
            state, policies, usdc, _sep(), dealId, collateralAmount, collateralSource, claimId, nonce, expiresAt, sig, reserve
        );
    }

    function lapseDispute(bytes32 dealId) external {
        HubDispute.lapseDispute(state, policies, dealId);
    }

    function postRespondentBond(
        bytes32 dealId,
        uint256 amount,
        bool useExistingClaim,
        bytes32 claimId,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig,
        ReserveAuth calldata reserve
    ) external nonReentrant {
        HubDispute.postRespondentBond(
            state, policies, usdc, _sep(), dealId, amount, useExistingClaim, claimId, nonce, expiresAt, sig, reserve
        );
    }

    function submitEvidenceCommitment(
        bytes32 dealId,
        address uploader,
        uint32 sequence,
        bytes32 prevCommitment,
        bytes32[] calldata fileHashes,
        bytes32 metadataCommitment,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig
    ) external {
        HubDispute.submitEvidenceCommitment(
            state, policies, _sep(), dealId, uploader, sequence, prevCommitment, fileHashes, metadataCommitment, nonce, expiresAt, sig
        );
    }

    function advanceToPrimary(bytes32 dealId) external {
        HubDispute.advanceToPrimary(state, policies, dealId);
    }

    function activateFallback(bytes32 dealId) external {
        HubDispute.activateFallback(state, policies, dealId);
    }

    function queuePrimaryRuling(bytes32 dealId, RulingAuth calldata r) external {
        HubDispute.queueRuling(state, policies, _sep(), dealId, _withOrigin(r, MidmanDK.ORIGIN_PRIMARY));
    }

    function queueFallbackRuling(bytes32 dealId, RulingAuth calldata r) external {
        HubDispute.queueRuling(state, policies, _sep(), dealId, _withOrigin(r, MidmanDK.ORIGIN_FALLBACK));
    }

    function _withOrigin(RulingAuth calldata r, uint8 origin) internal pure returns (RulingAuth memory out) {
        out.origin = origin;
        out.rulingNonce = r.rulingNonce;
        out.sellerAward = r.sellerAward;
        out.buyerCost = r.buyerCost;
        out.sellerCost = r.sellerCost;
        out.evidenceCommitment = r.evidenceCommitment;
        out.authEpoch = r.authEpoch;
        out.queueExpiry = r.queueExpiry;
        out.signatures = r.signatures;
    }

    function vetoPrimaryRuling(bytes32 dealId, bytes32 rulingDigest, VetoSig[] calldata vsigs) external {
        HubDispute.veto(state, policies, _sep(), dealId, rulingDigest, vsigs, true);
    }

    function vetoFallbackRuling(bytes32 dealId, bytes32 rulingDigest, VetoSig[] calldata vsigs) external {
        HubDispute.veto(state, policies, _sep(), dealId, rulingDigest, vsigs, false);
    }

    function executeRuling(bytes32 dealId) external {
        HubDispute.executeRuling(state, dealId);
    }

    function markDeadlock(bytes32 dealId) external {
        HubDispute.markDeadlock(state, policies, dealId);
    }

    function catastrophicEscape(bytes32 dealId) external {
        HubDispute.catastrophicEscape(state, dealId);
    }

    // ================= T24 pull claims (fixed recipients) =================
    function claimFor(bytes32 dealId, uint8 kind) external nonReentrant {
        bytes32 id = keccak256(abi.encode(dealId, kind));
        Claim storage c = state.claims[id];
        require(c.amount > 0, NoClaim());
        uint256 amount = c.amount;
        address recipient = c.recipient;
        c.amount = 0;
        state.ledger.claims -= amount;
        usdc.safeTransfer(recipient, amount);
        emit Claimed(dealId, kind, recipient, amount);
    }

    // ================= T25/T26 funding-only pause =================
    modifier onlyGovernance() {
        require(msg.sender == policies.governance(), NotRole());
        _;
    }

    modifier onlyPauser() {
        require(msg.sender == policies.pauser(), NotRole());
        _;
    }

    function pauseNewFunding() external onlyPauser {
        state.fundingPaused = true;
        state.unpauseProposed = false;
        emit FundingPaused();
    }

    function proposeUnpause() external onlyGovernance {
        state.pendingUnpauseAt = _now() + uint64(MidmanDK.UNPAUSE_DELAY);
        state.unpauseProposed = true;
        emit FundingUnpauseProposed(state.pendingUnpauseAt);
    }

    function executeUnpause() external onlyGovernance {
        require(state.unpauseProposed && _now() >= state.pendingUnpauseAt, TooEarly());
        state.unpauseProposed = false;
        state.fundingPaused = false;
        emit FundingUnpaused();
    }

    // ================= Excess-only rescue =================
    function rescueExcess(uint256 amount) external onlyGovernance nonReentrant {
        uint256 excess = usdc.balanceOf(address(this)) - totalLiabilities();
        require(amount <= excess, NothingToRescue());
        usdc.safeTransfer(policies.treasury(), amount);
        emit ExcessRescued(policies.treasury(), amount);
    }

    // ================= Views =================
    function totalLiabilities() public view returns (uint256) {
        return state.ledger.escrow + state.ledger.bonds + state.ledger.claims;
    }

    function ledgerTotals() external view returns (uint256 escrow, uint256 bonds, uint256 claims) {
        return (state.ledger.escrow, state.ledger.bonds, state.ledger.claims);
    }

    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return state.deals[dealId];
    }

    function getClaim(bytes32 claimId) external view returns (address recipient, uint256 amount) {
        Claim storage c = state.claims[claimId];
        return (c.recipient, c.amount);
    }

    function claimIdOf(bytes32 dealId, uint8 kind) public pure returns (bytes32) {
        return keccak256(abi.encode(dealId, kind));
    }

    function isActionNonceUsed(bytes32 nonce) external view returns (bool) {
        return state.usedActionNonce[nonce];
    }

    function isAgreementNonceUsed(bytes32 nonce) external view returns (bool) {
        return state.usedAgreementNonce[nonce];
    }

    function isAdmissionNonceUsed(bytes32 nonce) external view returns (bool) {
        return state.usedAdmissionNonce[nonce];
    }

    function isRulingNonceUsed(bytes32 nonce) external view returns (bool) {
        return state.usedRulingNonce[nonce];
    }

    function isRevoked(bytes32 agreementDigest) external view returns (bool) {
        return state.revokedTerms[agreementDigest];
    }

    function fundingPaused() external view returns (bool) {
        return state.fundingPaused;
    }

    function settled(bytes32 dealId) external view returns (bool) {
        return state.deals[dealId].phase == MidmanDK.PH_SETTLED;
    }

    function escapeAt(bytes32 dealId) external view returns (uint64) {
        Deal storage d = state.deals[dealId];
        require(d.funded, BadPhase());
        return d.disputeOpenedAt + uint64(MidmanDK.CATASTROPHIC_ESCAPE_SECONDS);
    }

    /// @notice Authoritative outage-adjusted deadlines for every anchored clock
    /// (delivery, inspection, negotiation, escalation, evidence, primary,
    /// fallback). `available` is false when any required outage history or feed
    /// read is missing/malformed. escapeAt is deliberately NOT outage-adjusted.
    function effectiveDeadlines(bytes32 dealId)
        external
        view
        returns (
            uint64 delivery,
            uint64 inspection,
            uint64 negotiation,
            uint64 escalation,
            uint64 evidence,
            uint64 primary,
            uint64 fallbackEnd,
            bool available
        )
    {
        return HubDispute.effectiveDeadlines(state, policies, dealId);
    }
}
