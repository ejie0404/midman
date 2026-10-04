// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockUSDC, MockFeed} from "./Mocks.t.sol";
import {DeployProdBase, DeployPolicyIds} from "../script/DeployProd.s.sol";
import {DeployDevBase} from "../script/DeployDev.s.sol";

/// @notice Unit tests for the hardened deploy scripts. The deploy logic lives in
/// DeployProdBase/DeployDevBase as internal functions taking explicit arguments,
/// so these tests drive them without vm.env or an anvil broadcast. Reverts are
/// observed through external wrappers because vm.expectRevert only intercepts
/// CALL boundaries.
contract DeployScriptsTest is Test, DeployProdBase, DeployDevBase {
    address internal constant GOV = address(0xA11CE);
    address internal constant PAUSER = address(0xB0B);
    address internal constant ADMISSION = address(0xAD);
    address internal constant TREASURY = address(0x7E57);
    address internal constant USDC = address(0x5555);
    address internal constant FEED = address(0xF33D);

    // ---- External wrappers (give the EVM a call boundary to revert at) ----

    function deployProdExternal(ProdConfig calldata c) external returns (ProdDeployment memory) {
        return _deployProd(c, c.governance);
    }

    function deployProdWithRegistrarExternal(ProdConfig calldata c, address registrar)
        external
        returns (ProdDeployment memory)
    {
        return _deployProd(c, registrar);
    }

    function deployDevExternal(DevConfig calldata c) external returns (DevDeployment memory) {
        return _deployDev(c);
    }

    function parseCsvExternal(string calldata csv, string calldata label) external pure returns (address[] memory) {
        return _parseCsvAddresses(csv, label);
    }

    // ---- Fixtures ----

    function _prodPanels()
        internal
        pure
        returns (address[] memory p, address[] memory f, address[] memory v)
    {
        p = new address[](5);
        f = new address[](5);
        v = new address[](3);
        for (uint256 i = 0; i < 5; i++) p[i] = address(uint160(0x10000 + i));
        for (uint256 i = 0; i < 5; i++) f[i] = address(uint160(0x20000 + i));
        for (uint256 i = 0; i < 3; i++) v[i] = address(uint160(0x30000 + i));
    }

    function _validProdConfig() internal returns (ProdConfig memory c) {
        (address[] memory p, address[] memory f, address[] memory v) = _prodPanels();
        c = ProdConfig({
            chainId: block.chainid,
            usdc: address(new MockUSDC()),
            feed: FEED,
            governance: GOV,
            pauser: PAUSER,
            admissionSigner: ADMISSION,
            treasury: TREASURY,
            primary: p,
            fallbackPanel: f,
            veto: v,
            feeHash: bytes32(uint256(0x11)),
            categoryHash: bytes32(uint256(0x22)),
            readinessHash: bytes32(uint256(0x33)),
            evidenceHash: bytes32(uint256(0x44)),
            bondHash: bytes32(uint256(0x55)),
            arbitrationHash: bytes32(uint256(0x66)),
            outageHash: bytes32(uint256(0x77)),
            catastrophicHash: bytes32(uint256(0x88))
        });
    }

    function _deployValidProd() internal returns (ProdDeployment memory out, ProdConfig memory c) {
        c = _validProdConfig();
        vm.startPrank(c.governance);
        out = _deployProd(c, c.governance);
        vm.stopPrank();
    }

    function _devConfig(address governance) internal pure returns (DevConfig memory c) {
        (address[] memory p, address[] memory f, address[] memory v) = DeployDevBase.devPanelAddresses();
        c = DevConfig({
            governance: governance,
            pauser: governance,
            admissionSigner: governance,
            treasury: governance,
            primary: p,
            fallbackPanel: f,
            veto: v
        });
    }

    // ---- Production: happy path ----

    function testValidProdDeploysAndWiresRolesAndPolicies() public {
        (ProdDeployment memory out, ProdConfig memory cfg) = _deployValidProd();
        MidmanPolicies pol = MidmanPolicies(out.policies);
        MidmanHub hub = MidmanHub(out.hub);

        assertEq(pol.governance(), GOV, "governance");
        assertEq(pol.pauser(), PAUSER, "pauser");
        assertEq(pol.admissionSigner(), ADMISSION, "admission");
        assertEq(pol.treasury(), TREASURY, "treasury");
        assertEq(pol.sequencerFeed(), FEED, "feed");
        assertEq(address(hub.usdc()), cfg.usdc, "hub.usdc");
        assertEq(address(hub.policies()), out.policies, "hub.policies");

        (address[] memory p, address[] memory f, address[] memory v) = _prodPanels();
        assertEq(pol.authEpoch(), 1, "epoch");
        for (uint256 i = 0; i < p.length; i++) {
            assertTrue(pol.isPrimary(1, p[i]), "primary member");
            assertFalse(pol.isFallback(1, p[i]), "primary not fallback");
        }
        for (uint256 i = 0; i < f.length; i++) {
            assertTrue(pol.isFallback(1, f[i]), "fallback member");
            assertFalse(pol.isPrimary(1, f[i]), "fallback not primary");
        }
        for (uint256 i = 0; i < v.length; i++) {
            assertTrue(pol.isVeto(v[i]), "veto member");
            assertFalse(pol.isPrimary(1, v[i]), "veto not primary");
        }

        (bool b0, bytes32 h0) = pol.feePolicies(DeployPolicyIds.FEE);
        assertTrue(b0, "fee registered");
        assertEq(h0, bytes32(uint256(0x11)), "fee hash");
        (bool b1, bytes32 h1, uint32 minInsp) = pol.categoryPolicies(DeployPolicyIds.CATEGORY);
        assertTrue(b1, "category registered");
        assertEq(h1, bytes32(uint256(0x22)), "category hash");
        assertEq(minInsp, 3_600, "category min inspection");
        (bool b2, bytes32 h2, bool required) = pol.readinessPolicies(DeployPolicyIds.READINESS);
        assertTrue(b2, "readiness registered");
        assertEq(h2, bytes32(uint256(0x33)), "readiness hash");
        assertFalse(required, "readiness not required");
        (bool b3, bytes32 h3) = pol.evidencePolicies(DeployPolicyIds.EVIDENCE);
        assertTrue(b3, "evidence registered");
        assertEq(h3, bytes32(uint256(0x44)), "evidence hash");
        (bool b4, bytes32 h4, uint256 cb, uint256 rb) = pol.bondPolicies(DeployPolicyIds.BOND);
        assertTrue(b4, "bond registered");
        assertEq(h4, bytes32(uint256(0x55)), "bond hash");
        assertEq(cb, 5_000_000, "claimant bond");
        assertEq(rb, 5_000_000, "respondent bond");
        (bool b5, bytes32 h5, uint8 tiers) = pol.arbitrationPolicies(DeployPolicyIds.ARBITRATION);
        assertTrue(b5, "arbitration registered");
        assertEq(h5, bytes32(uint256(0x66)), "arbitration hash");
        assertEq(tiers, 0x07, "arbitration tiers");
        (bool b6, bytes32 h6, uint32 grace, uint8 maxIntervals) = pol.outagePolicies(DeployPolicyIds.OUTAGE);
        assertTrue(b6, "outage registered");
        assertEq(h6, bytes32(uint256(0x77)), "outage hash");
        assertEq(grace, 1_800, "outage grace");
        assertEq(maxIntervals, 8, "outage intervals");
        (bool b7, bytes32 h7) = pol.catastrophicPolicies(DeployPolicyIds.CATASTROPHIC);
        assertTrue(b7, "catastrophic registered");
        assertEq(h7, bytes32(uint256(0x88)), "catastrophic hash");
    }

    // ---- Production: validation reverts ----

    function testProdZeroGovernanceReverts() public {
        ProdConfig memory c = _validProdConfig();
        c.governance = address(0);
        vm.expectRevert(bytes("DeployProd: GOVERNANCE required and non-zero"));
        this.deployProdExternal(c);
    }

    function testProdZeroUsdcReverts() public {
        ProdConfig memory c = _validProdConfig();
        c.usdc = address(0);
        vm.expectRevert(bytes("DeployProd: USDC_ADDRESS required and non-zero"));
        this.deployProdExternal(c);
    }

    function testProdZeroTreasuryReverts() public {
        ProdConfig memory c = _validProdConfig();
        c.treasury = address(0);
        vm.expectRevert(bytes("DeployProd: TREASURY required and non-zero"));
        this.deployProdExternal(c);
    }

    function testProdTooFewPrimaryReverts() public {
        ProdConfig memory c = _validProdConfig();
        address[] memory tiny = new address[](4);
        for (uint256 i = 0; i < 4; i++) tiny[i] = c.primary[i];
        c.primary = tiny;
        vm.expectRevert(bytes("DeployProd: PANEL_PRIMARY needs >=5 members"));
        this.deployProdExternal(c);
    }

    function testProdTooFewFallbackReverts() public {
        ProdConfig memory c = _validProdConfig();
        address[] memory tiny = new address[](4);
        for (uint256 i = 0; i < 4; i++) tiny[i] = c.fallbackPanel[i];
        c.fallbackPanel = tiny;
        vm.expectRevert(bytes("DeployProd: PANEL_FALLBACK needs >=5 members"));
        this.deployProdExternal(c);
    }

    function testProdTooFewVetoReverts() public {
        ProdConfig memory c = _validProdConfig();
        address[] memory tiny = new address[](2);
        tiny[0] = c.veto[0];
        tiny[1] = c.veto[1];
        c.veto = tiny;
        vm.expectRevert(bytes("DeployProd: PANEL_VETO needs >=3 members"));
        this.deployProdExternal(c);
    }

    function testProdOverlappingPanelsRevert() public {
        ProdConfig memory c = _validProdConfig();
        c.fallbackPanel[0] = c.primary[0];
        vm.expectRevert(bytes("DeployProd: primary/fallback panels overlap"));
        this.deployProdExternal(c);
    }

    function testProdDuplicateWithinPanelReverts() public {
        ProdConfig memory c = _validProdConfig();
        c.primary[1] = c.primary[0];
        vm.expectRevert(bytes("DeployProd: PANEL_PRIMARY has duplicate member"));
        this.deployProdExternal(c);
    }

    function testProdZeroPolicyHashReverts() public {
        ProdConfig memory c = _validProdConfig();
        c.outageHash = bytes32(0);
        vm.expectRevert(bytes("DeployProd: POLICY_OUTAGE required"));
        this.deployProdExternal(c);
    }

    function testProdRegistrarNotGovernanceReverts() public {
        ProdConfig memory c = _validProdConfig();
        vm.expectRevert(bytes("DeployProd: broadcaster must equal GOVERNANCE"));
        this.deployProdWithRegistrarExternal(c, address(0xDEAD));
    }

    function testProdChainIdMismatchReverts() public {
        ProdConfig memory c = _validProdConfig();
        c.chainId = block.chainid + 1;
        vm.expectRevert(bytes("DeployProd: chain id mismatch (set CHAIN_ID explicitly)"));
        this.deployProdExternal(c);
    }

    // ---- Production: comma-separated PANEL_* env parsing ----

    function testProdCsvPanelParsingTrimsAndAcceptsCase() public {
        address[] memory parsed =
            this.parseCsvExternal("0x70997970C51812dc3A010C7d01b50e0d17dc79C8, 0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "PANEL_PRIMARY");
        assertEq(parsed.length, 2, "two members");
        assertEq(parsed[0], ANVIL_1, "first member");
        assertEq(parsed[1], ANVIL_2, "second member");
    }

    function testProdCsvPanelRejectsMalformed() public {
        vm.expectRevert(bytes("DeployProd: PANEL_PRIMARY malformed address"));
        this.parseCsvExternal("0x1234,0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "PANEL_PRIMARY");
    }

    function testProdCsvPanelRejectsZeroAddress() public {
        vm.expectRevert(bytes("DeployProd: PANEL_FALLBACK zero address"));
        this.parseCsvExternal("0x0000000000000000000000000000000000000000", "PANEL_FALLBACK");
    }

    // ---- Development ----

    function testDevDeploysMocksAndRegistersEightPolicies() public {
        DevConfig memory c = _devConfig(GOV);
        vm.startPrank(GOV);
        DevDeployment memory out = _deployDev(c);
        vm.stopPrank();

        assertEq(MockUSDC(out.usdc).decimals(), 6, "mock usdc decimals");
        MidmanPolicies pol = MidmanPolicies(out.policies);
        MidmanHub hub = MidmanHub(out.hub);
        assertEq(address(hub.usdc()), out.usdc, "hub usdc is mock");
        assertEq(address(hub.policies()), out.policies, "hub policies");
        assertEq(pol.sequencerFeed(), out.feed, "feed is mock");
        assertEq(pol.governance(), GOV, "dev governance");

        (bool b0, bytes32 h0) = pol.feePolicies(DeployPolicyIds.FEE);
        (bool b1, bytes32 h1) = pol.evidencePolicies(DeployPolicyIds.EVIDENCE);
        (bool b2, bytes32 h2) = pol.catastrophicPolicies(DeployPolicyIds.CATASTROPHIC);
        assertTrue(b0 && b1 && b2, "three of eight registered");
        assertEq(h0, FEE_CONTENT, "dev fee canonical hash");
        assertEq(h1, EVIDENCE_CONTENT, "dev evidence canonical hash");
        assertEq(h2, CATASTROPHIC_CONTENT, "dev catastrophic canonical hash");

        (bool c0, bytes32 ch0, uint32 minInsp) = pol.categoryPolicies(DeployPolicyIds.CATEGORY);
        (bool r0, bytes32 rh0, bool required) = pol.readinessPolicies(DeployPolicyIds.READINESS);
        (bool d0, bytes32 dh0, uint256 cb, uint256 rb) = pol.bondPolicies(DeployPolicyIds.BOND);
        (bool a0, bytes32 ah0, uint8 tiers) = pol.arbitrationPolicies(DeployPolicyIds.ARBITRATION);
        (bool o0, bytes32 oh0, uint32 grace, uint8 maxIntervals) = pol.outagePolicies(DeployPolicyIds.OUTAGE);
        assertTrue(c0 && r0 && d0 && a0 && o0, "remaining policies registered");
        assertEq(ch0, CATEGORY_CONTENT, "dev category hash");
        assertEq(rh0, READINESS_CONTENT, "dev readiness hash");
        assertEq(dh0, BOND_CONTENT, "dev bond hash");
        assertEq(ah0, ARBITRATION_CONTENT, "dev arbitration hash");
        assertEq(oh0, OUTAGE_CONTENT, "dev outage hash");
        assertEq(minInsp, 3_600, "dev category inspection");
        assertFalse(required, "dev readiness not required");
        assertEq(cb, 5_000_000, "dev claimant bond");
        assertEq(rb, 5_000_000, "dev respondent bond");
        assertEq(tiers, 0x07, "dev arbitration tiers");
        assertEq(grace, 1_800, "dev outage grace");
        assertEq(maxIntervals, 8, "dev outage intervals");
    }

    function testDevPanelsAreDeterministicAnvilAddresses() public {
        DevConfig memory c = _devConfig(GOV);
        vm.startPrank(GOV);
        DevDeployment memory out = _deployDev(c);
        vm.stopPrank();
        MidmanPolicies pol = MidmanPolicies(out.policies);
        assertEq(pol.authEpoch(), 1, "epoch");
        assertTrue(pol.isPrimary(1, ANVIL_1), "anvil1 primary");
        assertTrue(pol.isPrimary(1, ANVIL_5), "anvil5 primary");
        assertTrue(pol.isFallback(1, ANVIL_6), "anvil6 fallback");
        assertTrue(pol.isVeto(ANVIL_11), "anvil11 veto");
        assertFalse(pol.isPrimary(1, ANVIL_6), "anvil6 not primary");
    }
}
