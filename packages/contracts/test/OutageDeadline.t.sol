// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MidmanHubTest} from "./MidmanHub.t.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockUSDC, MockFeed} from "./Mocks.t.sol";
import {DealTerms, OutageUnknown, TooEarly, TooLate, BadPhase} from "../src/DealTypes.sol";

/// @notice Round-2 audit regressions for the outage deadline fixpoint, the
/// append-only/pruned retention ledger, the **sequential coverage watermark**
/// and the availability semantics.
///
/// Coverage model: reportOutage consumes only the next un-audited feed round
/// (`roundId == lastAuditedRound + 1`) together with its recovery, so rounds are
/// reported in the consecutive order the feed mints them (2, 4, 6, ... given the
/// MockFeed's head starts at round 1). An unreported transition leaves the
/// watermark behind the head and deadline math reports history UNKNOWN.
contract OutageDeadlineTest is MidmanHubTest {
    // ---- helpers ----

    function _dealEnds(bytes32 dealId)
        internal
        view
        returns (uint64 delivery, uint64 inspection, uint64 negotiation, uint64 escalation, uint64 evidence, uint64 primary, uint64 fallbackEnd, bool available)
    {
        return hub.effectiveDeadlines(dealId);
    }

    function _disputed(uint256 principal, uint16 bps) internal returns (DealTerms memory t, uint64 openedAt) {
        t = _terms(principal, bps);
        _fund(t, false);
        _deliver(t.dealId);
        openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function _escalated(DealTerms memory t, uint64 openedAt) internal returns (uint64) {
        return _escalateFresh(t.dealId, bytes32(0), openedAt);
    }

    /// @notice Fund + deliver, returning the delivered-at anchor and D0.
    function _deliveredDeal() internal returns (bytes32 dealId, uint64 anchor, uint64 d0) {
        DealTerms memory t = _terms(P, 0);
        _fund(t, false);
        _deliver(t.dealId);
        anchor = hub.getDeal(t.dealId).deliveredAt;
        d0 = anchor + 3_600;
        return (t.dealId, anchor, d0);
    }

    /// @notice Rebuild a fresh hub/policies/feed with the shared 5/5/3 panels, so
    /// gas measurements are not polluted by previously retained intervals.
    function _resetSystem() internal {
        feed = new MockFeed();
        usdc = new MockUSDC();
        policies = new MidmanPolicies(governance, pauser, admission, treasury, address(feed), primary, fbPanel, veto);
        hub = new MidmanHub(address(usdc), address(policies));
        vm.startPrank(governance);
        policies.registerFeePolicy(feePolicy, keccak256("fee-content"));
        policies.registerCategoryPolicy(categoryPolicy, keccak256("cat-content"), 3_600);
        policies.registerReadinessPolicy(noReadiness, keccak256("ready-content"), false);
        policies.registerReadinessPolicy(readinessPolicy, keccak256("ready-req-content"), true);
        policies.registerEvidencePolicy(evidencePolicy, keccak256("evi-content"));
        policies.registerBondPolicy(bondPolicy, keccak256("bond-content"), 5_000_000, 5_000_000);
        policies.registerArbitrationPolicy(arbPolicy, keccak256("arb-content"), 0x07);
        policies.registerOutagePolicy(outagePolicy, keccak256("out-content"), 1_800, 8);
        policies.registerCatastrophicPolicy(catPolicy, keccak256("esc-content"));
        vm.stopPrank();
        usdc.mint(buyer, 1_000_000_000);
        usdc.mint(seller, 1_000_000_000);
    }

    // ---- Regression 1 ----

    /// @notice An outage crossing the original deadline preserves ALL of its
    /// downtime + grace, and the timeout stays blocked long after recovery.
    function testRegression1_CrossingDeadlinePreservesDowntime() public {
        (bytes32 dealId, , uint64 d0) = _deliveredDeal();
        feed.programOutage(2, d0 - 1_000, d0 + 7_000);
        vm.warp(d0 + 7_000 + 1);
        policies.reportOutage(2);

        uint64 eff = d0 + 9_800; // downtime 8,000 + grace 1,800
        (, uint64 inspection, , , , , , bool av) = _dealEnds(dealId);
        assertTrue(av, "available");
        assertEq(inspection, eff, "inspection fixpoint");

        vm.warp(eff - 1);
        vm.expectRevert(TooEarly.selector);
        hub.finalizeAfterTimeout(dealId);
        vm.warp(eff);
        hub.finalizeAfterTimeout(dealId);
        assertEq(hub.getDeal(dealId).phase, 9, "settled at fixpoint boundary");
    }

    // ---- Regression 2 ----

    /// @notice A second outage that lands INSIDE the extension produced by the
    /// first is counted by the fixpoint (not clipped away).
    function testRegression2_SecondOutageInsideExtensionCounts() public {
        (bytes32 dealId, , uint64 d0) = _deliveredDeal();
        // O1 crosses the deadline; O2 sits inside O1's extension.
        feed.programOutage(2, d0 - 500, d0 + 3_000);
        vm.warp(d0 + 3_001);
        policies.reportOutage(2);
        feed.programOutage(4, d0 + 4_000, d0 + 5_000);
        vm.warp(d0 + 5_001);
        policies.reportOutage(4);

        (, uint64 inspection, , , , , , bool av) = _dealEnds(dealId);
        assertTrue(av);
        assertEq(inspection, d0 + 8_100, "downtime 4500 + grace 3600");
    }

    /// @notice Three chained outages all count.
    function testRegression2b_CascadingOutages() public {
        (bytes32 dealId, , uint64 d0) = _deliveredDeal();
        feed.programOutage(2, d0 - 500, d0 + 1_000);
        vm.warp(d0 + 1_001);
        policies.reportOutage(2);
        feed.programOutage(4, d0 + 2_000, d0 + 3_000);
        vm.warp(d0 + 3_001);
        policies.reportOutage(4);
        feed.programOutage(6, d0 + 4_000, d0 + 5_000);
        vm.warp(d0 + 5_001);
        policies.reportOutage(6);

        // Fixpoint: D0=d0. O1 [d0-500,d0+1000], O2 [d0+2000,d0+3000], O3 [d0+4000,d0+5000].
        // Iteration grows E to include each in turn; total downtime 1500+1000+1000=3500,
        // grace 3*1800=5400 -> eff = d0 + 8900.
        (, uint64 inspection, , , , , , bool av) = _dealEnds(dealId);
        assertTrue(av);
        assertEq(inspection, d0 + 8_900, "all three counted");
    }

    // ---- delayed report ----

    function testDelayedReportStillCounts() public {
        (bytes32 dealId, , uint64 d0) = _deliveredDeal();
        feed.programOutage(2, d0 - 1_000, d0 - 500);
        // Report 10 days later (well inside MAX_HISTORY_AGE, still the next round).
        vm.warp(d0 + 10 days);
        policies.reportOutage(2);
        (, uint64 inspection, , , , , , bool av) = _dealEnds(dealId);
        assertTrue(av);
        assertEq(inspection, d0 + 2_300, "downtime 500 + grace 1800");
    }

    // ---- coverage watermark: out-of-order / duplicate reports rejected ----

    function testCoverageWatermarkRejectsOutOfOrderAndDuplicate() public {
        (, uint64 anchor, ) = _deliveredDeal();
        feed.programOutage(2, anchor + 10, anchor + 20);
        vm.warp(anchor + 21);
        policies.reportOutage(2);
        bytes32 key = keccak256(abi.encode(uint64(anchor + 10), uint64(anchor + 20)));
        assertTrue(policies.outageSeen(key), "dedupe recorded");
        assertEq(policies.lastAuditedRound(), 3, "watermark advanced to recovery");
        // Re-reporting an already-audited round is rejected by the watermark.
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        policies.reportOutage(2);
        // Skipping ahead to a later round is likewise rejected.
        feed.programOutage(6, anchor + 30, anchor + 40);
        vm.warp(anchor + 41);
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        policies.reportOutage(6);

        // Age past MAX_HISTORY_AGE and prune via the next legitimate report.
        vm.warp(anchor + policies.MAX_HISTORY_AGE() + 1 days);
        uint64 nowTs = uint64(block.timestamp);
        feed.programOutage(4, nowTs - 10, nowTs);
        vm.warp(nowTs + 1);
        policies.reportOutage(4);
        assertEq(policies.outageCount(), 1, "interval pruned by age");
        assertTrue(policies.outageSeen(key), "dedupe persists after prune");
    }

    // ---- unreported history -> unavailable ----

    /// @notice The audit finding: two outages that recovered but were never
    /// reported leave the watermark behind the head. History is UNKNOWN, so the
    /// timeout is blocked (never settled early) and admission stays fail-open
    /// only against the ORIGINAL deadline until someone reports.
    function testUnreportedOutagesBlockTimeoutUntilReported() public {
        DealTerms memory t = _terms(P, 0);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 anchor = hub.getDeal(t.dealId).deliveredAt;
        uint64 d0 = anchor + 3_600;

        // Two recoveries, neither reported. Head has advanced to round 5 but
        // the watermark is still 1.
        feed.programOutage(2, d0 - 500, d0 + 1_000);
        feed.programOutage(4, d0 + 2_000, d0 + 3_000);

        (,,,,, , , bool av) = _dealEnds(t.dealId);
        assertFalse(av, "incomplete history is unavailable");
        assertEq(policies.lastAuditedRound(), 1, "watermark not advanced");

        vm.warp(d0 + 3_600);
        vm.expectRevert(OutageUnknown.selector);
        hub.finalizeAfterTimeout(t.dealId);

        // Fail-open admission uses the ORIGINAL deadline; that has passed here,
        // so a buyer must first make history complete (permissionless report).
        vm.prank(buyer);
        vm.expectRevert(TooLate.selector);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));

        // Partially reported history stays unavailable until fully audited.
        policies.reportOutage(2);
        assertEq(policies.lastAuditedRound(), 3, "only first transition audited");
        (,,,,, , , bool avPartial) = _dealEnds(t.dealId);
        assertFalse(avPartial, "partial history is unavailable");
        vm.expectRevert(OutageUnknown.selector);
        hub.finalizeAfterTimeout(t.dealId);

        policies.reportOutage(4);
        assertEq(policies.lastAuditedRound(), 5, "history fully audited");
        (, uint64 inspection, , , , , , bool av2) = _dealEnds(t.dealId);
        assertTrue(av2, "history restored");
        assertEq(inspection, d0 + 6_100, "downtime 2500 + grace 3600");
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        assertEq(hub.getDeal(t.dealId).phase, 2, "dispute opened in extended window");
    }

    // ---- history overflow -> unavailable ----

    function testHistoryOverflowReportsUnavailable() public {
        // The live deal is created BEFORE the ledger saturates.
        DealTerms memory t = _terms(P, 0);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 t0 = uint64(block.timestamp);

        uint256 n = policies.MAX_RETAINED() + 1;
        for (uint256 i = 0; i < n; i++) {
            uint80 r = uint80(2 + 2 * i);
            uint64 s = t0 + uint64(i * 10);
            feed.programOutage(r, s, s + 1);
            vm.warp(s + 2);
            policies.reportOutage(r);
        }
        assertTrue(policies.outageSaturated(), "saturated");
        assertGt(policies.outageCount(), policies.MAX_RETAINED(), "over cap");

        (,,,,, , , bool av) = _dealEnds(t.dealId);
        assertFalse(av, "saturated ledger is unavailable");
        vm.warp(block.timestamp + 3_601);
        vm.expectRevert(OutageUnknown.selector);
        hub.finalizeAfterTimeout(t.dealId);
    }

    // ---- malformed feed -> unknown, admission fail-open ----

    function testMalformedFeedUnknownAndAdmissionFailOpen() public {
        DealTerms memory t = _terms(P, 0);
        _fund(t, false);
        _deliver(t.dealId);
        feed.setLatestBroken(true);

        (,,,,, , , bool av) = _dealEnds(t.dealId);
        assertFalse(av, "malformed feed unavailable");
        vm.expectRevert(OutageUnknown.selector);
        hub.finalizeAfterTimeout(t.dealId);

        // Admission is fail-open against the ORIGINAL inspection deadline.
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        assertEq(hub.getDeal(t.dealId).phase, 2, "dispute opened fail-open");
    }

    // ---- escape cutoff is never outage-adjusted ----

    function testEscapeCutoffFixedDespiteHugeOutage() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        _escalated(t, openedAt);
        uint64 cutoff = hub.escapeAt(t.dealId);
        assertEq(cutoff, openedAt + 5_184_000, "fixed cutoff");

        feed.programOutage(2, openedAt + 1_000, openedAt + 4_000_000);
        vm.warp(openedAt + 4_000_001);
        policies.reportOutage(2);
        assertEq(hub.escapeAt(t.dealId), cutoff, "escape unaffected by outage");

        vm.warp(cutoff - 1);
        vm.expectRevert(TooEarly.selector);
        hub.catastrophicEscape(t.dealId);
        vm.warp(cutoff);
        hub.catastrophicEscape(t.dealId);
        assertEq(hub.getDeal(t.dealId).phase, 9, "fires exactly at cutoff");
    }

    // ---- authoritative view ----

    function testEffectiveDeadlinesView() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        uint64 fundedAt = hub.getDeal(t.dealId).fundedAt;
        _deliver(t.dealId);
        uint64 deliveredAt = hub.getDeal(t.dealId).deliveredAt;

        (uint64 delivery, uint64 inspection, uint64 negotiation, uint64 escalation, , , , bool av) =
            _dealEnds(t.dealId);
        assertTrue(av, "available");
        assertEq(delivery, fundedAt + 3_600, "delivery");
        assertEq(inspection, deliveredAt + 3_600, "inspection");
        assertEq(negotiation, 86_400, "negotiation (anchor 0)");
        assertEq(escalation, 172_800, "escalation (anchor 0)");
    }

    // ---- precedence ----

    /// @notice Late housekeeping never advances a clock while the feed is
    /// unknown, and the catastrophic escape is independent of feed/history.
    function testPrecedence_LateHousekeepingAndEscapeFeedIndependent() public {
        (DealTerms memory t, uint64 openedAt) = _disputed(P, 10_000);
        _escalated(t, openedAt);
        uint64 cutoff = hub.escapeAt(t.dealId);

        feed.setLatestBroken(true);
        vm.warp(openedAt + 20 days);
        vm.expectRevert(OutageUnknown.selector);
        hub.advanceToPrimary(t.dealId);
        assertEq(hub.getDeal(t.dealId).phase, 4, "clock not advanced");

        vm.warp(cutoff);
        hub.catastrophicEscape(t.dealId);
        assertEq(hub.getDeal(t.dealId).phase, 9, "escaped despite unknown feed");
    }

    /// @notice Lapse preserves the original inspection anchor and the permanent
    /// one-shot dispute flag; no late call restarts the clock.
    function testPrecedence_LapseKeepsInspectionAnchor() public {
        DealTerms memory t = _terms(P, 0);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 deliveredAt = hub.getDeal(t.dealId).deliveredAt;
        uint64 openedAt = deliveredAt + 100;
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        vm.warp(openedAt + 2 * 86_400 + 1);
        hub.lapseDispute(t.dealId);
        assertEq(hub.getDeal(t.dealId).phase, 1, "back to delivered");
        assertTrue(hub.getDeal(t.dealId).disputeUsed, "disputeUsed permanent");

        (, uint64 inspection, , , , , , bool av) = _dealEnds(t.dealId);
        assertTrue(av);
        assertEq(inspection, deliveredAt + 3_600, "anchor preserved, not restarted");
        hub.finalizeAfterTimeout(t.dealId);
        assertEq(hub.getDeal(t.dealId).phase, 9, "original timeout still settles");
    }

    // ---- gas table ----

    /// @notice Records effectiveDeadlines adjustment gas at 0/1/4/16 retained
    /// intervals (each case on a fresh system).
    function testAdjustmentGasAcrossIntervalCounts() public {
        uint256[4] memory counts = [uint256(0), 1, 4, 16];
        for (uint256 c = 0; c < counts.length; c++) {
            _resetSystem();
            uint256 n = counts[c];
            DealTerms memory t = _terms(P, 0);
            _fund(t, false);
            _deliver(t.dealId);
            uint64 d0 = hub.getDeal(t.dealId).deliveredAt + 3_600;
            for (uint256 i = 0; i < n; i++) {
                uint80 r = uint80(2 + 2 * i);
                uint64 s = d0 - 3_000 + uint64(i * 150);
                feed.programOutage(r, s, s + 100);
            }
            vm.warp(d0 + 1);
            for (uint256 i = 0; i < n; i++) policies.reportOutage(uint80(2 + 2 * i));
            uint256 g = gasleft();
            (,,,,, , , bool av) = _dealEnds(t.dealId);
            uint256 used = g - gasleft();
            emit log_named_uint(string.concat("effectiveDeadlines_gas_intervals_", vm.toString(n)), used);
            assertTrue(av, "available");
        }
    }
}
