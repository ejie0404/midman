// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Midman V1 PRODUCTION deploy script (audit finding #11 hardening).
//
// This script refuses to silently fall back to anything. Every role, token,
// feed, panel member and policy content hash must be supplied explicitly and
// is validated before a byte reaches the chain. In particular:
//   * NO mock token / mock feed fallback: a missing USDC_ADDRESS or
//     FEED_ADDRESS reverts.
//   * Panels are validated up front: >=5 primary, >=5 fallback, >=3 veto,
//     all non-zero, distinct within a house and disjoint across houses.
//   * CHAIN_ID must be supplied; the live chain id must match it. 8453 (Base
//     mainnet) is the intended value, any other value is treated as an
//     explicit override and logged as a warning.
//   * The broadcaster MUST equal GOVERNANCE: policy registration is
//     governance-only and happens in the same broadcast as the deployment.
//     To hand governance to a multisig, deploy with GOVERNANCE = deployer and
//     call transferGovernance afterwards and acceptGovernance from the new
//     governance (two-step handover).
//
// Policy content hashes MUST come from scripts/policy-hash.mjs, which hashes
// the canonical records under deploy/policies/*.json. They are registered
// against the canonical on-chain policy IDs (same IDs as script/Deploy.s.sol).
// Registration is append-only: an already-registered ID reverts.
//
// Usage:
//   export CHAIN_ID=8453
//   export USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
//   export FEED_ADDRESS=0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
//   export GOVERNANCE=0x... PAUSER=0x... ADMISSION_SIGNER=0x... TREASURY=0x...
//   export PANEL_PRIMARY=0x..,0x..,0x..,0x..,0x..
//   export PANEL_FALLBACK=0x..,0x..,0x..,0x..,0x..
//   export PANEL_VETO=0x..,0x..,0x..
//   export POLICY_FEE=0x... POLICY_CATEGORY=0x... POLICY_READINESS=0x...
//   export POLICY_EVIDENCE=0x... POLICY_BOND=0x... POLICY_ARBITRATION=0x...
//   export POLICY_OUTAGE=0x... POLICY_CATASTROPHIC=0x...
//   forge script script/DeployProd.s.sol --rpc-url $BASE_RPC_URL --broadcast \
//     --verify --etherscan-api-key $ETHERSCAN_API_KEY
//
// Env-var reference (all REQUIRED, no defaults):
//   CHAIN_ID, USDC_ADDRESS, FEED_ADDRESS, GOVERNANCE, PAUSER,
//   ADMISSION_SIGNER, TREASURY, PANEL_PRIMARY, PANEL_FALLBACK, PANEL_VETO,
//   POLICY_FEE, POLICY_CATEGORY, POLICY_READINESS, POLICY_EVIDENCE,
//   POLICY_BOND, POLICY_ARBITRATION, POLICY_OUTAGE, POLICY_CATASTROPHIC.

import {Script, console} from "forge-std/Script.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";

/// @notice Canonical on-chain policy IDs (keccak of stable names). Shared with
/// DeployDev.s.sol and the deploy tests; content hashes are supplied separately
/// and must come from scripts/policy-hash.mjs.
library DeployPolicyIds {
    bytes32 internal constant FEE = keccak256("MIDMAN.FEE.v1");
    bytes32 internal constant CATEGORY = keccak256("MIDMAN.CATEGORY.v1");
    bytes32 internal constant READINESS = keccak256("MIDMAN.READINESS.NONE.v1");
    bytes32 internal constant EVIDENCE = keccak256("MIDMAN.EVIDENCE.v1");
    bytes32 internal constant BOND = keccak256("MIDMAN.BOND.5USDC.v1");
    bytes32 internal constant ARBITRATION = keccak256("MIDMAN.ARBITRATION.ALL.v1");
    bytes32 internal constant OUTAGE = keccak256("MIDMAN.OUTAGE.v1");
    bytes32 internal constant CATASTROPHIC = keccak256("MIDMAN.CATASTROPHIC.v1");

    // Approved per-category minimum-inspection matrix (six V1 categories).
    bytes32 internal constant CATEGORY_INSTANT_CODE = keccak256("MIDMAN.CATEGORY.INSTANT_CODE.v1");
    bytes32 internal constant CATEGORY_GAME_ITEM = keccak256("MIDMAN.CATEGORY.GAME_ITEM.v1");
    bytes32 internal constant CATEGORY_GAME_CURRENCY = keccak256("MIDMAN.CATEGORY.GAME_CURRENCY.v1");
    bytes32 internal constant CATEGORY_DIGITAL_GOOD = keccak256("MIDMAN.CATEGORY.DIGITAL_GOOD.v1");
    bytes32 internal constant CATEGORY_SERVICE = keccak256("MIDMAN.CATEGORY.SERVICE.v1");
    bytes32 internal constant CATEGORY_GAME_ACCOUNT = keccak256("MIDMAN.CATEGORY.GAME_ACCOUNT.v1");
    // Readiness-required policy for the <=3h pricing tier.
    bytes32 internal constant READINESS_REQUIRED = keccak256("MIDMAN.READINESS.REQUIRED.v1");
}

