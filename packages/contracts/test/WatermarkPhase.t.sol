// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MidmanHubTest} from "./MidmanHub.t.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockFeed} from "./Mocks.t.sol";
import {DealTerms, OutageUnknown, TooEarly} from "../src/DealTypes.sol";

/// @notice Liveness of the outage coverage watermark across Chainlink proxy
/// phase changes (round ids jump to `phase << 64 | 1`) and governance feed
/// rotation. Before this fix either event left `lastAuditedRound` permanently
/// behind the head, so every time-derived hub action reverted OutageUnknown.
contract WatermarkPhaseTest is MidmanHubTest {
    // MockFeed rounds start in phase 0, so the next proxy phase begins at 1 << 64 | 1.
    uint80 constant NEXT_PHASE_FIRST = (uint80(1) << 64) | 1;

    function _deliveredDeal() internal returns (bytes32 dealId, uint64 d0) {
        DealTerms memory t = _terms(P, 0);
        _fund(t, false);
        _deliver(t.dealId);
        return (t.dealId, hub.getDeal(t.dealId).deliveredAt + 3_600);
    }

    function _available(bytes32 dealId) internal view returns (bool av, uint64 inspection) {
        (, inspection,,,,,, av) = hub.effectiveDeadlines(dealId);
    }

    /// @notice Outage whose recovery is the first round of a new proxy phase.
    function testOutageRecoveredInNewPhaseIsReportable() public {
        (bytes32 dealId, uint64 d0) = _deliveredDeal();
        vm.warp(d0 + 10_000);
        feed.setRound(2, 1, d0 - 1_000); // last round of the old phase: down
        feed.setRound(NEXT_PHASE_FIRST, 0, d0 + 2_000); // recovery in the next phase
        feed.setHead(NEXT_PHASE_FIRST);

        (bool avBefore,) = _available(dealId);
        assertFalse(avBefore, "unreported outage is unavailable");
        vm.expectRevert(OutageUnknown.selector);
        hub.finalizeAfterTimeout(dealId);

        (bool exists, uint80 next) = policies.successorRound(2);
        assertTrue(exists, "successor crosses phase");
        assertEq(next, NEXT_PHASE_FIRST, "successor is first round of next phase");

        policies.reportOutage(2);
        assertEq(policies.lastAuditedRound(), NEXT_PHASE_FIRST, "watermark crossed phase");

        (bool av, uint64 eff) = _available(dealId);
        assertTrue(av, "history complete");
        assertEq(eff, d0 + 3_000 + 1_800, "downtime + grace preserved");
        vm.warp(eff - 1);
        vm.expectRevert(TooEarly.selector);
        hub.finalizeAfterTimeout(dealId);
        vm.warp(eff);
        hub.finalizeAfterTimeout(dealId);
    }

    /// @notice A new phase that starts UP is consumed permissionlessly.
    function testNewPhaseStartingUpIsAdvanced() public {
        (bytes32 dealId, uint64 d0) = _deliveredDeal();
        vm.warp(d0 + 10);
        feed.setRound(NEXT_PHASE_FIRST, 0, d0);
        feed.setHead(NEXT_PHASE_FIRST);

        (bool avBefore,) = _available(dealId);
        assertFalse(avBefore, "phase jump not yet audited");

        policies.advanceWatermark();
        assertEq(policies.lastAuditedRound(), NEXT_PHASE_FIRST, "advanced across phase");
        (bool av, uint64 eff) = _available(dealId);
        assertTrue(av, "available after advance");
        assertEq(eff, d0, "no downtime added");
        hub.finalizeAfterTimeout(dealId);

        vm.expectRevert(MidmanPolicies.NoPending.selector);
        policies.advanceWatermark();
    }

    /// @notice advanceWatermark can never skip a down round (that would drop downtime).
    function testAdvanceCannotSkipDownRound() public {
        vm.warp(10_000);
        feed.programOutage(2, 1_000, 2_000);
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        policies.advanceWatermark();
        policies.reportOutage(2);
        assertEq(policies.lastAuditedRound(), 3);
    }

    /// @notice reportOutage still refuses to skip ahead of the next round.
    function testReportOutageMustBeNextRound() public {
        vm.warp(10_000);
        feed.programOutage(2, 1_000, 2_000);
        feed.programOutage(4, 3_000, 4_000);
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        policies.reportOutage(4);
    }

    function _rotateTo(MockFeed next) internal {
        vm.prank(governance);
        policies.proposeFeed(address(next));
        vm.warp(block.timestamp + 72 hours);
    }

    /// @notice Feed rotation reseeds the watermark from the new feed's head.
    function testFeedRotationReseedsWatermark() public {
        (bytes32 dealId,) = _deliveredDeal();
        MockFeed next = new MockFeed();
        next.programUpRound(500, block.timestamp);
        _rotateTo(next);

        vm.prank(governance);
        policies.executeFeed();
        assertEq(policies.sequencerFeed(), address(next));
        assertEq(policies.lastAuditedRound(), 500, "reseeded from new head");
        (bool av,) = _available(dealId);
        assertTrue(av, "deadlines available on the new feed");
        hub.finalizeAfterTimeout(dealId);
    }

    /// @notice Unreported outages on a readable old feed block rotation.
    function testFeedRotationRequiresOldHistoryAudited() public {
        MockFeed next = new MockFeed();
        _rotateTo(next);
        feed.programOutage(2, block.timestamp - 2_000, block.timestamp - 1_000);

        vm.prank(governance);
        vm.expectRevert(MidmanPolicies.WatermarkBehind.selector);
        policies.executeFeed();

        policies.reportOutage(2);
        vm.prank(governance);
        policies.executeFeed();
        assertEq(policies.lastAuditedRound(), 1, "seeded from new feed head");
    }

    /// @notice A broken old feed (the usual reason to rotate) does not block rotation.
    function testFeedRotationAllowedWhenOldFeedBroken() public {
        MockFeed next = new MockFeed();
        _rotateTo(next);
        feed.setLatestBroken(true);
        vm.prank(governance);
        policies.executeFeed();
        assertEq(policies.sequencerFeed(), address(next));
    }
}
