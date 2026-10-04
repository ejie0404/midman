// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    MidmanDK,
    DealTerms,
    Admission,
    AllowanceIntent,
    ReadinessAuth,
    Payment3009
} from "../src/DealTypes.sol";

interface IFeedLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IRealUSDC {
    function decimals() external view returns (uint8);
    function name() external view returns (string memory);
    function authorizationState(address, bytes32) external view returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Fork integration against pinned Base mainnet state (RB-06 evidence).
/// Skips unless BASE_RPC_URL is set. Pinned block 52126164; the down/up round
/// pair below was read from that state (a real ~4.5h sequencer outage).
contract ForkTest is Test {
    using stdStorage for StdStorage;
    address constant REAL_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant REAL_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    uint256 constant FORK_BLOCK = 52126164;
    uint80 constant DOWN_ROUND = 18446744073709551635;
    uint256 constant DOWN_START = 1782487895;
    uint256 constant UP_START = 1782491507;

    // Fresh keys: on a fork, actor addresses must have NO code or the hub
    // (correctly) takes the EIP-1271 contract-wallet path for them.
    uint256 buyerPk = 0xF0B1E;
    uint256 sellerPk = 0x5E11E5;
    uint256 admissionPk = 0xAD111;
    address buyer;
    address seller;
    address admission;

    MidmanHub hub;
    MidmanPolicies policies;

    bytes32 feePolicy = keccak256("FEEv1");
    bytes32 categoryPolicy = keccak256("CATv1");
    bytes32 noReadiness = keccak256("READY-NONE");
    bytes32 evidencePolicy = keccak256("EVIv1");
    bytes32 bondPolicy = keccak256("BONDv1");
    bytes32 arbPolicy = keccak256("ARBv1");
    bytes32 outagePolicy = keccak256("OUTv1");
    bytes32 catPolicy = keccak256("ESCv1");

    uint256 constant P = 100_000_000;
    uint256 dealCounter;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // tests self-skip
        vm.createSelectFork(rpc, FORK_BLOCK);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);
        admission = vm.addr(admissionPk);
        address gov = vm.addr(0x60);
        address[] memory prim = new address[](3);
        address[] memory fb = new address[](3);
        address[] memory vv = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            prim[i] = vm.addr(0x101 + i);
            fb[i] = vm.addr(0x201 + i);
            vv[i] = vm.addr(0x301 + i);
        }
        policies = new MidmanPolicies(gov, address(0x9A05), admission, address(0x7EA5), REAL_FEED, prim, fb, vv);
        hub = new MidmanHub(REAL_USDC, address(policies));
        vm.startPrank(gov);
        policies.registerFeePolicy(feePolicy, keccak256("fee"));
        policies.registerCategoryPolicy(categoryPolicy, keccak256("cat"), 3_600);
        policies.registerReadinessPolicy(noReadiness, keccak256("r"), false);
        policies.registerEvidencePolicy(evidencePolicy, keccak256("e"));
        policies.registerBondPolicy(bondPolicy, keccak256("b"), 5_000_000, 5_000_000);
        policies.registerArbitrationPolicy(arbPolicy, keccak256("a"), 0x07);
        policies.registerOutagePolicy(outagePolicy, keccak256("o"), 1_800, 8);
        policies.registerCatastrophicPolicy(catPolicy, keccak256("c"));
        vm.stopPrank();
    }

    modifier onlyFork() {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
        }
        _;
    }

    function _credit(address who, uint256 amount) internal {
        stdstore.target(REAL_USDC).sig("balanceOf(address)").with_key(who).checked_write(amount);
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _terms() internal returns (DealTerms memory t) {
        dealCounter += 1;
        t.dealId = keccak256(abi.encode("fork", dealCounter));
        t.termsVersion = 1;
        t.buyerAddress = buyer;
        t.sellerAddress = seller;
        t.sellerPayoutAddress = seller;
        t.buyerRefundAddress = buyer;
        t.buyerBondRefundAddress = buyer;
        t.sellerBondRefundAddress = seller;
        t.token = REAL_USDC;
        t.principal = P;
        t.quotedPlatformFee = 500_000;
        t.buyerFeeBps = 0; // seller-pays: buyer funds exactly P
        t.agreementHash = keccak256("fork-agreement");
        t.feePolicyId = feePolicy;
        t.deliveryPeriodSeconds = 3_600;
        t.inspectionPeriodSeconds = 3_600;
        t.categoryPolicyId = categoryPolicy;
        t.readinessPolicyId = noReadiness;
        t.evidencePolicyId = evidencePolicy;
        t.bondPolicyId = bondPolicy;
        t.arbitrationPolicyId = arbPolicy;
        t.outagePolicyId = outagePolicy;
        t.catastrophicPolicyId = catPolicy;
        t.platformFeeRecipient = address(0xFEE);
        t.arbitrationCostRecipient = address(0xA8B);
        t.fundingDeadline = uint64(block.timestamp + 7 days);
        t.nonce = keccak256(abi.encode("fork-nonce", dealCounter));
        t.salt = keccak256(abi.encode("fork-salt", dealCounter));
        t.custodyAddress = address(hub);
    }

    function _admission(bytes32 digest) internal returns (Admission memory adm) {
        bytes32 n = keccak256(abi.encode("fork-adm", digest));
        bytes32 d = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ADMISSION_TYPEHASH, digest, bytes32(0), n, uint64(block.timestamp + 1 days), true))
        );
        adm = Admission({minPolicyId: bytes32(0), admissionNonce: n, expiresAt: uint64(block.timestamp + 1 days), signature: _sig(admissionPk, d)});
    }

    function testFork_Capabilities() public onlyFork {
        assertEq(IRealUSDC(REAL_USDC).decimals(), 6, "decimals");
        assertEq(IRealUSDC(REAL_USDC).name(), "USD Coin", "name");
        assertFalse(IRealUSDC(REAL_USDC).authorizationState(buyer, bytes32("unused")), "3009 state readable");
        (, int256 answer,,,) = IFeedLike(REAL_FEED).latestRoundData();
        assertEq(answer, 0, "sequencer up");
        (, int256 downAns, uint256 downStart,,) = IFeedLike(REAL_FEED).getRoundData(DOWN_ROUND);
        (, int256 upAns, uint256 upStart,,) = IFeedLike(REAL_FEED).getRoundData(DOWN_ROUND + 1);
        assertEq(downAns, 1, "historical down round");
        assertEq(upAns, 0, "recovery round");
        assertEq(downStart, DOWN_START, "down start");
        assertEq(upStart, UP_START, "up start");
    }

    function testFork_FullFlowApprove() public onlyFork {
        _credit(buyer, P);
        DealTerms memory t = _terms();
        bytes32 digest = hub.agreementDigestOf(t);
        vm.prank(buyer);
        IRealUSDC(REAL_USDC).approve(address(hub), P);
        bytes32 inonce = keccak256("fork-intent");
        bytes32 idigest = hub.actionDigest(
            keccak256(
                abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, P, bytes32("s"), inonce, uint64(block.timestamp + 1 days))
            )
        );
        AllowanceIntent memory intent = AllowanceIntent({
            paymentSalt: bytes32("s"),
            nonce: inonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(buyerPk, idigest)
        });
        Payment3009 memory nopay;
        ReadinessAuth memory ready;
        hub.fund(t, _sig(buyerPk, digest), _sig(sellerPk, digest), nopay, intent, _admission(digest), ready);
        assertEq(hub.totalLiabilities(), P, "real USDC held");
        vm.prank(seller);
        hub.markDelivered(t.dealId, keccak256("m"), bytes32(0), 0, new bytes(0));
        vm.warp(block.timestamp + 3_600 + 1);
        hub.finalizeAfterTimeout(t.dealId);
        hub.claimFor(t.dealId, 1);
        assertEq(IRealUSDC(REAL_USDC).balanceOf(seller), P - 500_000, "seller net of fee");
    }

    function testFork_Gasless3009() public onlyFork {
        _credit(buyer, P);
        DealTerms memory t = _terms();
        bytes32 digest = hub.agreementDigestOf(t);
        bytes32 salt = keccak256("fork-3009");
        bytes32 tokenNonce = keccak256(abi.encode(t.dealId, digest, salt));
        assertFalse(IRealUSDC(REAL_USDC).authorizationState(buyer, tokenNonce), "nonce fresh");
        bytes32 sep = IRealUSDC(REAL_USDC).DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
                buyer,
                address(hub),
                P,
                block.timestamp - 1,
                block.timestamp + 7 days,
                tokenNonce
            )
        );
        bytes32 authDigest = keccak256(abi.encodePacked(hex"1901", sep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, authDigest);
        Payment3009 memory pay = Payment3009({
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 7 days,
            paymentSalt: salt,
            v: v,
            r: r,
            s: s,
            use3009: true
        });
        AllowanceIntent memory empty;
        ReadinessAuth memory ready;
        hub.fund(t, _sig(buyerPk, digest), _sig(sellerPk, digest), pay, empty, _admission(digest), ready);
        assertTrue(IRealUSDC(REAL_USDC).authorizationState(buyer, tokenNonce), "nonce consumed");
        assertEq(IRealUSDC(REAL_USDC).balanceOf(address(hub)), P, "atomic receipt");
    }

    function testFork_RealOutageRecorded() public onlyFork {
        policies.reportOutage(DOWN_ROUND);
        (uint64 s, uint64 e) = policies.outages(0);
        assertEq(s, DOWN_START, "recorded start");
        assertEq(e, UP_START, "recorded end");
        // Funding after a historical outage is unaffected; escape math unchanged.
        _credit(buyer, P);
        DealTerms memory t = _terms();
        bytes32 digest = hub.agreementDigestOf(t);
        vm.prank(buyer);
        IRealUSDC(REAL_USDC).approve(address(hub), P);
        bytes32 inonce = keccak256("fork-intent-2");
        bytes32 idigest = hub.actionDigest(
            keccak256(
                abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, P, bytes32("s"), inonce, uint64(block.timestamp + 1 days))
            )
        );
        AllowanceIntent memory intent = AllowanceIntent({
            paymentSalt: bytes32("s"),
            nonce: inonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(buyerPk, idigest)
        });
        Payment3009 memory nopay;
        ReadinessAuth memory ready;
        hub.fund(t, _sig(buyerPk, digest), _sig(sellerPk, digest), nopay, intent, _admission(digest), ready);
        vm.prank(seller);
        hub.markDelivered(t.dealId, keccak256("m"), bytes32(0), 0, new bytes(0));
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        assertEq(hub.escapeAt(t.dealId), block.timestamp + 5_184_000, "fixed escape");
    }
}
