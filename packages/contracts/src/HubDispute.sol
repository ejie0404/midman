// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Finance} from "./Finance.sol";
import {MidmanPolicies} from "./MidmanPolicies.sol";
import {
    MidmanDK,
    HubState,
    Deal,
    Claim,
    RulingAuth,
    VetoSig,
    ReserveAuth,
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
    DisputeExhausted,
    NoQuorum,
    BadAward,
    OutageUnknown,
    NotRole,
    NothingToRescue,
    NoClaim,
    DisputeOpened,
    Delivered,
    Escalated,
    DisputeLapsed,
    BondPosted,
    EvidenceCommitted,
    PhaseAdvanced,
    RulingQueued,
    RulingVetoed,
    DeadlockMarked,
    Escaped,
    Settled,
    Claimed
} from "./DealTypes.sol";

/// @notice Dispute machine + settlement cores for the Midman hub (T09-T23,
/// L-NORMAL, L-CATASTROPHIC allocation). Deployed once as an immutable
/// library and executed via DELEGATECALL in hub context, so custody, the
/// EIP-712 domain, events and liabilities stay on the single hub address
/// (EIP-170 size compliance without splitting custody or trust).
library HubDispute {
    using SafeERC20 for IERC20;

    // ================= Small helpers =================
    function now_() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function typedDigest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
    }

    function verify(address signer, bytes32 digest, bytes memory sig) internal view {
        if (signer.code.length > 0) {
            require(IERC1271(signer).isValidSignature(digest, sig) == MidmanDK.EIP1271_MAGIC, BadSig());
        } else {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
            require(err == ECDSA.RecoverError.NoError && recovered == signer, BadSig());
        }
    }

    /// @notice Direct caller authenticated by chain, else EIP-712 auth with
    /// unused nonce and unexpired deadline. Relayers gain no authority.
    function authOrDirect(
        HubState storage s,
        address actor,
        bytes32 digest,
        bytes memory sig,
        bytes32 nonce,
        uint64 expiresAt
    ) internal {
        if (msg.sender == actor) return;
        require(now_() < expiresAt, Expired());
        require(!s.usedActionNonce[nonce], BadNonce());
        s.usedActionNonce[nonce] = true;
    }

    function authOrDirectSig(
        HubState storage s,
        bytes32 domainSep,
        address actor,
        bytes32 structHash,
        bytes memory sig,
        bytes32 nonce,
        uint64 expiresAt
    ) internal {
        if (msg.sender == actor) return;
        require(now_() < expiresAt, Expired());
        require(!s.usedActionNonce[nonce], BadNonce());
        s.usedActionNonce[nonce] = true;
        verify(actor, typedDigest(domainSep, structHash), sig);
    }

    function active(HubState storage s, bytes32 dealId) internal view returns (Deal storage d) {
        d = s.deals[dealId];
        require(d.funded && d.phase != MidmanDK.PH_SETTLED, BadPhase());
    }

    /// @notice Every non-terminal phase transition retires outstanding
    /// mutual-settlement offers (expected-phase + counter), so an offer
    /// signed for an earlier phase instance can never become valid again.
    /// In particular pre-dispute DELIVERED and post-lapse DELIVERED are
    /// different offer epochs. Terminal settlement needs no invalidation.
    function transition(HubState storage s, bytes32 dealId, uint8 to) internal {
        Deal storage d = s.deals[dealId];
        d.phase = to;
        d.settlementNonce += 1;
        emit PhaseAdvanced(dealId, to);
    }

    /// @notice New collateral or a queued ruling also retires outstanding offers.
    function invalidateOffers(HubState storage s, bytes32 dealId) internal {
        s.deals[dealId].settlementNonce += 1;
    }

    // ================= Outage-adjusted deadlines (P-09) =================
    // One consistent algorithm for every adjustable clock. For an anchored
    // clock with anchor A and original deadline D0 = A + duration:
    //   downtime(A,E) = SUM over retained outages i of
    //                   max(0, min(E, end_i) - max(A, start_i))
    //   grace(A,E)    = GRACE * (# retained outages with overlap(A,E,i) > 0)
    //   E is the least fixpoint of  E = D0 + downtime(A,E) + grace(A,E)
    // This inherently extends for outages occurring INSIDE an already-extended
    // window and preserves the remaining usable time when an outage crosses the
    // original deadline. The feed's live trailing interval (ongoing or just
    // recovered) is merged once, deduped by exact interval. escapeAt NEVER
    // passes through here (fixed 60-day cutoff).
    //
    // Availability: available=false when the clock's anchor precedes
    // `prunedBefore`, when the ledger is saturated (> MAX_RETAINED), when the
    // fixpoint does not converge within MAX_PASSES, or when a required feed
    // read is malformed. Missing/uncertain history surfaces as UNKNOWN, never
    // as a shorter deadline.
    uint256 internal constant MAX_PASSES = 64;

    struct FeedStatus {
        bool ok;
        bool up;
        int256 answer;
        uint64 startedAt;
        uint64 updatedAt;
        uint80 roundId;
        uint80 answeredInRound;
    }

    /// @notice Strict latest-round read. Any staticcall failure, short/wrong
    /// return, zero round id, round inconsistency, zero/future startedAt or
    /// zero/future updatedAt yields ok=false (feed state UNKNOWN).
    function readFeed(MidmanPolicies pol) internal view returns (FeedStatus memory fs) {
        (bool success, bytes memory ret) = pol.sequencerFeed().staticcall(abi.encodeWithSignature("latestRoundData()"));
        if (!success || ret.length != 160) return fs;
        (uint80 rid, int256 ans, uint256 startedAt, uint256 updatedAt, uint80 air) =
            abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        if (rid == 0 || air != rid) return fs;
        if (startedAt == 0 || startedAt > block.timestamp) return fs;
        if (updatedAt == 0 || updatedAt > block.timestamp) return fs;
        fs.ok = true;
        fs.up = ans == 0;
        fs.answer = ans;
        fs.startedAt = uint64(startedAt);
        fs.updatedAt = uint64(updatedAt);
        fs.roundId = rid;
        fs.answeredInRound = air;
    }

    function feedUp(MidmanPolicies pol) internal view returns (bool) {
        FeedStatus memory fs = readFeed(pol);
        return fs.ok && fs.up;
    }

    function requireFeed(MidmanPolicies pol) internal view {
        require(feedUp(pol), OutageUnknown());
    }

    /// @notice Trailing outage interval straight from the feed (never reverts).
    /// ok=false means the read was malformed/unknown (deadline math must report
    /// unavailable). Ongoing outage: [startedAt, now]. Just recovered:
    /// [prevDownStart, latestStart]. Otherwise has=false. A missing prior round
    /// (all-zero data) is benign "none", not malformed.
    function liveTrailing(MidmanPolicies pol) internal view returns (bool ok, bool has, uint64 s, uint64 e) {
        FeedStatus memory fs = readFeed(pol);
        if (!fs.ok) return (false, false, 0, 0);
        if (!fs.up) return (true, true, fs.startedAt, now_());
        (bool ok2, bytes memory ret2) = pol.sequencerFeed().staticcall(
            abi.encodeWithSignature("getRoundData(uint80)", fs.answeredInRound - 1)
        );
        if (!ok2 || ret2.length != 160) return (false, false, 0, 0);
        (uint80 prid, int256 pans, uint256 pstart,, uint80 pair) =
            abi.decode(ret2, (uint80, int256, uint256, uint256, uint80));
        if (pans == 0 && pstart == 0) return (true, false, 0, 0);
        if (pstart == 0 || pstart > fs.startedAt) return (false, false, 0, 0);
        if (pair != 0 && pair != prid) return (false, false, 0, 0);
        if (pans != 1) return (true, false, 0, 0);
        return (true, true, uint64(pstart), fs.startedAt);
    }

    function graceOf(MidmanPolicies pol, bytes32 outagePolicyId) internal view returns (uint32 grace) {
        (bool exists,, uint32 g,) = pol.outagePolicies(outagePolicyId);
        require(exists, BadTerms());
        return g;
    }

    /// @notice Least fixpoint of E = D0 + downtime(A,E) + grace(A,E) over the
    /// retained ledger merged with the feed's live trailing interval.
    /// Accelerated iteration: while any intersecting interval is only partially
    /// covered by E, RHS-E is nondecreasing there, so no fixpoint can lie before
    /// the nearest such interval's end; jump E to it. Once every intersecting
    /// interval is fully covered, the equation is exact and one step closes it.
    /// Converges in at most one pass per interval end; non-convergence within
    /// MAX_PASSES reports available=false rather than a short deadline.
    function effectiveDeadline(MidmanPolicies pol, uint64 anchor, uint64 original, uint32 grace)
        internal
        view
        returns (uint64 eff, bool available)
    {
        if (pol.outageSaturated()) return (original, false);
        if (anchor < pol.prunedBefore()) return (original, false);

        // History completeness (coverage watermark). The retained ledger only
        // proves anything once it is audited up to the feed head: every
        // transition (down->up) since deployment must have been consumed by
        // reportOutage. An up head requires the watermark to equal it; a down
        // head is the ongoing outage, covered by live trailing, and requires
        // only its predecessor to be audited. Any gap => UNKNOWN, never a
        // shorter deadline. Coverage follows proxy phase boundaries
        // (MidmanPolicies.successorRound).
        {
            FeedStatus memory fs = readFeed(pol);
            if (!fs.ok) return (original, false);
            if (!pol.watermarkCovers(fs.roundId, fs.up)) return (original, false);
        }

        uint256 n = pol.outageCount();
        uint64[] memory starts = new uint64[](n);
        uint64[] memory ends = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            (starts[i], ends[i]) = pol.outageAt(i);
        }

        (bool liveOk, bool hasLive, uint64 ls, uint64 le) = liveTrailing(pol);
        if (!liveOk) return (original, false);
        if (hasLive) {
            for (uint256 i = 0; i < n; i++) {
                if (starts[i] == ls && ends[i] == le) {
                    hasLive = false; // counted once via the ledger
                    break;
                }
            }
        }

        uint64 e = original;
        bool converged = false;
        for (uint256 pass = 0; pass < MAX_PASSES; pass++) {
            uint256 dt = 0;
            uint256 gr = 0;
            uint64 minPartial = type(uint64).max;
            bool hasPartial = false;
            for (uint256 i = 0; i < n; i++) {
                if (starts[i] >= e || ends[i] <= anchor) continue;
                uint64 lo = starts[i] > anchor ? starts[i] : anchor;
                if (ends[i] <= e) {
                    dt += uint256(ends[i] - lo);
                } else {
                    dt += uint256(e - lo);
                    if (ends[i] < minPartial) minPartial = ends[i];
                    hasPartial = true;
                }
                gr += grace;
            }
            if (hasLive && ls < e && le > anchor) {
                uint64 lo = ls > anchor ? ls : anchor;
                if (le <= e) {
                    dt += uint256(le - lo);
                } else {
                    dt += uint256(e - lo);
                    if (le < minPartial) minPartial = le;
                    hasPartial = true;
                }
                gr += grace;
            }
            uint256 ne = uint256(original) + dt + gr;
            if (ne > type(uint64).max) return (original, false);
            if (ne <= e) {
                converged = true;
                break;
            }
            if (hasPartial) {
                // f is monotone and continuous with non-negative slope in
                // (e, minPartial): no fixpoint can lie before the nearest
                // partially covered interval end, so advancing there is safe.
                e = minPartial;
            } else {
                e = uint64(ne);
            }
        }
        if (!converged) return (original, false);
        return (e, true);
    }

    function inspectionEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        Deal storage d = s.deals[dealId];
        uint64 orig = d.deliveredAt + d.inspectionPeriod;
        return effectiveDeadline(pol, d.deliveredAt, orig, graceOf(pol, d.outagePolicyId));
    }

    function negotiationEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        Deal storage d = s.deals[dealId];
        uint64 orig = d.disputeOpenedAt + MidmanDK.SELF_RESOLUTION_SECONDS;
        return effectiveDeadline(pol, d.disputeOpenedAt, orig, graceOf(pol, d.outagePolicyId));
    }

    function escalationEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        Deal storage d = s.deals[dealId];
        uint64 orig = d.disputeOpenedAt + MidmanDK.SELF_RESOLUTION_SECONDS + MidmanDK.ESCALATION_WINDOW_SECONDS;
        return effectiveDeadline(pol, d.disputeOpenedAt, orig, graceOf(pol, d.outagePolicyId));
    }

    function evidenceEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        Deal storage d = s.deals[dealId];
        uint64 orig = d.escalatedAt + MidmanDK.RESPONDENT_EVIDENCE_SECONDS;
        return effectiveDeadline(pol, d.escalatedAt, orig, graceOf(pol, d.outagePolicyId));
    }

    function primaryEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        // The primary review window gets its own outage adjustment anchored
        // at the (already adjusted) evidence end: downtime during review
        // extends review, exactly like every other adjustable clock.
        (uint64 evEnd, bool av) = evidenceEff(s, pol, dealId);
        if (!av) return (0, false);
        uint64 orig = evEnd + uint64(MidmanDK.PRIMARY_REVIEW_SECONDS);
        return effectiveDeadline(pol, evEnd, orig, graceOf(pol, s.deals[dealId].outagePolicyId));
    }

    function fallbackEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        Deal storage d = s.deals[dealId];
        uint64 orig = d.fallbackStartedAt + uint64(MidmanDK.FALLBACK_REVIEW_SECONDS);
        return effectiveDeadline(pol, d.fallbackStartedAt, orig, graceOf(pol, d.outagePolicyId));
    }

    function cutoffOf(Deal storage d) internal view returns (uint64) {
        return d.disputeOpenedAt + uint64(MidmanDK.CATASTROPHIC_ESCAPE_SECONDS);
    }

    /// @notice Authoritative outage-adjusted deadline view for every anchored
    /// clock. `available` is false if any required ledger history or feed read
    /// is missing/malformed. escapeAt is intentionally NOT part of this view:
    /// it stays the fixed disputeOpenedAt + 5,184,000 cutoff.
    function effectiveDeadlines(HubState storage s, MidmanPolicies pol, bytes32 dealId)
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
        Deal storage d = s.deals[dealId];
        bool av;
        (delivery, av) = deliveryEff(s, pol, dealId);
        available = av;
        // A clock only gates the aggregate availability once it has started;
        // not-yet-started anchors report their nominal duration.
        (inspection, av) = inspectionEff(s, pol, dealId);
        if (d.deliveredAt != 0) available = available && av;
        (negotiation, av) = negotiationEff(s, pol, dealId);
        if (d.disputeOpenedAt != 0) available = available && av;
        (escalation, av) = escalationEff(s, pol, dealId);
        if (d.disputeOpenedAt != 0) available = available && av;
        (evidence, av) = evidenceEff(s, pol, dealId);
        if (d.escalatedAt != 0) available = available && av;
        (primary, av) = primaryEff(s, pol, dealId);
        if (d.escalatedAt != 0) available = available && av;
        (fallbackEnd, av) = fallbackEff(s, pol, dealId);
        if (d.fallbackStartedAt != 0) available = available && av;
    }

    /// @notice Permissionless materialization of derived phases. Never extends
    /// a clock, never pays out. Skips time-derived advances while the feed is
    /// down/unknown so admission actions stay fail-open (P-09).
    function normalize(HubState storage s, MidmanPolicies pol, bytes32 dealId) internal {
        Deal storage d = s.deals[dealId];
        if (!d.funded || d.phase == MidmanDK.PH_SETTLED) return;
        if (!feedUp(pol)) return;
        uint64 t = now_();
        if (d.phase == MidmanDK.PH_SELF_RESOLUTION) {
            (uint64 ne, bool av) = negotiationEff(s, pol, dealId);
            if (av && t >= ne) transition(s, dealId, MidmanDK.PH_AWAITING_ESCALATION);
        }
        if (d.phase == MidmanDK.PH_EVIDENCE) {
            (uint64 ee, bool av) = evidenceEff(s, pol, dealId);
            uint64 cutoff = cutoffOf(d);
            if (av && t >= ee && t < cutoff) transition(s, dealId, MidmanDK.PH_PRIMARY_REVIEW);
        }
        if (d.phase == MidmanDK.PH_PRIMARY_REVIEW && !d.rulingQueued) {
            (uint64 pEnd, bool av) = primaryEff(s, pol, dealId);
            uint64 cutoff = cutoffOf(d);
            if (av && t >= pEnd && t < cutoff) {
                d.fallbackStartedAt = pEnd;
                transition(s, dealId, MidmanDK.PH_FALLBACK_REVIEW);
            }
        }
        if (d.phase == MidmanDK.PH_FALLBACK_REVIEW && !d.rulingQueued) {
            (uint64 fe, bool av) = fallbackEff(s, pol, dealId);
            if (av && t >= fe) transition(s, dealId, MidmanDK.PH_DEADLOCK);
        }
    }

    // ================= Settlement cores =================
    function claimIdOf(bytes32 dealId, uint8 kind) internal pure returns (bytes32) {
        return keccak256(abi.encode(dealId, kind));
    }

    function addClaim(HubState storage s, bytes32 dealId, uint8 kind, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        // A nonzero entitlement must never silently vanish: with fund-time
        // recipient validation this is unreachable, but dropping it here
        // would convert owed funds into rescuable "excess".
        require(recipient != address(0), BadTerms());
        bytes32 id = claimIdOf(dealId, kind);
        Claim storage c = s.claims[id];
        if (c.recipient == address(0)) c.recipient = recipient;
        require(c.recipient == recipient, BadTerms());
        c.amount += amount;
        s.ledger.claims += amount;
        emit Claimed(dealId, kind, recipient, c.amount);
    }

    /// @notice Allocate L-NORMAL entitlements once. Moves liabilities from
    /// active buckets into fixed-recipient claims; creates no value.
    function settleNormal(
        HubState storage s,
        bytes32 dealId,
        uint256 sellerAward,
        uint256 buyerCost,
        uint256 sellerCost,
        uint8 outcome
    ) internal {
        Deal storage d = s.deals[dealId];
        require(sellerAward <= d.principal, BadAward());
        require(buyerCost <= d.claimantBond && sellerCost <= d.respondentBond, BadAward());
        uint256 e = Finance.earnedFee(d.quotedFee, sellerAward, d.principal);
        uint256 bFee = Finance.buyerFeeShare(e, d.buyerFeeBps);
        uint256 sFee = e - bFee;
        uint256 buyerPF = d.principal - sellerAward + (d.prepaidBuyerFee - bFee);
        uint256 sellerPF = sellerAward - sFee;
        uint256 funded = d.principal + d.prepaidBuyerFee;

        s.ledger.escrow -= funded;
        s.ledger.bonds -= (d.claimantBond + d.respondentBond);
        d.phase = MidmanDK.PH_SETTLED;
        d.rulingQueued = false;

        addClaim(s, dealId, MidmanDK.CK_BUYER_PF, d.buyerRefund, buyerPF);
        addClaim(s, dealId, MidmanDK.CK_SELLER_PF, d.sellerPayout, sellerPF);
        addClaim(s, dealId, MidmanDK.CK_PLATFORM_FEE, d.platformFeeRecipient, e);
        addClaim(s, dealId, MidmanDK.CK_BUYER_BOND, d.buyerBondRefund, d.claimantBond - buyerCost);
        addClaim(s, dealId, MidmanDK.CK_SELLER_BOND, d.sellerBondRefund, d.respondentBond - sellerCost);
        addClaim(s, dealId, MidmanDK.CK_ARB_COST, d.arbitrationCostRecipient, buyerCost + sellerCost);
        emit Settled(dealId, outcome, sellerAward, e, buyerCost, sellerCost);
    }

    function settleCatastrophic(HubState storage s, bytes32 dealId) internal {
        Deal storage d = s.deals[dealId];
        (uint256 buyerShare, uint256 sellerShare) = Finance.catastrophicSplit(d.principal);
        uint256 funded = d.principal + d.prepaidBuyerFee;
        s.ledger.escrow -= funded;
        s.ledger.bonds -= (d.claimantBond + d.respondentBond);
        d.phase = MidmanDK.PH_SETTLED;
        d.rulingQueued = false;
        addClaim(s, dealId, MidmanDK.CK_BUYER_PF, d.buyerRefund, buyerShare + d.prepaidBuyerFee);
        addClaim(s, dealId, MidmanDK.CK_SELLER_PF, d.sellerPayout, sellerShare);
        addClaim(s, dealId, MidmanDK.CK_BUYER_BOND, d.buyerBondRefund, d.claimantBond);
        addClaim(s, dealId, MidmanDK.CK_SELLER_BOND, d.sellerBondRefund, d.respondentBond);
        emit Settled(dealId, MidmanDK.OUT_CATASTROPHIC, sellerShare, 0, 0, 0);
        emit Escaped(dealId, buyerShare, sellerShare);
    }

    // ================= T09 openDispute (L-NONE) =================
    function openDispute(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
        bytes32 dealId,
        uint8 reasonCode,
        bytes32 initialCommitment,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig
    ) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == MidmanDK.PH_DELIVERED, BadPhase());
        require(!d.disputeUsed, DisputeExhausted());
        {
            // Admission is fail-open: if history/feed is unavailable, admit
            // against the ORIGINAL inspection deadline, never a shortened one.
            (uint64 eff, bool av) = inspectionEff(s, pol, dealId);
            require(now_() < (av ? eff : d.deliveredAt + d.inspectionPeriod), TooLate());
        }
        bytes32 structHash = keccak256(
            abi.encode(
                MidmanDK.DISPUTE_TYPEHASH, dealId, d.termsHash, d.buyer, reasonCode, initialCommitment, nonce, expiresAt
            )
        );
        authOrDirectSig(s, domainSep, d.buyer, structHash, sig, nonce, expiresAt);
        d.disputeUsed = true;
        d.disputeOpenedAt = now_();
        transition(s, dealId, MidmanDK.PH_SELF_RESOLUTION);
        emit DisputeOpened(dealId, d.disputeOpenedAt, cutoffOf(d));
    }

    // ================= T10 advanceNegotiation (L-NONE) =================
    function advanceNegotiation(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        require(d.phase == MidmanDK.PH_SELF_RESOLUTION, BadPhase());
        requireFeed(pol);
        (uint64 ne, bool av) = negotiationEff(s, pol, dealId);
        require(av, OutageUnknown());
        require(now_() >= ne, TooEarly());
        transition(s, dealId, MidmanDK.PH_AWAITING_ESCALATION);
    }

    // ================= T11 escalate + claimant bond (L-BOND) =================
    function escalate(
        HubState storage s,
        MidmanPolicies pol,
        IERC20 usdc,
        bytes32 domainSep,
        bytes32 dealId,
        uint256 collateralAmount,
        uint8 collateralSource,
        bytes32 claimId,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig,
        ReserveAuth calldata reserve
    ) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(
            d.phase == MidmanDK.PH_SELF_RESOLUTION || d.phase == MidmanDK.PH_AWAITING_ESCALATION, BadPhase()
        );
        uint64 cutoff = cutoffOf(d);
        {
            (uint64 ne, bool avN) = negotiationEff(s, pol, dealId);
            (uint64 ee, bool avE) = escalationEff(s, pol, dealId);
            require(avN && avE, OutageUnknown());
            require(now_() >= ne && now_() < ee && now_() < cutoff, BadPhase());
        }
        (, , uint256 requiredClaimant,) = pol.bondPolicies(d.bondPolicyId);
        require(collateralAmount == requiredClaimant && collateralAmount >= Finance.MIN_BOND, BadTerms());
        if (!(msg.sender == d.buyer && collateralSource == 0 && sig.length == 0)) {
            require(now_() < expiresAt, Expired());
            require(!s.usedActionNonce[nonce], BadNonce());
            s.usedActionNonce[nonce] = true;
            bytes32 structHash = keccak256(
                abi.encode(
                    MidmanDK.ESCALATE_TYPEHASH,
                    dealId,
                    d.termsHash,
                    d.buyer,
                    collateralAmount,
                    collateralSource,
                    d.bondPolicyId,
                    claimId,
                    nonce,
                    expiresAt
                )
            );
            verify(d.buyer, typedDigest(domainSep, structHash), sig);
        }
        d.escalatedAt = now_();
        d.claimantBond = collateralAmount;
        transition(s, dealId, MidmanDK.PH_EVIDENCE);
        if (collateralSource == 0) {
            usdc.safeTransferFrom(d.buyer, address(this), collateralAmount);
            s.ledger.bonds += collateralAmount;
        } else {
            reserveClaim(s, domainSep, dealId, d.termsHash, claimId, collateralAmount, d.buyerBondRefund, 0, reserve);
        }
        emit Escalated(dealId, collateralAmount, collateralSource);
        emit BondPosted(dealId, 0, collateralAmount, collateralSource);
    }

    /// @notice Move a vested, unencumbered claim liability into the bond bucket.
    /// The claim's RECIPIENT must authorize via ReserveExistingClaim, bound to
    /// the exact claim, target deal, amount, party, nonce and expiry. The
    /// posting party can never spend another wallet's claim, even when the
    /// deal's bond-refund address names that wallet: without the owner's
    /// signature the reservation reverts.
    function reserveClaim(
        HubState storage s,
        bytes32 domainSep,
        bytes32 dealId,
        bytes32 agreementDigest,
        bytes32 claimId,
        uint256 amount,
        address expectedRecipient,
        uint8 party,
        ReserveAuth calldata auth
    ) internal {
        require(auth.sourceClaimId == claimId, BadTerms());
        require(auth.amount == amount, BadTerms());
        require(auth.party == party, BadTerms());
        require(auth.owner == expectedRecipient, BadTerms());
        require(now_() < auth.expiresAt, Expired());
        require(!s.usedActionNonce[auth.nonce], BadNonce());
        s.usedActionNonce[auth.nonce] = true;
        bytes32 structHash = keccak256(
            abi.encode(
                MidmanDK.RESERVE_TYPEHASH,
                dealId,
                agreementDigest,
                auth.owner,
                auth.sourceClaimId,
                auth.amount,
                auth.party,
                auth.nonce,
                auth.expiresAt
            )
        );
        verify(auth.owner, typedDigest(domainSep, structHash), auth.signature);
        Claim storage c = s.claims[claimId];
        require(c.recipient == auth.owner && c.amount >= amount, BadTerms());
        c.amount -= amount;
        s.ledger.claims -= amount;
        s.ledger.bonds += amount;
    }

    // ================= T12 lapse (L-NONE) =================
    function lapseDispute(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(
            d.phase == MidmanDK.PH_SELF_RESOLUTION || d.phase == MidmanDK.PH_AWAITING_ESCALATION, BadPhase()
        );
        requireFeed(pol);
        (uint64 ee, bool av) = escalationEff(s, pol, dealId);
        require(av, OutageUnknown());
        require(now_() >= ee, TooEarly());
        transition(s, dealId, MidmanDK.PH_DELIVERED); // anchor preserved; disputeUsed stays true
        emit DisputeLapsed(dealId);
    }

    // ================= T13 respondent bond (L-BOND, optional) =================
    function postRespondentBond(
        HubState storage s,
        MidmanPolicies pol,
        IERC20 usdc,
        bytes32 domainSep,
        bytes32 dealId,
        uint256 amount,
        bool useExistingClaim,
        bytes32 claimId,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig,
        ReserveAuth calldata reserve
    ) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == MidmanDK.PH_EVIDENCE, BadPhase());
        uint64 cutoff = cutoffOf(d);
        {
            (uint64 ee, bool av) = evidenceEff(s, pol, dealId);
            require(av, OutageUnknown());
            require(now_() < ee && now_() < cutoff, BadPhase());
        }
        require(d.respondentBond == 0, BadTerms());
        (, , , uint256 requiredRespondent) = pol.bondPolicies(d.bondPolicyId);
        require(amount == requiredRespondent && amount >= Finance.MIN_BOND, BadTerms());
        if (!(msg.sender == d.seller && !useExistingClaim && sig.length == 0)) {
            require(now_() < expiresAt, Expired());
            require(!s.usedActionNonce[nonce], BadNonce());
            s.usedActionNonce[nonce] = true;
            bytes32 structHash = keccak256(
                abi.encode(
                    MidmanDK.BOND_INTENT_TYPEHASH,
                    dealId,
                    d.termsHash,
                    d.seller,
                    amount,
                    useExistingClaim,
                    claimId,
                    nonce,
                    expiresAt
                )
            );
            verify(d.seller, typedDigest(domainSep, structHash), sig);
        }
        d.respondentBond = amount;
        invalidateOffers(s, dealId);
        if (!useExistingClaim) {
            usdc.safeTransferFrom(d.seller, address(this), amount);
            s.ledger.bonds += amount;
        } else {
            reserveClaim(s, domainSep, dealId, d.termsHash, claimId, amount, d.sellerBondRefund, 1, reserve);
        }
        emit BondPosted(dealId, 1, amount, useExistingClaim ? 1 : 0);
    }

    // ================= T14 evidence commitments (append-only) =================
    function submitEvidenceCommitment(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
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
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == MidmanDK.PH_EVIDENCE, BadPhase());
        uint64 cutoff = cutoffOf(d);
        {
            (uint64 ee, bool av) = evidenceEff(s, pol, dealId);
            require(av, OutageUnknown());
            require(now_() < ee && now_() < cutoff, BadPhase());
        }
        require(uploader == d.buyer || uploader == d.seller, BadTerms());
        require(d.claimantBond > 0, BadPhase());
        require(sequence == d.manifestCount && prevCommitment == d.manifestHead, BadNonce());
        bytes32 filesHash = keccak256(abi.encodePacked(fileHashes));
        bytes32 commitment =
            keccak256(abi.encode(dealId, d.termsHash, uploader, sequence, prevCommitment, filesHash, metadataCommitment));
        bytes32 structHash = keccak256(
            abi.encode(
                MidmanDK.EVIDENCE_TYPEHASH,
                dealId,
                d.termsHash,
                uploader,
                sequence,
                prevCommitment,
                filesHash,
                metadataCommitment,
                nonce,
                expiresAt
            )
        );
        authOrDirectSig(s, domainSep, uploader, structHash, sig, nonce, expiresAt);
        d.manifestHead = commitment;
        d.manifestCount += 1;
        emit EvidenceCommitted(dealId, uploader, sequence, commitment);
    }

    // ================= T15/T16 progression =================
    function advanceToPrimary(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        if (d.phase == MidmanDK.PH_PRIMARY_REVIEW) return; // already materialized
        require(d.phase == MidmanDK.PH_EVIDENCE, BadPhase());
        requireFeed(pol);
        uint64 cutoff = cutoffOf(d);
        {
            (uint64 ee, bool av) = evidenceEff(s, pol, dealId);
            require(av, OutageUnknown());
            require(now_() >= ee && now_() < cutoff, BadPhase());
        }
        transition(s, dealId, MidmanDK.PH_PRIMARY_REVIEW);
    }

    function activateFallback(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        if (d.phase == MidmanDK.PH_FALLBACK_REVIEW) return; // already materialized
        require(d.phase == MidmanDK.PH_PRIMARY_REVIEW && !d.rulingQueued, BadPhase());
        requireFeed(pol);
        uint64 cutoff = cutoffOf(d);
        (uint64 pEnd, bool av) = primaryEff(s, pol, dealId);
        require(av, OutageUnknown());
        require(now_() >= pEnd && now_() < cutoff, BadPhase());
        d.fallbackStartedAt = pEnd;
        transition(s, dealId, MidmanDK.PH_FALLBACK_REVIEW);
    }

    // ================= T17/T18 queue rulings (quorum-enforced) =================
    function queueRuling(HubState storage s, MidmanPolicies pol, bytes32 domainSep, bytes32 dealId, RulingAuth calldata r)
        external
    {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(!s.usedRulingNonce[r.rulingNonce], BadNonce());
        require(now_() < r.queueExpiry, Expired());
        uint64 cutoff = cutoffOf(d);
        requireFeed(pol);
        uint8 quorum;
        if (r.origin == MidmanDK.ORIGIN_PRIMARY) {
            require(d.phase == MidmanDK.PH_PRIMARY_REVIEW, BadPhase());
            (uint64 pEnd, bool av) = primaryEff(s, pol, dealId);
            require(av, OutageUnknown());
            require(now_() < pEnd && now_() < cutoff, BadPhase());
            quorum = d.primaryQuorum;
        } else if (r.origin == MidmanDK.ORIGIN_FALLBACK) {
            require(d.phase == MidmanDK.PH_FALLBACK_REVIEW, BadPhase());
            (uint64 fEnd, bool av) = fallbackEff(s, pol, dealId);
            require(av, OutageUnknown());
            require(now_() < fEnd && now_() < cutoff, BadPhase());
            quorum = d.fallbackQuorum;
        } else {
            revert BadAward();
        }
        require(r.sellerAward <= d.principal, BadAward());
        (uint256 expBuyer, uint256 expSeller) =
            Finance.bondCosts(d.principal, r.sellerAward, d.claimantBond, d.respondentBond);
        require(r.buyerCost == expBuyer && r.sellerCost == expSeller, BadAward());
        require(r.authEpoch == pol.authEpoch(), BadTerms());
        bytes32 digest = typedDigest(
            domainSep,
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH,
                    dealId,
                    d.termsHash,
                    d.arbitrationPolicyId,
                    r.origin,
                    r.rulingNonce,
                    r.sellerAward,
                    r.buyerCost,
                    r.sellerCost,
                    r.evidenceCommitment,
                    r.authEpoch,
                    r.queueExpiry
                )
            )
        );
        checkPanelQuorum(pol, digest, r.signatures, quorum, r.origin, r.authEpoch);
        uint64 executeAt = now_() + d.execDelay;
        require(executeAt < cutoff, TooLate());
        s.usedRulingNonce[r.rulingNonce] = true;
        d.rulingQueued = true;
        d.rulingOrigin = r.origin;
        d.rulingExecuteAt = executeAt;
        d.rulingEpoch = r.authEpoch;
        d.rulingSellerAward = r.sellerAward;
        d.rulingBuyerCost = r.buyerCost;
        d.rulingSellerCost = r.sellerCost;
        d.rulingDigest = digest;
        transition(s, dealId, MidmanDK.PH_RULING_PENDING);
        emit RulingQueued(dealId, r.origin, executeAt, r.sellerAward);
    }

    function checkPanelQuorum(
        MidmanPolicies pol,
        bytes32 digest,
        bytes[] calldata sigs,
        uint8 quorum,
        uint8 origin,
        uint64 epoch
    ) internal view {
        require(sigs.length >= quorum, NoQuorum());
        address[] memory seen = new address[](sigs.length);
        uint256 distinct = 0;
        for (uint256 i = 0; i < sigs.length; i++) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sigs[i]);
            require(err == ECDSA.RecoverError.NoError, BadSig());
            bool member = origin == MidmanDK.ORIGIN_PRIMARY ? pol.isPrimary(epoch, signer) : pol.isFallback(epoch, signer);
            require(member, NoQuorum());
            for (uint256 j = 0; j < distinct; j++) require(seen[j] != signer, BadNonce());
            seen[distinct++] = signer;
        }
        require(distinct >= quorum, NoQuorum());
    }

    // ================= T19/T20 vetoes (cancel-only) =================
    function veto(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
        bytes32 dealId,
        bytes32 rulingDigest,
        VetoSig[] calldata vsigs,
        bool primary
    ) external {
        Deal storage d = active(s, dealId);
        require(d.phase == MidmanDK.PH_RULING_PENDING && d.rulingQueued, BadPhase());
        require(
            (primary && d.rulingOrigin == MidmanDK.ORIGIN_PRIMARY)
                || (!primary && d.rulingOrigin == MidmanDK.ORIGIN_FALLBACK),
            BadPhase()
        );
        uint64 cutoff = cutoffOf(d);
        require(now_() < d.rulingExecuteAt && now_() < cutoff, BadPhase());
        require(rulingDigest == d.rulingDigest, BadTerms());
        require(vsigs.length >= MidmanDK.VETO_QUORUM, NoQuorum());
        address[] memory seen = new address[](vsigs.length);
        uint256 distinct = 0;
        for (uint256 i = 0; i < vsigs.length; i++) {
            require(now_() < vsigs[i].expiry, Expired());
            require(!s.usedActionNonce[vsigs[i].nonce], BadNonce());
            bytes32 vdigest = typedDigest(
                domainSep,
                keccak256(
                    abi.encode(
                        MidmanDK.VETO_TYPEHASH, dealId, rulingDigest, vsigs[i].authority, vsigs[i].nonce, vsigs[i].expiry
                    )
                )
            );
            s.usedActionNonce[vsigs[i].nonce] = true;
            verify(vsigs[i].authority, vdigest, vsigs[i].signature);
            require(pol.isVeto(vsigs[i].authority), NoQuorum());
            for (uint256 j = 0; j < distinct; j++) require(seen[j] != vsigs[i].authority, BadNonce());
            seen[distinct++] = vsigs[i].authority;
        }
        require(distinct >= MidmanDK.VETO_QUORUM, NoQuorum());
        uint8 origin = d.rulingOrigin;
        d.rulingQueued = false;
        if (primary) {
            d.fallbackStartedAt = now_();
            transition(s, dealId, MidmanDK.PH_FALLBACK_REVIEW);
        } else {
            // Cancel-only path: if history is unavailable, keep the clock open
            // in fallback review rather than reverting or forcing deadlock.
            (uint64 fe, bool av) = fallbackEff(s, pol, dealId);
            if (av && now_() >= fe) transition(s, dealId, MidmanDK.PH_DEADLOCK);
            else transition(s, dealId, MidmanDK.PH_FALLBACK_REVIEW);
        }
        emit RulingVetoed(dealId, origin);
    }

    // ================= T21 execute ruling =================
    function executeRuling(HubState storage s, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        require(d.phase == MidmanDK.PH_RULING_PENDING && d.rulingQueued, BadPhase());
        uint64 cutoff = cutoffOf(d);
        require(now_() >= d.rulingExecuteAt && now_() < cutoff, BadPhase());
        // No epoch recheck: a validly queued award survives rotation unless vetoed (P-07).
        settleNormal(s, dealId, d.rulingSellerAward, d.rulingBuyerCost, d.rulingSellerCost, MidmanDK.OUT_RULING);
    }

    // ================= T22 deadlock =================
    function markDeadlock(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        if (d.phase == MidmanDK.PH_DEADLOCK) return; // already materialized
        require(d.phase == MidmanDK.PH_FALLBACK_REVIEW && !d.rulingQueued, BadPhase());
        requireFeed(pol);
        (uint64 fe, bool av) = fallbackEff(s, pol, dealId);
        require(av, OutageUnknown());
        require(now_() >= fe, TooEarly());
        transition(s, dealId, MidmanDK.PH_DEADLOCK);
        emit DeadlockMarked(dealId);
    }

    function deliveryEff(HubState storage s, MidmanPolicies pol, bytes32 dealId)
        internal
        view
        returns (uint64, bool)
    {
        Deal storage d = s.deals[dealId];
        uint64 orig = d.fundedAt + d.deliveryPeriod;
        return effectiveDeadline(pol, d.fundedAt, orig, graceOf(pol, d.outagePolicyId));
    }

    // ================= T03 markDelivered (L-NONE) =================
    function markDelivered(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
        bytes32 dealId,
        bytes32 manifestHash,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig
    ) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == MidmanDK.PH_AWAITING_DELIVERY, BadPhase());
        {
            (uint64 de, bool av) = deliveryEff(s, pol, dealId);
            require(av, OutageUnknown());
            require(now_() < de, TooLate());
        }
        require(manifestHash != bytes32(0), BadTerms());
        bytes32 structHash = keccak256(
            abi.encode(MidmanDK.DELIVER_TYPEHASH, dealId, d.termsHash, d.seller, manifestHash, nonce, expiresAt)
        );
        authOrDirectSig(s, domainSep, d.seller, structHash, sig, nonce, expiresAt);
        d.deliveredAt = now_();
        d.deliveryManifest = manifestHash;
        transition(s, dealId, MidmanDK.PH_DELIVERED);
        emit Delivered(dealId, d.deliveredAt, manifestHash);
    }

    // ================= T04 non-delivery (L-NORMAL S=0) =================
    function refundForNonDelivery(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == MidmanDK.PH_AWAITING_DELIVERY, BadPhase());
        requireFeed(pol);
        (uint64 de, bool av) = deliveryEff(s, pol, dealId);
        require(av, OutageUnknown());
        require(now_() >= de, TooEarly());
        settleNormal(s, dealId, 0, 0, 0, MidmanDK.OUT_NON_DELIVERY);
    }

    // ================= T05 buyer release (L-NORMAL S=P, bonds refunded) =================
    function approveSeller(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
        bytes32 dealId,
        bytes32 terminalPolicyVersion,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig
    ) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        bytes32 structHash = keccak256(
            abi.encode(MidmanDK.APPROVE_TYPEHASH, dealId, d.termsHash, d.buyer, terminalPolicyVersion, nonce, expiresAt)
        );
        authOrDirectSig(s, domainSep, d.buyer, structHash, sig, nonce, expiresAt);
        invalidateOffers(s, dealId);
        settleNormal(s, dealId, d.principal, 0, 0, MidmanDK.OUT_RELEASE);
    }

    // ================= T06 seller refund (L-NORMAL S=0, bonds refunded) =================
    function refundBuyer(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
        bytes32 dealId,
        bytes32 terminalPolicyVersion,
        bytes32 nonce,
        uint64 expiresAt,
        bytes calldata sig
    ) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        bytes32 structHash = keccak256(
            abi.encode(MidmanDK.REFUND_TYPEHASH, dealId, d.termsHash, d.seller, terminalPolicyVersion, nonce, expiresAt)
        );
        authOrDirectSig(s, domainSep, d.seller, structHash, sig, nonce, expiresAt);
        invalidateOffers(s, dealId);
        settleNormal(s, dealId, 0, 0, 0, MidmanDK.OUT_REFUND);
    }

    // ================= T07 mutual settlement (bilateral bounded bonds) =================
    function mutualSettlement(
        HubState storage s,
        MidmanPolicies pol,
        bytes32 domainSep,
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
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == expectedPhase, BadPhase());
        require(settlementNonce == bytes32(d.settlementNonce), BadNonce());
        require(now_() < expiresAt, Expired());
        require(sellerAward <= d.principal, BadAward());
        require(buyerCost <= d.claimantBond && sellerCost <= d.respondentBond, BadAward());
        bytes32 digest = typedDigest(
            domainSep,
            keccak256(
                abi.encode(
                    MidmanDK.SETTLE_TYPEHASH,
                    dealId,
                    d.termsHash,
                    sellerAward,
                    buyerCost,
                    sellerCost,
                    expectedPhase,
                    settlementNonce,
                    expiresAt
                )
            )
        );
        verify(d.buyer, digest, sigBuyer);
        verify(d.seller, digest, sigSeller);
        invalidateOffers(s, dealId);
        settleNormal(s, dealId, sellerAward, buyerCost, sellerCost, MidmanDK.OUT_MUTUAL);
    }

    // ================= T08 timeout (L-NORMAL S=P) =================
    function finalizeAfterTimeout(HubState storage s, MidmanPolicies pol, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        normalize(s, pol, dealId);
        require(d.phase == MidmanDK.PH_DELIVERED, BadPhase());
        requireFeed(pol);
        (uint64 ie, bool av) = inspectionEff(s, pol, dealId);
        require(av, OutageUnknown());
        require(now_() >= ie, TooEarly());
        settleNormal(s, dealId, d.principal, 0, 0, MidmanDK.OUT_TIMEOUT);
    }

    // ================= T23 catastrophic escape =================
    function catastrophicEscape(HubState storage s, bytes32 dealId) external {
        Deal storage d = active(s, dealId);
        uint8 ph = d.phase;
        require(
            ph == MidmanDK.PH_EVIDENCE || ph == MidmanDK.PH_PRIMARY_REVIEW || ph == MidmanDK.PH_FALLBACK_REVIEW
                || ph == MidmanDK.PH_RULING_PENDING || ph == MidmanDK.PH_DEADLOCK,
            BadPhase()
        );
        // Properly escalated only: only escalated deals reach these phases, so an
        // un-escalated free dispute can never earn the split through inactivity.
        require(d.escalatedAt != 0, BadPhase());
        require(now_() >= cutoffOf(d), TooEarly());
        // Independent of keepers, indexers, and the availability oracle.
        settleCatastrophic(s, dealId);
    }
}
