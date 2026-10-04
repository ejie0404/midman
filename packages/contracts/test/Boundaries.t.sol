// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MidmanHubTest} from "./MidmanHub.t.sol";
import {MidmanDK, Deal, DealTerms, RulingAuth, Payment3009, AllowanceIntent, Admission, ReadinessAuth} from "../src/DealTypes.sol";
import {Expired, TooEarly, TooLate, BadPhase, BadNonce} from "../src/DealTypes.sol";

/// @notice Exact-second boundary checks: timely uses `< deadline`,
/// timeout uses `>= deadline`, funding requires `now < fundingDeadline`.
contract BoundariesTest is MidmanHubTest {
    function _disputed(uint256 principal, uint16 bps) internal returns (DealTerms memory t, uint64 openedAt) {
        t = _terms(principal, bps);
        _fund(t, false);
        _deliver(t.dealId);
        openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function testFundAtDeadlineMinusOne() public {
        DealTerms memory t = _terms(P, 10_000);
        vm.warp(t.fundingDeadline - 1);
        _fund(t, false);
    }

    function testFundAtDeadlineReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        vm.warp(t.fundingDeadline);
        (
            ,
            bytes memory sb,
            bytes memory ss,
            Payment3009 memory pay,
            AllowanceIntent memory intent,
            Admission memory adm,
            ReadinessAuth memory ready,
            uint256 amount
        ) = _buildFund(t, false);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        vm.expectRevert(Expired.selector);
        hub.fund(t, sb, ss, pay, intent, adm, ready);
    }

    function testDeliverAtDeadlineMinusOne() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        Deal memory d = hub.getDeal(t.dealId);
        vm.warp(d.fundedAt + 3_600 - 1);
        _deliver(t.dealId);
    }

    function testDeliverAtDeadlineReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        vm.warp(block.timestamp + 3_600);
        vm.prank(seller);
        vm.expectRevert(TooLate.selector);
        hub.markDelivered(t.dealId, keccak256("m"), bytes32(0), 0, new bytes(0));
    }

    function testDisputeAtInspectionMinusOne() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 3_600 - 1);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function testDisputeAtInspectionEndReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 3_600);
        vm.prank(buyer);
        vm.expectRevert(TooLate.selector);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function testTimeoutAtInspectionEnd() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 3_600);
        hub.finalizeAfterTimeout(t.dealId);
    }

    function testTimeoutBeforeEndReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 3_600 - 1);
        vm.expectRevert(TooEarly.selector);
        hub.finalizeAfterTimeout(t.dealId);
    }

    function testEscalateAtNegotiationEnd() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        vm.warp(openedAt + 86_400);
        vm.prank(buyer);
        usdc.approve(address(hub), 5_000_000);
        vm.prank(buyer);
        hub.escalate(t.dealId, 5_000_000, 0, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());
    }

    function testLapseAtEscalationEnd() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        vm.warp(openedAt + 2 * 86_400);
        hub.lapseDispute(t.dealId);
    }

    function testLapseBeforeEndReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        vm.warp(openedAt + 2 * 86_400 - 1);
        vm.expectRevert(TooEarly.selector);
        hub.lapseDispute(t.dealId);
    }

    function testEscalateAtEscalationEndReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        vm.warp(openedAt + 2 * 86_400);
        vm.prank(buyer);
        usdc.approve(address(hub), 5_000_000);
        vm.prank(buyer);
        vm.expectRevert(BadPhase.selector);
        hub.escalate(t.dealId, 5_000_000, 0, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());
    }

    function testAdvanceToPrimaryAtEvidenceEnd() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(escAt + 86_400);
        hub.advanceToPrimary(t.dealId);
    }

    function testAdvanceToPrimaryBeforeEndReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(escAt + 86_400 - 1);
        vm.expectRevert(BadPhase.selector);
        hub.advanceToPrimary(t.dealId);
    }

    function testQueueAtPrimaryMinusOne() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        // primaryEnd = escAt+86400+7d; queue 1s before.
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        vm.warp(escAt + 86_400 + 7 days - 1);
        bytes32 rnonce = keccak256("b-edge");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rnonce,
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
    }

    function testQueueAtPrimaryEndReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        vm.warp(escAt + 86_400 + 7 days);
        bytes32 rnonce = keccak256("b-edge-late");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 60 days)
                )
            )
        );
        vm.expectRevert(BadPhase.selector);
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rnonce,
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 60 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
    }

    function testExecuteAtExecuteAt() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        uint64 queuedAt = escAt + 86_400 + 2;
        vm.warp(queuedAt);
        hub.advanceToPrimary(t.dealId);
        bytes32 rnonce = keccak256("b-exec");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rnonce,
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
        vm.warp(queuedAt + 24 hours); // exactly executeAt
        hub.executeRuling(t.dealId);
    }

    function testExecuteBeforeExecuteAtReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        uint64 queuedAt = escAt + 86_400 + 2;
        vm.warp(queuedAt);
        hub.advanceToPrimary(t.dealId);
        bytes32 rnonce = keccak256("b-exec-early");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rnonce,
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
        vm.warp(queuedAt + 24 hours - 1);
        vm.expectRevert(BadPhase.selector);
        hub.executeRuling(t.dealId);
    }

    function testEscapeAtEscapeAt() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(openedAt + 5_184_000);
        hub.catastrophicEscape(t.dealId);
    }

    function testEscapeBeforeEscapeAtReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(openedAt + 5_184_000 - 1);
        vm.expectRevert(TooEarly.selector);
        hub.catastrophicEscape(t.dealId);
    }

    function testStaleSettlementNonceReverts() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        // Offer signed pre-escalation (nonce 0, SELF_RESOLUTION phase); escalation
        // increments the counter AND advances the phase, so present it in the
        // post-escalation phase to isolate the nonce check.
        bytes32 digest = hubDigest(t);
        uint64 expiry = uint64(openedAt + 30 days);
        bytes32 sdigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.SETTLE_TYPEHASH, t.dealId, digest, P, 0, 0, uint8(4), bytes32(uint256(0)), expiry))
        );
        bytes memory sb = _sig(buyerPk, sdigest);
        bytes memory ss = _sig(sellerPk, sdigest);
        _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.expectRevert(BadNonce.selector);
        hub.mutualSettlement(t.dealId, P, 0, 0, 4, bytes32(uint256(0)), expiry, sb, ss);
    }

    /// @notice Positive control: the same offer shape settles when presented
    /// in its own epoch (no intervening phase transition).
    function testMutualOfferLiveBeforeDispute() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        bytes32 digest = hubDigest(t);
        uint64 expiry = uint64(block.timestamp + 30 days);
        bytes32 liveNonce = bytes32(hub.getDeal(t.dealId).settlementNonce);
        bytes32 sdigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.SETTLE_TYPEHASH, t.dealId, digest, P, 0, 0, uint8(1), liveNonce, expiry))
        );
        bytes memory sb = _sig(buyerPk, sdigest);
        bytes memory ss = _sig(sellerPk, sdigest);
        // Sanity: the offer is live before any dispute.
        hub.mutualSettlement(t.dealId, P, 0, 0, 1, liveNonce, expiry, sb, ss);
    }

    /// @notice A mutual offer signed pre-dispute (phase DELIVERED, nonce 0)
    /// dies across the dispute->lapse cycle even though the deal returns to
    /// DELIVERED: every non-terminal phase transition retires the offer epoch.
    function testStaleOfferDiesAcrossLapseCycleReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        bytes32 digest = hubDigest(t);
        uint64 expiry = uint64(block.timestamp + 60 days);
        bytes32 sdigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.SETTLE_TYPEHASH, t.dealId, digest, P, 0, 0, uint8(1), bytes32(uint256(0)), expiry))
        );
        bytes memory sb = _sig(buyerPk, sdigest);
        bytes memory ss = _sig(sellerPk, sdigest);
        // Dispute opens (epoch 0 -> 1) then lapses back to DELIVERED (epoch 2).
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        vm.warp(openedAt + 2 * 86_400 + 1);
        hub.lapseDispute(t.dealId);
        // Same phase as signed, but the offer epoch is dead.
        vm.expectRevert(BadNonce.selector);
        hub.mutualSettlement(t.dealId, P, 0, 0, 1, bytes32(uint256(0)), expiry, sb, ss);
    }

}
