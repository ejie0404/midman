// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Midman V1 DEVELOPMENT-ONLY deploy script (audit finding #11).
//
//   ###########################################################################
//   #                                                                         #
//   #   DEV ONLY - DO NOT USE WITH REAL FUNDS                                  #
//   #                                                                         #
//   #   This script deploys MockUSDC and MockFeed, uses well-known anvil       #
//   #   panel addresses, and registers development policy content hashes.      #
//   #   It must never be broadcast to a public network. Use DeployProd.s.sol   #
//   #   for any network that handles real value.                              #
//   #                                                                         #
//   ###########################################################################
//
// Local anvil flow (no env vars needed):
//   anvil &
//   forge script script/DeployDev.s.sol --rpc-url 127.0.0.1:8545 --broadcast
//
// The 8 policies are registered against the canonical on-chain policy IDs and
// the canonical content hashes recorded in deploy/manifest.example.json
// (recompute them any time with: node scripts/policy-hash.mjs). Category
// min-inspection is 3600s, readiness is not required, bonds are 5 USDC,
// arbitration covers all three tiers, and outage grace is 1800s / max 8
// intervals, matching the canonical policy records.

import {Script, console} from "forge-std/Script.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockUSDC, MockFeed} from "../test/Mocks.t.sol";
import {DeployPolicyIds} from "./DeployProd.s.sol";

/// @notice Development deployment logic, factored into an internal function so
/// test/DeployScripts.t.sol can assert on the mocks, panels and registrations.
abstract contract DeployDevBase {
    // Well-known anvil default-mnemonic accounts 1..9. Account 0 is left free
    // for the broadcaster/governance role.
    address internal constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant ANVIL_4 = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address internal constant ANVIL_5 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
    address internal constant ANVIL_6 = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
    address internal constant ANVIL_7 = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;
    address internal constant ANVIL_8 = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
    address internal constant ANVIL_9 = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    // Canonical policy content hashes, identical to deploy/manifest.example.json
    // (keccak256 of the canonical deploy/policies/*.json records).
    bytes32 internal constant FEE_CONTENT = 0x7fecf4ea3c45d31cf07fa4272da2ae302403f68449a2b9d502b1263d26dd05bd;
    bytes32 internal constant CATEGORY_CONTENT = 0xf355271ec479a145e5ba77f7fd4e53d552a0f4b2f71a58ec6ff0c2fee9cd5d43;
    bytes32 internal constant READINESS_CONTENT = 0xf7fb738c0f9e77aaa164294b9d9dbaa62c30d62a8f3d7cbec0db13eea6b71a90;
    bytes32 internal constant EVIDENCE_CONTENT = 0x70354cc8f1a5d49205f8cb56a2140ece30afac4d0b1c65a9970bf7c387be23e7;
    bytes32 internal constant BOND_CONTENT = 0x085dc20c99350f8573137c7dc2efb5c7a5ce41084a215999e579f4a074e341ce;
    bytes32 internal constant ARBITRATION_CONTENT = 0x74a5f2aec27bb8ef303bab93c70da0a965c3460e5f342bf6448b5de8e1a522c9;
    bytes32 internal constant OUTAGE_CONTENT = 0xcf092d5c3dc67e90f46374b85e5c646b9a443d80d7e466c27d2ee7f301d94e22;
    bytes32 internal constant CATASTROPHIC_CONTENT = 0xdafba6e467ff5b83d4d9c50fe4d6480369ffa7f4eecf2e07661687de6e112a92;

    struct DevConfig {
        address governance;
        address pauser;
        address admissionSigner;
        address treasury;
        address[] primary;
        address[] fallbackPanel;
        address[] veto;
    }

    struct DevDeployment {
        address usdc;
        address feed;
        address policies;
        address hub;
    }

    /// @notice Deterministic 3/3/3 anvil panels reused by the script and tests.
    function devPanelAddresses()
        internal
        pure
        returns (address[] memory primary, address[] memory fallbackPanel, address[] memory veto)
    {
        primary = new address[](3);
        fallbackPanel = new address[](3);
        veto = new address[](3);
        primary[0] = ANVIL_1;
        primary[1] = ANVIL_2;
        primary[2] = ANVIL_3;
        fallbackPanel[0] = ANVIL_4;
        fallbackPanel[1] = ANVIL_5;
        fallbackPanel[2] = ANVIL_6;
        veto[0] = ANVIL_7;
        veto[1] = ANVIL_8;
        veto[2] = ANVIL_9;
    }

    function _deployDev(DevConfig memory c) internal returns (DevDeployment memory out) {
        require(c.governance != address(0), "DeployDev: governance required");
        MockUSDC usdc = new MockUSDC();
        MockFeed feed = new MockFeed();
        MidmanPolicies policies = new MidmanPolicies(
            c.governance, c.pauser, c.admissionSigner, c.treasury, address(feed), c.primary, c.fallbackPanel, c.veto
        );
        policies.registerFeePolicy(DeployPolicyIds.FEE, FEE_CONTENT);
        policies.registerCategoryPolicy(DeployPolicyIds.CATEGORY, CATEGORY_CONTENT, 3_600);
        policies.registerReadinessPolicy(DeployPolicyIds.READINESS, READINESS_CONTENT, false);
        policies.registerEvidencePolicy(DeployPolicyIds.EVIDENCE, EVIDENCE_CONTENT);
        policies.registerBondPolicy(DeployPolicyIds.BOND, BOND_CONTENT, 5_000_000, 5_000_000);
        policies.registerArbitrationPolicy(DeployPolicyIds.ARBITRATION, ARBITRATION_CONTENT, 0x07);
        policies.registerOutagePolicy(DeployPolicyIds.OUTAGE, OUTAGE_CONTENT, 1_800, 8);
        policies.registerCatastrophicPolicy(DeployPolicyIds.CATASTROPHIC, CATASTROPHIC_CONTENT);
        MidmanHub hub = new MidmanHub(address(usdc), address(policies));
        out = DevDeployment({
            usdc: address(usdc),
            feed: address(feed),
            policies: address(policies),
            hub: address(hub)
        });
    }
}