/// @notice Canonical on-chain policy VALUES, identical to the reviewed
/// off-chain records under deploy/policies/*.json. They are pinned here (rather
/// than repeated as magic numbers in two scripts) so DeployProd, DeployDev and
/// the deployment verifier agree on one source of truth. `scripts/verify-deployment.mjs`
/// reads these exact values back from the registry and fails on any drift
/// against the manifest `policyValues` block.
library DeployPolicyValues {
    // category-v1: canonical INSTANT_CODE minimum inspection window.
    uint32 internal constant CATEGORY_MIN_INSPECTION = 3_600;
    // Approved per-category minimum inspection windows (P-10/P-12).
    uint32 internal constant CATEGORY_MIN_INSTANT_CODE = 3_600;
    uint32 internal constant CATEGORY_MIN_GAME_ITEM = 43_200;
    uint32 internal constant CATEGORY_MIN_GAME_CURRENCY = 43_200;
    uint32 internal constant CATEGORY_MIN_DIGITAL_GOOD = 43_200;
    uint32 internal constant CATEGORY_MIN_SERVICE = 43_200;
    uint32 internal constant CATEGORY_MIN_GAME_ACCOUNT = 86_400;
    // readiness-v1: canonical no-readiness marker (required == false).
    bool internal constant READINESS_REQUIRED = false;
    // readiness-required marker for the <=3h pricing tier (required == true).
    bool internal constant READINESS_REQUIRED_FLAG = true;
    // bond-v1: 5 USDC (6 decimals) per contesting party.
    uint256 internal constant BOND_CLAIMANT = 5_000_000;
    uint256 internal constant BOND_RESPONDENT = 5_000_000;
    // arbitration-v1: all three principal tiers allowed (bits 0,1,2).
    uint8 internal constant ARBITRATION_TIERS_ALLOWED = 0x07;
    // outage-v1: 30-minute recovery grace, at most 8 retained intervals.
    uint32 internal constant OUTAGE_GRACE_SECONDS = 1_800;
    uint8 internal constant OUTAGE_MAX_INTERVALS = 8;
}


