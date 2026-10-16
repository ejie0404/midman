// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MidmanHubTest} from "./MidmanHub.t.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";

/// @notice Two-step governance handover: a nominee must accept, so a mistyped
/// address can never capture (and brick) governance.
contract GovernanceHandoverTest is MidmanHubTest {
    address constant NEXT = address(0xBEEF);

    function testNominationDoesNotTransfer() public {
        vm.prank(governance);
        policies.transferGovernance(NEXT);
        assertEq(policies.governance(), governance, "still the old governance");
        assertEq(policies.pendingGovernance(), NEXT);
    }

    function testNomineeAccepts() public {
        vm.prank(governance);
        policies.transferGovernance(NEXT);
        vm.prank(NEXT);
        policies.acceptGovernance();
        assertEq(policies.governance(), NEXT);
        assertEq(policies.pendingGovernance(), address(0));

        vm.prank(governance);
        vm.expectRevert(MidmanPolicies.NotGovernance.selector);
        policies.transferGovernance(address(1));
    }

    function testOnlyNomineeCanAccept() public {
        vm.prank(governance);
        policies.transferGovernance(NEXT);
        vm.prank(address(0xBAD));
        vm.expectRevert(MidmanPolicies.NotGovernance.selector);
        policies.acceptGovernance();
    }

    function testNoAcceptWithoutNomination() public {
        vm.prank(NEXT);
        vm.expectRevert(MidmanPolicies.NotGovernance.selector);
        policies.acceptGovernance();
    }

    function testRenominationReplacesPending() public {
        vm.startPrank(governance);
        policies.transferGovernance(address(0x1111));
        policies.transferGovernance(NEXT);
        vm.stopPrank();
        vm.prank(address(0x1111));
        vm.expectRevert(MidmanPolicies.NotGovernance.selector);
        policies.acceptGovernance();
        vm.prank(NEXT);
        policies.acceptGovernance();
        assertEq(policies.governance(), NEXT);
    }

    function testOnlyGovernanceNominates() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(MidmanPolicies.NotGovernance.selector);
        policies.transferGovernance(NEXT);
    }
}
