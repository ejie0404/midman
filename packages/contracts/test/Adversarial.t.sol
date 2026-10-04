// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MidmanHubTest} from "./MidmanHub.t.sol";
import {MidmanDK, DealTerms, Payment3009, AllowanceIntent, Admission, ReadinessAuth, RulingAuth, VetoSig} from "../src/DealTypes.sol";
import {BadSig, BadPhase, BadNonce, BadTerms, NoQuorum, NoClaim, OutageUnknown, TooEarly, TooLate} from "../src/DealTypes.sol";

/// @notice Attacker-model tests: replay, double-settlement, quorum/rotation,
/// veto bounds, keeper inactivity, outage handling, token failures.
contract AdversarialTest is MidmanHubTest {
    function _disputed(uint256 principal, uint16 bps) internal returns (DealTerms memory t, uint64 openedAt) {
        t = _terms(principal, bps);
        _fund(t, false);
        _deliver(t.dealId);
        openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function _escalated(DealTerms memory t, uint64 openedAt) internal returns (uint64 escAt) {
        escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
    }

    function _queueFullSellerPrimary(DealTerms memory t, bytes32 rnonce, uint64 epoch, uint256[] storage pks)
        internal
        returns (bytes32 rdigest)
    {
        rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), epoch, uint64(block.timestamp + 30 days)
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
                authEpoch: epoch,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, pks, 2)
            })
        );
    }

    function testReplayAgreementSigsAcrossDeals() public {
        DealTerms memory a = _terms(P, 10_000);
        bytes32 digestA = hubDigest(a);
        bytes memory sbA = _sig(buyerPk, digestA);
        bytes memory ssA = _sig(sellerPk, digestA);
        _fund(a, false);
        // Reuse A's dual signatures on B's funding (everything else valid for B).
        DealTerms memory b = _terms(P, 10_000);
        (
            ,
            ,
            ,
            Payment3009 memory payB,
            AllowanceIntent memory intentB,
            Admission memory admB,
            ReadinessAuth memory readyB,
            uint256 amountB
        ) = _buildFund(b, false);
        vm.prank(buyer);
        usdc.approve(address(hub), amountB);
        vm.expectRevert(BadSig.selector);
        hub.fund(b, sbA, ssA, payB, intentB, admB, readyB);
    }

    function testDoubleSettlementReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.prank(buyer);
        hub.approveSeller(t.dealId, bytes32("v"), bytes32(0), 0, new bytes(0));
        vm.prank(seller);
        vm.expectRevert(BadPhase.selector);
        hub.refundBuyer(t.dealId, bytes32("v"), bytes32(0), 0, new bytes(0));
        vm.expectRevert(BadPhase.selector);
        hub.catastrophicEscape(t.dealId);
    }

    function testDoubleClaimReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.prank(buyer);
        hub.approveSeller(t.dealId, bytes32("v"), bytes32(0), 0, new bytes(0));
        hub.claimFor(t.dealId, 1);
        vm.expectRevert(NoClaim.selector);
        hub.claimFor(t.dealId, 1);
    }

    function testQuorumEnforced() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalated(t, openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        // Single signature below quorum.
        bytes32 rnonce = keccak256("q-single");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        bytes[] memory one = new bytes[](1);
        one[0] = _sig(primaryPks[0], rdigest);
        vm.expectRevert(NoQuorum.selector);
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
                signatures: one
            })
        );
        // Outsider signature mixed in.
        bytes[] memory mixed = new bytes[](2);
        mixed[0] = _sig(primaryPks[0], rdigest);
        mixed[1] = _sig(0xDEAD, rdigest);
        vm.expectRevert(NoQuorum.selector);
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
                signatures: mixed
            })
        );
        // Same signer twice.
        bytes[] memory dup = new bytes[](2);
        dup[0] = _sig(primaryPks[0], rdigest);
        dup[1] = _sig(primaryPks[0], rdigest);
        vm.expectRevert();
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
                signatures: dup
            })
        );
    }

    function testRotationGatesEpoch() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalated(t, openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        // Rotate to fresh disjoint panels.
        address[] memory np = new address[](3);
        address[] memory nf = new address[](3);
        address[] memory nv = new address[](3);
        uint256[] memory npk = new uint256[](3);
        uint256[] memory nfk = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            npk[i] = 0xB001 + i;
            nfk[i] = 0xC001 + i;
            np[i] = vm.addr(npk[i]);
            nf[i] = vm.addr(nfk[i]);
            nv[i] = vm.addr(vetoPks[i]);
        }
        vm.prank(governance);
        policies.proposePanel(np, nf, nv);
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(governance);
        policies.executePanel();
        assertEq(policies.authEpoch(), 2);
        // Old-epoch queue now rejected.
        bytes32 rnonce = keccak256("q-rot");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rnonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        vm.expectRevert(BadTerms.selector);
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
                signatures: _rulingMemSigs(rdigest, npk, 2)
            })
        );
    }

    function testQueuedRulingSurvivesRotation() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalated(t, openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        _queueFullSellerPrimary(t, keccak256("q-survive"), 1, primaryPks);
        address[] memory np = new address[](3);
        address[] memory nf = new address[](3);
        address[] memory nv = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            np[i] = vm.addr(0xD001 + i);
            nf[i] = vm.addr(0xE001 + i);
            nv[i] = vm.addr(vetoPks[i]);
        }
        vm.prank(governance);
        policies.proposePanel(np, nf, nv);
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(governance);
        policies.executePanel();
        // Queued award still executes after its delay (veto window intact).
        hub.executeRuling(t.dealId);
    }

    function testVetoBounds() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalated(t, openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        bytes32 rdigest = _queueFullSellerPrimary(t, keccak256("q-veto"), 1, primaryPks);
        // Wrong-origin veto path.
        VetoSig[] memory one = new VetoSig[](2);
        for (uint256 i = 0; i < 2; i++) {
            bytes32 vnonce = keccak256(abi.encode("veto-bounds", i));
            uint64 expiry = uint64(block.timestamp + 7 days);
            address authority = vm.addr(vetoPks[i]);
            bytes32 vdigest = hub.actionDigest(
                keccak256(abi.encode(MidmanDK.VETO_TYPEHASH, t.dealId, rdigest, authority, vnonce, expiry))
            );
            one[i] = VetoSig({authority: authority, nonce: vnonce, expiry: expiry, signature: _sig(vetoPks[i], vdigest)});
        }
        vm.expectRevert(BadPhase.selector);
        hub.vetoFallbackRuling(t.dealId, rdigest, one);
        // Single veto signature below 2-of-N.
        VetoSig[] memory single = new VetoSig[](1);
        single[0] = one[0];
        vm.expectRevert(NoQuorum.selector);
        hub.vetoPrimaryRuling(t.dealId, rdigest, single);
        // After execution delay, veto is closed.
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectRevert(BadPhase.selector);
        hub.vetoPrimaryRuling(t.dealId, rdigest, one);
    }

    function testKeeperInactivity() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        // No keeper calls at all for 20 days past escalation: one lapse call works.
        vm.warp(openedAt + 20 days);
        hub.lapseDispute(t.dealId);
        hub.finalizeAfterTimeout(t.dealId);
    }

    function testKeeperInactivityDeadlock() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        _escalated(t, openedAt);
        // 20 days, zero housekeeping: deadlock materializes on first touch.
        vm.warp(openedAt + 20 days);
        hub.markDeadlock(t.dealId);
        vm.warp(openedAt + 5_184_000 + 1);
        hub.catastrophicEscape(t.dealId);
    }

    function testOutageExtendsDelivery() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        uint64 t0 = uint64(block.timestamp);
        // 4000s outage starting 1000s after funding; delivery period is 3600s.
        feed.programOutage(7, t0 + 1_000, t0 + 5_000);
        vm.warp(t0 + 5_000 + 1);
        policies.reportOutage(7);
        // Original end (t0+3600) passed, but effective end includes 4000s + 1800s grace.
        vm.warp(t0 + 3_600 + 100);
        _deliver(t.dealId);
    }

    function testOngoingOutageBlocksTimeout() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 3_600 + 1);
        feed.setDown(true);
        vm.expectRevert(OutageUnknown.selector);
        hub.finalizeAfterTimeout(t.dealId);
        feed.setDown(false);
        hub.finalizeAfterTimeout(t.dealId);
    }

    function testTokenBlocklistPreservesLiability() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.prank(buyer);
        hub.approveSeller(t.dealId, bytes32("v"), bytes32(0), 0, new bytes(0));
        uint256 liab = hub.totalLiabilities();
        usdc.setBlocked(seller, true);
        vm.expectRevert();
        hub.claimFor(t.dealId, 1);
        assertEq(hub.totalLiabilities(), liab, "failed claim preserves liability");
        usdc.setBlocked(seller, false);
        hub.claimFor(t.dealId, 1);
        assertEq(hub.totalLiabilities(), liab - P, "claim reduces liability");
    }

    function testBlockedHubCannotFund() public {
        DealTerms memory t = _terms(P, 10_000);
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
        usdc.setBlocked(address(hub), true);
        vm.expectRevert();
        hub.fund(t, sb, ss, pay, intent, adm, ready);
        usdc.setBlocked(address(hub), false);
    }

    function testAdmissionBoundToAgreement() public {
        DealTerms memory a = _terms(P, 10_000);
        (, , , , , Admission memory admA, , ) = _buildFund(a, false);
        // Admission issued for A is presented at B's funding: must fail.
        DealTerms memory b = _terms(P, 10_000);
        (
            ,
            bytes memory sbB,
            bytes memory ssB,
            Payment3009 memory payB,
            AllowanceIntent memory intentB,
            ,
            ReadinessAuth memory readyB,
            uint256 amountB
        ) = _buildFund(b, false);
        vm.prank(buyer);
        usdc.approve(address(hub), amountB);
        vm.expectRevert(BadSig.selector);
        hub.fund(b, sbB, ssB, payB, intentB, admA, readyB);
    }

    function testEvidenceSequenceEnforced() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        _escalated(t, openedAt);
        bytes32[] memory files = new bytes32[](1);
        files[0] = keccak256("file-0");
        vm.prank(buyer);
        hub.submitEvidenceCommitment(
            t.dealId, buyer, 0, bytes32(0), files, keccak256("meta"), bytes32(0), 0, new bytes(0)
        );
        // Replaying sequence 0 reverts (append-only).
        vm.prank(buyer);
        vm.expectRevert();
        hub.submitEvidenceCommitment(
            t.dealId, buyer, 0, bytes32(0), files, keccak256("meta"), bytes32(0), 0, new bytes(0)
        );
    }

    function _rulingMemSigs(bytes32 digest, uint256[] memory pks, uint256 n) internal pure returns (bytes[] memory sigs) {        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    // ---- Outage engine regressions: newest-wins reads, O+grace clipping,
    // primary-window coverage, unreported trailing outages, ring capacity ----

    /// @notice With 10 recorded outages and an 8-interval lookback, the newest
    /// (overlapping) outage must still extend the deadline.
    function testNewestOutageEntriesCount() public {
        uint64 t0 = uint64(block.timestamp);
        for (uint80 r = 10; r < 28; r += 2) {
            uint64 s = t0 - 200_000 + uint64(r - 10) * 1_000;
            feed.programOutage(r, s, s + 100);
        }
        vm.warp(t0 + 1);
        for (uint80 r = 10; r < 28; r += 2) policies.reportOutage(r);
        assertEq(policies.outageCount(), 9);

        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        uint64 fundedAt = hub.getDeal(t.dealId).fundedAt;
        feed.programOutage(28, fundedAt + 1_000, fundedAt + 2_000);
        vm.warp(fundedAt + 2_000 + 1);
        policies.reportOutage(28);
        // Seal the feed so no live trailing interval interferes.
        feed.programUpRound(30, fundedAt + 2_000 + 1);
        (uint64 rs, uint64 re) = policies.outageRecent(0);
        assertEq(rs, fundedAt + 1_000);
        assertEq(re, fundedAt + 2_000);
        // Original end fundedAt+3600 passed; 1000 overlap + 1800 grace applies.
        vm.warp(fundedAt + 3_600 + 500);
        _deliver(t.dealId);
    }

    /// @notice An outage running past the deadline extends to original+grace
    /// (P-09 window), not just to the original deadline.
    function testOutageClipsAtOriginalPlusGrace() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        uint64 fundedAt = hub.getDeal(t.dealId).fundedAt;
        uint64 origEnd = fundedAt + 3_600;
        feed.programOutage(40, origEnd - 100, origEnd + 5_000);
        vm.warp(origEnd + 5_000 + 1);
        policies.reportOutage(40);
        feed.programUpRound(42, origEnd + 5_000 + 1);
        // Overlap with [fundedAt, origEnd+1800]: 100 + 1800 = 1900;
        // extension 1900 + 1800 = 3700. eff = origEnd + 3700.
        vm.warp(origEnd + 3_700);
        vm.prank(seller);
        vm.expectRevert(TooLate.selector);
        hub.markDelivered(t.dealId, keccak256("m"), bytes32(0), 0, new bytes(0));
        vm.warp(origEnd + 3_700 - 1);
        _deliver(t.dealId);
    }

    /// @notice Downtime during primary review extends the primary deadline.
    function testPrimaryReviewWindowExtends() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        uint64 escAt = _escalated(t, openedAt);
        uint64 evEnd = escAt + 86_400;
        uint64 pEnd = evEnd + 7 days;
        feed.programOutage(50, evEnd + 1_000, evEnd + 2_000);
        vm.warp(evEnd + 2_000 + 1);
        policies.reportOutage(50);
        feed.programUpRound(52, evEnd + 2_000 + 1);
        // Past the original primary end but inside the extended window
        // (outage overlaps the evidence grace tail, shifting the evidence
        // anchor +2600; the primary window itself starts after recovery, so
        // it adds nothing further): eff = pEnd + 2600.
        vm.warp(pEnd + 1);
        vm.expectRevert(BadPhase.selector);
        hub.activateFallback(t.dealId);
        vm.warp(pEnd + 2_599);
        vm.expectRevert(BadPhase.selector);
        hub.activateFallback(t.dealId);
        // Exact extended edge: materializes via normalization.
        vm.warp(pEnd + 2_600);
        hub.activateFallback(t.dealId);
        assertTrue(hub.getDeal(t.dealId).phase == 6);
    }

    /// @notice An outage that ended but was never reported still counts via
    /// the live feed trailing interval (closes the report-delay window).
    function testUnreportedRecentOutageCounts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 inspEnd = uint64(block.timestamp) + 3_600;
        feed.programOutage(60, inspEnd - 1_000, inspEnd - 500);
        // Never reported. Latest round is up; trailing = [inspEnd-1000, inspEnd-500].
        // Overlap 500 + grace 1800, extension 2300. eff = inspEnd + 2300.
        // Timeout is extended too: still too early here (phase DELIVERED).
        vm.warp(inspEnd + 2_000);
        vm.expectRevert(TooEarly.selector);
        hub.finalizeAfterTimeout(t.dealId);
        // Fail-open admission works inside the extended window.
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    /// @notice Reporting never bricks: past 64 entries the oldest is evicted.
    function testOutageLedgerRingsPastCapacity() public {
        uint64 t0 = uint64(block.timestamp);
        for (uint80 r = 100; r < 230; r += 2) {
            uint64 s = t0 + uint64(r - 100) * 1_000;
            feed.programOutage(r, s, s + 100);
            vm.warp(s + 100 + 1);
            policies.reportOutage(r);
        }
        assertEq(policies.outageTotal(), 65);
        assertEq(policies.outageCount(), 64);
        (uint64 ns, uint64 ne) = policies.outageRecent(0);
        assertEq(ns, t0 + 128_000);
        assertEq(ne, t0 + 128_100);
        (uint64 os,) = policies.outages(0);
        assertEq(os, t0 + 2_000); // r=100 evicted; r=102 is oldest retained
    }
}