/// @notice Production deployment logic, factored into an internal function that
/// takes explicit arguments so test/DeployScripts.t.sol can drive it without
/// vm.env or a broadcast. `registrar` is the address that will call the
/// governance-only policy registrations; callers must ensure the executing
/// context matches it (broadcast sender in a script, a pranked caller in a test).
abstract contract DeployProdBase {
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant MIN_PRIMARY = 5;
    uint256 internal constant MIN_FALLBACK = 5;
    uint256 internal constant MIN_VETO = 3;

    struct ProdConfig {
        uint256 chainId;
        address usdc;
        address feed;
        address governance;
        address pauser;
        address admissionSigner;
        address treasury;
        address[] primary;
        address[] fallbackPanel;
        address[] veto;
        bytes32 feeHash;
        bytes32 categoryHash;
        bytes32 readinessHash;
        bytes32 evidenceHash;
        bytes32 bondHash;
        bytes32 arbitrationHash;
        bytes32 outageHash;
        bytes32 catastrophicHash;
    }

    struct ProdDeployment {
        address policies;
        address hub;
    }

    // ---- Validation ----

    function _validateProd(ProdConfig memory c, address registrar) internal view {
        require(c.chainId != 0, "DeployProd: CHAIN_ID required");
        require(block.chainid == c.chainId, "DeployProd: chain id mismatch (set CHAIN_ID explicitly)");
        _requireNonZero(c.usdc, "USDC_ADDRESS");
        _requireNonZero(c.feed, "FEED_ADDRESS");
        _requireNonZero(c.governance, "GOVERNANCE");
        _requireNonZero(c.pauser, "PAUSER");
        _requireNonZero(c.admissionSigner, "ADMISSION_SIGNER");
        _requireNonZero(c.treasury, "TREASURY");
        _validateProdPanels(c.primary, c.fallbackPanel, c.veto);
        require(c.feeHash != bytes32(0), "DeployProd: POLICY_FEE required");
        require(c.categoryHash != bytes32(0), "DeployProd: POLICY_CATEGORY required");
        require(c.readinessHash != bytes32(0), "DeployProd: POLICY_READINESS required");
        require(c.evidenceHash != bytes32(0), "DeployProd: POLICY_EVIDENCE required");
        require(c.bondHash != bytes32(0), "DeployProd: POLICY_BOND required");
        require(c.arbitrationHash != bytes32(0), "DeployProd: POLICY_ARBITRATION required");
        require(c.outageHash != bytes32(0), "DeployProd: POLICY_OUTAGE required");
        require(c.catastrophicHash != bytes32(0), "DeployProd: POLICY_CATASTROPHIC required");
        require(registrar == c.governance, "DeployProd: broadcaster must equal GOVERNANCE");
    }

    function _requireNonZero(address value, string memory label) internal pure {
        require(value != address(0), string.concat("DeployProd: ", label, " required and non-zero"));
    }

    /// @notice Deterministic per-variant content commitment derived from the
    /// canonical category/readiness record hash + variant name.
    function _derived(bytes32 base, string memory name) internal pure returns (bytes32) {
        return keccak256(abi.encode(base, name));
    }

    /// @notice Register the six approved category minimums.
    function _registerCategoryMatrix(MidmanPolicies policies, bytes32 base) internal {
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY_INSTANT_CODE, _derived(base, "INSTANT_CODE"), DeployPolicyValues.CATEGORY_MIN_INSTANT_CODE
        );
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY_GAME_ITEM, _derived(base, "GAME_ITEM"), DeployPolicyValues.CATEGORY_MIN_GAME_ITEM
        );
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY_GAME_CURRENCY,
            _derived(base, "GAME_CURRENCY"),
            DeployPolicyValues.CATEGORY_MIN_GAME_CURRENCY
        );
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY_DIGITAL_GOOD,
            _derived(base, "DIGITAL_GOOD"),
            DeployPolicyValues.CATEGORY_MIN_DIGITAL_GOOD
        );
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY_SERVICE, _derived(base, "SERVICE"), DeployPolicyValues.CATEGORY_MIN_SERVICE
        );
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY_GAME_ACCOUNT,
            _derived(base, "GAME_ACCOUNT"),
            DeployPolicyValues.CATEGORY_MIN_GAME_ACCOUNT
        );
    }

    function _validateProdPanels(address[] memory p, address[] memory f, address[] memory v) internal pure {
        require(p.length >= MIN_PRIMARY, "DeployProd: PANEL_PRIMARY needs >=5 members");
        require(f.length >= MIN_FALLBACK, "DeployProd: PANEL_FALLBACK needs >=5 members");
        require(v.length >= MIN_VETO, "DeployProd: PANEL_VETO needs >=3 members");
        _distinctProd(p, "PANEL_PRIMARY");
        _distinctProd(f, "PANEL_FALLBACK");
        _distinctProd(v, "PANEL_VETO");
        for (uint256 i = 0; i < p.length; i++) {
            require(p[i] != address(0), "DeployProd: PANEL_PRIMARY zero address");
            for (uint256 j = 0; j < f.length; j++) {
                require(p[i] != f[j], "DeployProd: primary/fallback panels overlap");
            }
            for (uint256 j = 0; j < v.length; j++) {
                require(p[i] != v[j], "DeployProd: primary/veto panels overlap");
            }
        }
        for (uint256 i = 0; i < f.length; i++) {
            require(f[i] != address(0), "DeployProd: PANEL_FALLBACK zero address");
            for (uint256 j = 0; j < v.length; j++) {
                require(f[i] != v[j], "DeployProd: fallback/veto panels overlap");
            }
        }
        for (uint256 i = 0; i < v.length; i++) {
            require(v[i] != address(0), "DeployProd: PANEL_VETO zero address");
        }
    }

    function _distinctProd(address[] memory panel, string memory label) internal pure {
        for (uint256 i = 0; i < panel.length; i++) {
            for (uint256 j = i + 1; j < panel.length; j++) {
                require(panel[i] != panel[j], string.concat("DeployProd: ", label, " has duplicate member"));
            }
        }
    }

    // ---- Deployment ----

    function _deployProd(ProdConfig memory c, address registrar) internal returns (ProdDeployment memory out) {
        _validateProd(c, registrar);
        MidmanPolicies policies =
            new MidmanPolicies(c.governance, c.pauser, c.admissionSigner, c.treasury, c.feed, c.primary, c.fallbackPanel, c.veto);
        policies.registerFeePolicy(DeployPolicyIds.FEE, c.feeHash);
        policies.registerCategoryPolicy(
            DeployPolicyIds.CATEGORY, c.categoryHash, DeployPolicyValues.CATEGORY_MIN_INSPECTION
        );
        policies.registerReadinessPolicy(
            DeployPolicyIds.READINESS, c.readinessHash, DeployPolicyValues.READINESS_REQUIRED
        );
        // Approved category matrix: one policy per category with its minimum
        // inspection window, plus the readiness-required variant for <=3h deals.
        _registerCategoryMatrix(policies, c.categoryHash);
        policies.registerReadinessPolicy(
            DeployPolicyIds.READINESS_REQUIRED,
            _derived(c.readinessHash, "REQUIRED"),
            DeployPolicyValues.READINESS_REQUIRED_FLAG
        );
        policies.registerEvidencePolicy(DeployPolicyIds.EVIDENCE, c.evidenceHash);
        policies.registerBondPolicy(
            DeployPolicyIds.BOND, c.bondHash, DeployPolicyValues.BOND_CLAIMANT, DeployPolicyValues.BOND_RESPONDENT
        );
        policies.registerArbitrationPolicy(
            DeployPolicyIds.ARBITRATION, c.arbitrationHash, DeployPolicyValues.ARBITRATION_TIERS_ALLOWED
        );
        policies.registerOutagePolicy(
            DeployPolicyIds.OUTAGE,
            c.outageHash,
            DeployPolicyValues.OUTAGE_GRACE_SECONDS,
            DeployPolicyValues.OUTAGE_MAX_INTERVALS
        );
        policies.registerCatastrophicPolicy(DeployPolicyIds.CATASTROPHIC, c.catastrophicHash);
        MidmanHub hub = new MidmanHub(c.usdc, address(policies));
        out = ProdDeployment({policies: address(policies), hub: address(hub)});
    }

    // ---- Comma-separated address list parsing ----

    function _parseCsvAddresses(string memory csv, string memory label) internal pure returns (address[] memory) {
        bytes memory raw = bytes(csv);
        require(raw.length > 0, string.concat("DeployProd: ", label, " is empty"));
        uint256 count = 1;
        for (uint256 i = 0; i < raw.length; i++) {
            if (raw[i] == bytes1(0x2c)) count++;
        }
        address[] memory out = new address[](count);
        uint256 start = 0;
        uint256 idx = 0;
        for (uint256 i = 0; i <= raw.length; i++) {
            if (i == raw.length || raw[i] == bytes1(0x2c)) {
                string memory token = _trim(_slice(csv, start, i));
                require(bytes(token).length == 42, string.concat("DeployProd: ", label, " malformed address"));
                address parsed = _parseHexAddress(token);
                require(parsed != address(0), string.concat("DeployProd: ", label, " zero address"));
                out[idx] = parsed;
                idx++;
                start = i + 1;
            }
        }
        return out;
    }

    function _slice(string memory s, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = b[i];
        return string(out);
    }

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 start = 0;
        uint256 end = b.length;
        while (start < end && (b[start] == bytes1(0x20) || b[start] == bytes1(0x09))) start++;
        while (end > start && (b[end - 1] == bytes1(0x20) || b[end - 1] == bytes1(0x09))) end--;
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = b[i];
        return string(out);
    }

    function _parseHexAddress(string memory s) internal pure returns (address) {
        bytes memory b = bytes(s);
        if (b.length != 42) return address(0);
        if (b[0] != bytes1(0x30) || (b[1] != bytes1(0x78) && b[1] != bytes1(0x58))) return address(0);
        uint160 acc = 0;
        for (uint256 i = 2; i < 42; i++) {
            uint8 v = _hexVal(b[i]);
            if (v == 255) return address(0);
            acc = (acc << 4) | uint160(v);
        }
        return address(acc);
    }

    function _hexVal(bytes1 c) internal pure returns (uint8) {
        uint8 x = uint8(c);
        if (x >= 0x30 && x <= 0x39) return x - 0x30;
        if (x >= 0x61 && x <= 0x66) return x - 0x57;
        if (x >= 0x41 && x <= 0x46) return x - 0x37;
        return 255;
    }
}

