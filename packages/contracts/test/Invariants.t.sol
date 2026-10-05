// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MidmanHubTest} from "./MidmanHub.t.sol";
import {HubHandler} from "./HubHandler.t.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

/// @notice Stateful invariant runs over randomized full lifecycles:
/// solvency (custody covers all liabilities) and conservation (every unit
/// in = every unit accounted for) must hold after every sequence.
contract InvariantSuite is StdInvariant, MidmanHubTest {
    HubHandler public handler;

    function setUp() public override {
        super.setUp();
        uint256[] memory bPks = new uint256[](3);
        uint256[] memory sPks = new uint256[](3);
        // Distinct from the suite's own buyer/seller keys: the handler mints
        // its own balances and must not inflate unit-test actors.
        bPks[0] = 0xB11;
        bPks[1] = 0xB12;
        bPks[2] = 0xB13;
        sPks[0] = 0x5E21;
        sPks[1] = 0x5E22;
        sPks[2] = 0x5E23;
        // pids[2] is the readiness policy; the 7200s invariant deals are the
        // <=3h tier, so use the required policy (and supply consent below).
        bytes32[8] memory pids =
            [feePolicy, categoryPolicy, readinessPolicy, evidencePolicy, bondPolicy, arbPolicy, outagePolicy, catPolicy];
        handler = new HubHandler(
            hub, policies, usdc, bPks, sPks, primaryPks, fallbackPks, vetoPks, admissionPk, pids
        );
        targetContract(address(handler));
    }

    /// @notice Custody always covers accounted liabilities (donations excluded).
    function invariant_solvency() public view {
        assertGe(usdc.balanceOf(address(hub)), hub.totalLiabilities(), "insolvent");
    }

    /// @notice funded + bonded - claimed == liabilities. Donations are
    /// excluded from both sides (they never create liabilities; solvency
    /// covers them separately).
    function invariant_conservation() public view {
        assertEq(
            handler.ghostFunded() + handler.ghostBonds(),
            hub.totalLiabilities() + handler.ghostClaimed(),
            "conservation"
        );
    }
}
