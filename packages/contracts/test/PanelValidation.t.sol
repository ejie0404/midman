// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockFeed} from "./Mocks.t.sol";

/// @notice Panel admission rules: distinct members, disjoint houses,
/// minimum sizes matching the tier quorum table.
contract PanelValidationTest is Test {
    MockFeed feed;

    function setUp() public {
        feed = new MockFeed();
    }

    function _panels()
        internal
        returns (address[] memory p, address[] memory f, address[] memory v)
    {
        p = new address[](3);
        f = new address[](3);
        v = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            p[i] = vm.addr(0x1001 + i);
            f[i] = vm.addr(0x2001 + i);
            v[i] = vm.addr(0x3001 + i);
        }
    }

    function testValidPanelsDeploy() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        MidmanPolicies pol = new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), p, f, v);
        assertEq(pol.authEpoch(), 1);
        assertTrue(pol.isPrimary(1, p[0]));
        assertTrue(pol.isFallback(1, f[0]));
        assertTrue(pol.isVeto(v[0]));
    }

    function testDuplicateMemberReverts() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        p[2] = p[0]; // duplicate inside primary
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), p, f, v);
    }

    function testOverlappingHousesRevert() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        f[0] = p[0]; // primary/fallback overlap
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), p, f, v);

        (address[] memory p2, address[] memory f2, address[] memory v2) = _panels();
        v2[1] = f2[1]; // fallback/veto overlap
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), p2, f2, v2);
    }

    function testSmallPanelReverts() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        address[] memory tiny = new address[](2);
        tiny[0] = p[0];
        tiny[1] = p[1];
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), tiny, f, v);
    }

    function testRotationEnforcesSameRules() public {
        (address[] memory p, address[] memory f, address[] memory v) = _panels();
        MidmanPolicies pol = new MidmanPolicies(address(this), address(0x1), address(0x2), address(0x3), address(feed), p, f, v);
        address[] memory bad = new address[](3);
        bad[0] = p[0];
        bad[1] = p[1];
        bad[2] = p[1]; // duplicate
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        pol.proposePanel(bad, f, v);
        // Overlapping rotation proposal also rejected; epoch unchanged.
        vm.expectRevert(MidmanPolicies.BadPanel.selector);
        pol.proposePanel(f, f, v);
        assertEq(pol.authEpoch(), 1);
    }
}