contract DeployProd is Script, DeployProdBase {
    function run() external returns (ProdDeployment memory out) {
        ProdConfig memory c;
        c.chainId = vm.envOr("CHAIN_ID", uint256(0));
        c.usdc = vm.envOr("USDC_ADDRESS", address(0));
        c.feed = vm.envOr("FEED_ADDRESS", address(0));
        c.governance = vm.envOr("GOVERNANCE", address(0));
        c.pauser = vm.envOr("PAUSER", address(0));
        c.admissionSigner = vm.envOr("ADMISSION_SIGNER", address(0));
        c.treasury = vm.envOr("TREASURY", address(0));
        c.primary = _parseCsvAddresses(vm.envOr("PANEL_PRIMARY", string("")), "PANEL_PRIMARY");
        c.fallbackPanel = _parseCsvAddresses(vm.envOr("PANEL_FALLBACK", string("")), "PANEL_FALLBACK");
        c.veto = _parseCsvAddresses(vm.envOr("PANEL_VETO", string("")), "PANEL_VETO");
        c.feeHash = vm.envOr("POLICY_FEE", bytes32(0));
        c.categoryHash = vm.envOr("POLICY_CATEGORY", bytes32(0));
        c.readinessHash = vm.envOr("POLICY_READINESS", bytes32(0));
        c.evidenceHash = vm.envOr("POLICY_EVIDENCE", bytes32(0));
        c.bondHash = vm.envOr("POLICY_BOND", bytes32(0));
        c.arbitrationHash = vm.envOr("POLICY_ARBITRATION", bytes32(0));
        c.outageHash = vm.envOr("POLICY_OUTAGE", bytes32(0));
        c.catastrophicHash = vm.envOr("POLICY_CATASTROPHIC", bytes32(0));

        console.log("========================================================");
        console.log("Midman V1 PRODUCTION deployment (hardened, no fallbacks)");
        console.log("========================================================");
        if (c.chainId != BASE_CHAIN_ID) {
            console.log("WARNING: CHAIN_ID is not 8453; explicit non-Base override.");
            console.logUint(c.chainId);
        }

        vm.startBroadcast();
        out = _deployProd(c, msg.sender);
        vm.stopBroadcast();

        _printManifest(c, out);
    }

    function _printManifest(ProdConfig memory c, ProdDeployment memory out) internal view {
        console.log("");
        console.log("===== DEPLOYMENT MANIFEST SKELETON (fill deploy/manifest.<chain>.json) =====");
        console.log(string.concat('  "contracts": {'));
        console.log(string.concat('    "usdc": "', vm.toString(c.usdc), '",'));
        console.log(string.concat('    "sequencerFeed": "', vm.toString(c.feed), '",'));
        console.log(string.concat('    "policies": "', vm.toString(out.policies), '",'));
        console.log(string.concat('    "hub": "', vm.toString(out.hub), '",'));
        console.log(string.concat('    "policiesCodeHash": "', vm.toString(address(out.policies).codehash), '",'));
        console.log(string.concat('    "hubCodeHash": "', vm.toString(address(out.hub).codehash), '"'));
        console.log(string.concat('  },'));
        console.log(string.concat('  "roles": {'));
        console.log(string.concat('    "governanceTimelock": "', vm.toString(c.governance), '",'));
        console.log(string.concat('    "pauser": "', vm.toString(c.pauser), '",'));
        console.log(string.concat('    "admissionSigner": "', vm.toString(c.admissionSigner), '",'));
        console.log(string.concat('    "treasury": "', vm.toString(c.treasury), '"'));
        console.log(string.concat('  },'));
        console.log(string.concat('  "domain": { "name": "MidmanEscrow", "version": "1", "chainId": ', vm.toString(c.chainId), ','));
        console.log(string.concat('              "verifyingContract": "', vm.toString(out.hub), '" },'));
        _printPanel("primaryPanel", c.primary);
        _printPanel("fallbackPanel", c.fallbackPanel);
        _printPanel("vetoPanel", c.veto);
        _printPolicyValues();
        _printGovernanceValues(out.policies);
        console.log("policyIds:");
        console.logBytes32(DeployPolicyIds.FEE);
        console.logBytes32(DeployPolicyIds.CATEGORY);
        console.logBytes32(DeployPolicyIds.READINESS);
        console.logBytes32(DeployPolicyIds.EVIDENCE);
        console.logBytes32(DeployPolicyIds.BOND);
        console.logBytes32(DeployPolicyIds.ARBITRATION);
        console.logBytes32(DeployPolicyIds.OUTAGE);
        console.logBytes32(DeployPolicyIds.CATASTROPHIC);
        console.log("===== END MANIFEST SKELETON =====");
    }

    function _printPanel(string memory name, address[] memory panel) internal pure {
        console.log(string.concat("  \"", name, "\": ["));
        for (uint256 i = 0; i < panel.length; i++) {
            console.log(string.concat("    \"", vm.toString(panel[i]), "\"", i + 1 < panel.length ? "," : ""));
        }
        console.log("  ],");
    }

    /// @notice Emit the registered policy VALUES so the operator can copy them
    /// verbatim into the manifest `policyValues` block; scripts/verify-deployment.mjs
    /// then reads them back from the registry and fails on any drift.
    function _printPolicyValues() internal pure {
        console.log("policyValues:");
        console.log(string.concat('  "category-v1": { "minInspectionSeconds": "', vm.toString(uint256(DeployPolicyValues.CATEGORY_MIN_INSPECTION)), '" },'));
        console.log(string.concat('  "readiness-v1": { "required": ', DeployPolicyValues.READINESS_REQUIRED ? "true" : "false", ' },'));
        console.log(string.concat('  "bond-v1": { "claimantBondUnits": "', vm.toString(DeployPolicyValues.BOND_CLAIMANT), '", "respondentBondUnits": "', vm.toString(DeployPolicyValues.BOND_RESPONDENT), '" },'));
        console.log(string.concat('  "arbitration-v1": { "tiersAllowed": "', vm.toString(uint256(DeployPolicyValues.ARBITRATION_TIERS_ALLOWED)), '" },'));
        console.log(string.concat('  "outage-v1": { "gracePeriodSeconds": "', vm.toString(uint256(DeployPolicyValues.OUTAGE_GRACE_SECONDS)), '", "maxIntervals": "', vm.toString(uint256(DeployPolicyValues.OUTAGE_MAX_INTERVALS)), '" },'));
    }

    function _printGovernanceValues(address policies) internal view {
        console.log("governance:");
        console.log(string.concat('  "rotationDelaySeconds": "', vm.toString(MidmanPolicies(policies).ROTATION_DELAY()), '",'));
        console.log(string.concat('  "unpauseDelaySeconds": "', vm.toString(MidmanPolicies(policies).UNPAUSE_DELAY()), '",'));
        console.log('  "vetoQuorum": "2",');
        console.log('  "minPanelSizes": { "primary": "5", "fallback": "5", "veto": "3" },');
    }
}