contract DeployDev is Script, DeployDevBase {
    function run() external returns (DevDeployment memory out) {
        address deployer = msg.sender;
        (address[] memory primary, address[] memory fallbackPanel, address[] memory veto) = devPanelAddresses();
        DevConfig memory c = DevConfig({
            governance: deployer,
            pauser: deployer,
            admissionSigner: deployer,
            treasury: deployer,
            primary: primary,
            fallbackPanel: fallbackPanel,
            veto: veto
        });

        console.log("###########################################################");
        console.log("#                                                         #");
        console.log("#   DEV ONLY - DO NOT USE WITH REAL FUNDS                  #");
        console.log("#   MockUSDC + MockFeed + anvil panel addresses.           #");
        console.log("#   For any network with real value use DeployProd.s.sol.  #");
        console.log("#                                                         #");
        console.log("###########################################################");

        vm.startBroadcast();
        out = _deployDev(c);
        vm.stopBroadcast();

        console.log("");
        console.log("USDC (MockUSDC):", out.usdc);
        console.log("FEED (MockFeed):", out.feed);
        console.log("POLICIES:", out.policies);
        console.log("HUB:", out.hub);
        console.log("GOVERNANCE:", c.governance);
        console.log("PAUSER:", c.pauser);
        console.log("ADMISSION:", c.admissionSigner);
        console.log("TREASURY:", c.treasury);
        for (uint256 i = 0; i < primary.length; i++) {
            console.log(string.concat("PRIMARY_", vm.toString(i), ":"), primary[i]);
            console.log(string.concat("FALLBACK_", vm.toString(i), ":"), fallbackPanel[i]);
            console.log(string.concat("VETO_", vm.toString(i), ":"), veto[i]);
        }
        console.log("POLICIES_CODEHASH:");
        console.logBytes32(address(out.policies).codehash);
        console.log("HUB_CODEHASH:");
        console.logBytes32(address(out.hub).codehash);
        console.log("POLICY_IDS:");
        console.logBytes32(DeployPolicyIds.FEE);
        console.logBytes32(DeployPolicyIds.CATEGORY);
        console.logBytes32(DeployPolicyIds.READINESS);
        console.logBytes32(DeployPolicyIds.EVIDENCE);
        console.logBytes32(DeployPolicyIds.BOND);
        console.logBytes32(DeployPolicyIds.ARBITRATION);
        console.logBytes32(DeployPolicyIds.OUTAGE);
        console.logBytes32(DeployPolicyIds.CATASTROPHIC);
    }
}
