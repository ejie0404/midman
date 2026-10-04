// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Midman V1 full-stack deploy script.
//
// Local (anvil) default — no env vars needed:
//   anvil &
//   forge script script/Deploy.s.sol --rpc-url 127.0.0.1:8545 --broadcast
//
// Sepolia:
//   export USDC_ADDRESS=<sepolia-usdc> FEED_ADDRESS=<sequencer-feed>
//   export GOVERNANCE=<addr> PAUSER=<addr> ADMISSION_SIGNER=<addr> TREASURY=<addr>
//   export PRIMARY_PK_0/1/2 FALLBACK_PK_0/1/2 VETO_PK_0/1/2=<panel private keys>
//   forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast \
//     --verify --etherscan-api-key $ETHERSCAN_API_KEY
//
// Base / Base Sepolia: same vars with the network's native USDC + Chainlink
// Base sequencer uptime feed in FEED_ADDRESS, e.g. Base Sepolia feed +
// --rpc-url $BASE_SEPOLIA_RPC_URL. Production USDC is 6 decimals (enforced by
// MidmanHub); any USDC_ADDRESS with != 6 decimals reverts at deploy.
//
// Env-var reference (all optional, `vm.envOr` defaults shown in run()):
//   USDC_ADDRESS, FEED_ADDRESS,
//   GOVERNANCE, PAUSER, ADMISSION_SIGNER, TREASURY,
//   PRIMARY_ADDR_<i> / PRIMARY_PK_<i>, FALLBACK_ADDR_<i> / FALLBACK_PK_<i>,
//   VETO_ADDR_<i> / VETO_PK_<i>  (i = 0..2; ADDR wins over PK; fallback is a
//   deterministic local key 0x101... so anvil works with zero config).
// NOTE: the broadcaster must equal GOVERNANCE for the 8 policy registrations
// below (default: GOVERNANCE = broadcaster). To onboard a foreign governance,
// deploy first, transferGovernance, then register from that address.

import {Script, console} from "forge-std/Script.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockUSDC, MockFeed} from "../test/Mocks.t.sol";

contract Deploy is Script {
    // Standard policy IDs (keccak of stable names; content hashes logged).
    bytes32 internal constant FEE_ID = keccak256("MIDMAN.FEE.v1");
    bytes32 internal constant CAT_ID = keccak256("MIDMAN.CATEGORY.v1");
    bytes32 internal constant READY_ID = keccak256("MIDMAN.READINESS.NONE.v1");
    bytes32 internal constant EVI_ID = keccak256("MIDMAN.EVIDENCE.v1");
    bytes32 internal constant BOND_ID = keccak256("MIDMAN.BOND.5USDC.v1");
    bytes32 internal constant ARB_ID = keccak256("MIDMAN.ARBITRATION.ALL.v1");
    bytes32 internal constant OUT_ID = keccak256("MIDMAN.OUTAGE.v1");
    bytes32 internal constant ESC_ID = keccak256("MIDMAN.CATASTROPHIC.v1");

    /// @notice ADDR_<i> wins; else PK_<i> via vm.addr; else deterministic local key.
    function _panelAddr(string memory prefix, uint256 i, uint256 defaultPk) internal returns (address) {
        address a = vm.envOr(string.concat(prefix, "_ADDR_", vm.toString(i)), address(0));
        if (a != address(0)) return a;
        uint256 pk = vm.envOr(string.concat(prefix, "_PK_", vm.toString(i)), uint256(0));
        if (pk != 0) return vm.addr(pk);
        return vm.addr(defaultPk);
    }

    function run() external {
        address deployer = msg.sender;
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));
        address feedAddr = vm.envOr("FEED_ADDRESS", address(0));
        address governance = vm.envOr("GOVERNANCE", deployer);
        address pauser = vm.envOr("PAUSER", deployer);
        address admission = vm.envOr("ADMISSION_SIGNER", deployer);
        address treasury = vm.envOr("TREASURY", deployer);

        address[] memory primary = new address[](5);
        address[] memory fb = new address[](5);
        address[] memory veto = new address[](3);
        for (uint256 i = 0; i < 5; i++) {
            primary[i] = _panelAddr("PRIMARY", i, 0x101 + i);
            fb[i] = _panelAddr("FALLBACK", i, 0x201 + i);
        }
        for (uint256 i = 0; i < 3; i++) {
            veto[i] = _panelAddr("VETO", i, 0x301 + i);
        }

        vm.startBroadcast();
        if (usdcAddr == address(0)) {
            usdcAddr = address(new MockUSDC());
        }
        if (feedAddr == address(0)) {
            feedAddr = address(new MockFeed());
        }
        MidmanPolicies policies =
            new MidmanPolicies(governance, pauser, admission, treasury, feedAddr, primary, fb, veto);
        MidmanHub hub = new MidmanHub(usdcAddr, address(policies));

        // 8 standard policies: fee / cat min 3600 / no-readiness / evidence /
        // 5-USDC bonds / all-tiers arb / outage grace 1800 max 8 / catastrophic.
        policies.registerFeePolicy(FEE_ID, keccak256("MIDMAN.FEE.content.v1"));
        policies.registerCategoryPolicy(CAT_ID, keccak256("MIDMAN.CATEGORY.content.v1"), 3_600);
        policies.registerReadinessPolicy(READY_ID, keccak256("MIDMAN.READINESS.content.v1"), false);
        policies.registerEvidencePolicy(EVI_ID, keccak256("MIDMAN.EVIDENCE.content.v1"));
        policies.registerBondPolicy(BOND_ID, keccak256("MIDMAN.BOND.content.v1"), 5_000_000, 5_000_000);
        policies.registerArbitrationPolicy(ARB_ID, keccak256("MIDMAN.ARBITRATION.content.v1"), 0x07);
        policies.registerOutagePolicy(OUT_ID, keccak256("MIDMAN.OUTAGE.content.v1"), 1_800, 8);
        policies.registerCatastrophicPolicy(ESC_ID, keccak256("MIDMAN.CATASTROPHIC.content.v1"));
        vm.stopBroadcast();

        console.log("USDC:", usdcAddr);
        console.log("FEED:", feedAddr);
        console.log("POLICIES:", address(policies));
        console.log("HUB:", address(hub));
        console.log("GOVERNANCE:", governance);
        console.log("PAUSER:", pauser);
        console.log("ADMISSION:", admission);
        console.log("TREASURY:", treasury);
        for (uint256 i = 0; i < 5; i++) {
            console.log(string.concat("PRIMARY_", vm.toString(i), ":"), primary[i]);
            console.log(string.concat("FALLBACK_", vm.toString(i), ":"), fb[i]);
        }
        for (uint256 i = 0; i < 3; i++) {
            console.log(string.concat("VETO_", vm.toString(i), ":"), veto[i]);
        }
        console.logBytes32(FEE_ID);
        console.logBytes32(CAT_ID);
        console.logBytes32(READY_ID);
        console.logBytes32(EVI_ID);
        console.logBytes32(BOND_ID);
        console.logBytes32(ARB_ID);
        console.logBytes32(OUT_ID);
        console.logBytes32(ESC_ID);
    }
}
