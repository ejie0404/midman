// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockFeed} from "./Mocks.t.sol";

/// @notice Panel admission rules: required 5-member primary/fallback (3-member
/// veto), distinct members, disjoint houses, enforced identically at
/// construction and rotation (a 5-member panel can never be rotated down to 3).
contract PanelValidationTest is Test {
    MockFeed feed;

    function setUp() public {
        feed = new MockFeed();
    }

    function _panels()
        internal
        returns (address[] memory p, address[] memory f, address[] memory v)
    {
        p = new address[](5);
        f = new address[](5);
        v = new address[](3);
        for (uint256 i = 0; i < 5; i++) {
            p[i] = vm.addr(0x1001 + i);
            f[i] = vm.addr(0x2001 + i);
        }
        for (uint256 i = 0; i < 3; i++) {
            v[i] = vm.addr(0x3001 + i);
        }
    }

    function _deploy(address[] memory p, address[] memory f, address[] memory v)
        internal
        returns (MidmanPolicies)
    {
        return new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), p, f, v);
    }

    function testValidPanelsDeploy() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        MidmanPolicies pol = _deploy(p, f, v);
        assertEq(pol.authEpoch(), 1);
        assertTrue(pol.isPrimary(1, p[0]));
        assertTrue(pol.isFallback(1, f[0]));
        assertTrue(pol.isVeto(v[0]));
    }

    function testDuplicateMemberReverts() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        p[4] = p[0]; // duplicate inside primary
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        _deploy(p, f, v);
    }

    function testOverlappingHousesRevert() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        f[0] = p[0]; // primary/fallback overlap
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        _deploy(p, f, v);

        (address[] memory p2, address[] memory f2, address[] memory v2) = _panels();
        v2[1] = f2[1]; // fallback/veto overlap
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        _deploy(p2, f2, v2);
    }

    function testFourMemberPrimaryReverts() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        address[] memory four = new address[](4);
        for (uint256 i = 0; i < 4; i++) four[i] = p[i];
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        _deploy(four, f, v);
    }

    function testFourMemberFallbackReverts() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        address[] memory four = new address[](4);
        for (uint256 i = 0; i < 4; i++) four[i] = f[i];
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        _deploy(p, four, v);
    }

    function testSmallVetoReverts() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        address[] memory tiny = new address[](2);
        tiny[0] = v[0];
        tiny[1] = v[1];
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        _deploy(p, f, tiny);
    }

    function testRotationEnforcesSameRules() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        MidmanPolicies pol = _deploy(p, f, v);
        address[] memory five = new address[](5);
        for (uint256 i = 0; i < 5; i++) five[i] = vm.addr(0x5001 + i);
        five[4] = five[0]; // duplicate
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        pol.proposePanel(five, f, v);
        // Overlapping rotation proposal also rejected; epoch unchanged.
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        pol.proposePanel(f, f, v);
        assertEq(pol.authEpoch(), 1);
    }

    /// @notice A rotation can never shrink a required 5-member panel to 3.
    function testRotationToThreeMemberRejected() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        MidmanPolicies pol = _deploy(p, f, v);
        address[] memory three = new address[](3);
        for (uint256 i = 0; i < 3; i++) three[i] = vm.addr(0x6001 + i);
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        pol.proposePanel(three, f, v);
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        pol.proposePanel(p, three, v);
        assertEq(pol.authEpoch(), 1);
    }

    function testValidRotationFiveFiveThreeAccepted() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        MidmanPolicies pol = _deploy(p, f, v);
        (address[] memory np, address[] memory nf, address[] memory nv) = _panels();
        for (uint256 i = 0; i < 5; i++) {
            np[i] = vm.addr(0x7001 + i);
            nf[i] = vm.addr(0x8001 + i);
        }
        for (uint256 i = 0; i < 3; i++) nv[i] = vm.addr(0x9001 + i);
        pol.proposePanel(np, nf, nv);
        vm.warp(block.timestamp + 72 hours + 1);
        pol.executePanel();
        assertEq(pol.authEpoch(), 2);
        assertTrue(pol.isPrimary(2, np[4]));
        assertTrue(pol.isFallback(2, nf[4]));
        assertTrue(pol.isVeto(nv[2]));
        assertFalse(pol.isPrimary(2, p[0]));
    }
}
