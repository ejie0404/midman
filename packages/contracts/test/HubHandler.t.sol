// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockUSDC} from "./Mocks.t.sol";
import {Finance} from "../src/Finance.sol";
import {
    MidmanDK,
    Deal,
    DealTerms,
    Admission,
    AllowanceIntent,
    ReadinessAuth,
    Payment3009,
    RulingAuth,
    VetoSig,
    ReserveAuth
} from "../src/DealTypes.sol";

/// @notice Lifecycle handler for forge invariant runs. Every action reverts
/// cleanly when preconditions are unmet (discarded by the runner); ghost sums
/// move only after successful hub calls, so reverts never desync accounting.
contract HubHandler is Test {
    MidmanHub public hub;
    MidmanPolicies public policies;
    MockUSDC public usdc;

    uint256[] buyerPks;
    uint256[] sellerPks;
    uint256[] primaryPks;
    uint256[] fallbackPks;
    uint256[] vetoPks;
    uint256 admissionPk;

    bytes32 feePolicy;
    bytes32 categoryPolicy;
    bytes32 noReadiness;
    bytes32 evidencePolicy;
    bytes32 bondPolicy;
    bytes32 arbPolicy;
    bytes32 outagePolicy;
    bytes32 catPolicy;

    bytes32[] public dealIds;
    uint256 public dealCounter;
    uint256 public ghostFunded;
    uint256 public ghostBonds;
    uint256 public ghostDonated;
    uint256 public ghostClaimed;

    constructor(
        MidmanHub hub_,
        MidmanPolicies policies_,
        MockUSDC usdc_,
        uint256[] memory buyerPks_,
        uint256[] memory sellerPks_,
        uint256[] memory primaryPks_,
        uint256[] memory fallbackPks_,
        uint256[] memory vetoPks_,
        uint256 admissionPk_,
        bytes32[8] memory pids
    ) {
        hub = hub_;
        policies = policies_;
        usdc = usdc_;
        buyerPks = buyerPks_;
        sellerPks = sellerPks_;
        primaryPks = primaryPks_;
        fallbackPks = fallbackPks_;
        vetoPks = vetoPks_;
        admissionPk = admissionPk_;
        feePolicy = pids[0];
        categoryPolicy = pids[1];
        noReadiness = pids[2];
        evidencePolicy = pids[3];
        bondPolicy = pids[4];
        arbPolicy = pids[5];
        outagePolicy = pids[6];
        catPolicy = pids[7];
        for (uint256 i = 0; i < buyerPks.length; i++) usdc.mint(vm.addr(buyerPks[i]), 1_000_000_000_000);
        for (uint256 i = 0; i < sellerPks.length; i++) usdc.mint(vm.addr(sellerPks[i]), 1_000_000_000_000);
        usdc.mint(address(this), 1_000_000_000_000);
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function fundNewDeal(uint256 seed) public {
        require(dealIds.length < 15, "cap");
        address buyer = vm.addr(buyerPks[seed % buyerPks.length]);
        address seller = vm.addr(sellerPks[(seed >> 8) % sellerPks.length]);
        if (buyer == seller) return;
        uint256 principal = bound(seed >> 16, 5_000_000, 50_000_000);
        uint16 bps = (seed >> 40) % 3 == 0 ? uint16(0) : ((seed >> 40) % 3 == 1 ? uint16(5_000) : uint16(10_000));
        dealCounter += 1;
        DealTerms memory t;
        t.dealId = keccak256(abi.encode("inv", dealCounter));
        t.termsVersion = 1;
        t.buyerAddress = buyer;
        t.sellerAddress = seller;
        t.sellerPayoutAddress = seller;
        t.buyerRefundAddress = buyer;
        t.buyerBondRefundAddress = buyer;
        t.sellerBondRefundAddress = seller;
        t.token = address(usdc);
        t.principal = principal;
        uint256 q = (principal * 25 + 9_999) / 10_000;
        t.quotedPlatformFee = q < 500_000 ? 500_000 : q;
        t.buyerFeeBps = bps;
        t.agreementHash = keccak256("agreement-bytes");
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
        t.nonce = keccak256(abi.encode("inv-nonce", dealCounter));
        t.salt = keccak256(abi.encode("inv-salt", dealCounter));
        t.custodyAddress = address(hub);
        bytes32 digest = hub.agreementDigestOf(t);
        uint256 buyerPk = buyerPks[seed % buyerPks.length];
        uint256 sellerPk = sellerPks[(seed >> 8) % sellerPks.length];
        bytes memory sb = _sig(buyerPk, digest);
        bytes memory ss = _sig(sellerPk, digest);
        uint256 amount = principal + (t.quotedPlatformFee * bps) / 10_000;
        bytes32 admissionNonce = keccak256(abi.encode("inv-adm", dealCounter));
        bytes32 adigest = hub.actionDigest(
            keccak256(
                abi.encode(MidmanDK.ADMISSION_TYPEHASH, digest, bytes32(0), admissionNonce, uint64(block.timestamp + 1 days), true)
            )
        );
        Admission memory adm = Admission({
            minPolicyId: bytes32(0),
            admissionNonce: admissionNonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(admissionPk, adigest)
        });
        bytes32 inonce = keccak256(abi.encode("inv-intent", dealCounter));
        bytes32 idigest = hub.actionDigest(
            keccak256(
                abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, amount, bytes32("s"), inonce, uint64(block.timestamp + 1 days))
            )
        );
        AllowanceIntent memory intent = AllowanceIntent({
            paymentSalt: bytes32("s"),
            nonce: inonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(buyerPk, idigest)
        });
        ReadinessAuth memory ready;
        // solhint-disable-next-line no-empty-blocks
        {
            Payment3009 memory nopay;
            vm.prank(buyer);
            usdc.approve(address(hub), amount);
            hub.fund(t, sb, ss, nopay, intent, adm, ready);
        }
        ghostFunded += amount;
        dealIds.push(t.dealId);
    }

    function _pick(uint256 seed) internal view returns (bytes32 dealId, address buyer, address seller) {
        require(dealIds.length > 0, "empty");
        dealId = dealIds[seed % dealIds.length];
        Deal memory d = hub.getDeal(dealId);
        return (dealId, d.buyer, d.seller);
    }

    function deliver(uint256 seed) public {
        (bytes32 dealId,, address seller) = _pick(seed);
        vm.prank(seller);
        hub.markDelivered(dealId, keccak256(abi.encode("m", seed)), bytes32(0), 0, new bytes(0));
    }

    function release(uint256 seed) public {
        (bytes32 dealId, address buyer,) = _pick(seed);
        vm.prank(buyer);
        hub.approveSeller(dealId, bytes32("v"), bytes32(0), 0, new bytes(0));
    }

    function refund(uint256 seed) public {
        (bytes32 dealId,, address seller) = _pick(seed);
        vm.prank(seller);
        hub.refundBuyer(dealId, bytes32("v"), bytes32(0), 0, new bytes(0));
    }

    function timeout(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        Deal memory d = hub.getDeal(dealId);
        if (d.phase == 1) hub.finalizeAfterTimeout(dealId);
        else if (d.phase == 0) hub.refundForNonDelivery(dealId);
        else revert("n/a");
    }

    function dispute(uint256 seed) public {
        (bytes32 dealId, address buyer,) = _pick(seed);
        vm.prank(buyer);
        hub.openDispute(dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function lapse(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        hub.lapseDispute(dealId);
    }

    function escalateFresh(uint256 seed) public {
        (bytes32 dealId, address buyer,) = _pick(seed);
        vm.prank(buyer);
        usdc.approve(address(hub), 5_000_000);
        vm.prank(buyer);
        hub.escalate(dealId, 5_000_000, 0, bytes32(0), bytes32(uint256(0xE5CA1A7E) + seed), 0, new bytes(0), _noReserve());
        ghostBonds += 5_000_000;
    }

    function respondFresh(uint256 seed) public {
        (bytes32 dealId,, address seller) = _pick(seed);
        vm.prank(seller);
        usdc.approve(address(hub), 5_000_000);
        vm.prank(seller);
        hub.postRespondentBond(
            dealId, 5_000_000, false, bytes32(0), bytes32(uint256(0xBE5D) + seed), 0, new bytes(0), _noReserve()
        );
        ghostBonds += 5_000_000;
    }

    function _noReserve() internal pure returns (ReserveAuth memory r) {
        r = ReserveAuth({
            owner: address(0),
            sourceClaimId: bytes32(0),
            amount: 0,
            party: 0,
            nonce: bytes32(0),
            expiresAt: 0,
            signature: new bytes(0)
        });
    }

    function toPrimary(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        hub.advanceToPrimary(dealId);
    }

    function toFallback(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        hub.activateFallback(dealId);
    }

    function queueAward(uint256 seed, uint256 awardSeed) public {
        (bytes32 dealId,,) = _pick(seed);
        Deal memory d = hub.getDeal(dealId);
        uint8 origin;
        uint256[] storage pks;
        uint8 quorum;
        if (d.phase == 5) {
            origin = 0;
            pks = primaryPksRef();
            quorum = d.primaryQuorum;
        } else if (d.phase == 6) {
            origin = 1;
            pks = fallbackPksRef();
            quorum = d.fallbackQuorum;
        } else revert("n/a");
        uint256 S = bound(awardSeed, 0, d.principal);
        (uint256 cb, uint256 cs) = Finance.bondCosts(d.principal, S, d.claimantBond, d.respondentBond);
        bytes32 rnonce = keccak256(abi.encode("inv-ruling", dealId, S));
        uint64 epoch = policies.authEpoch();
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, dealId, d.termsHash, d.arbitrationPolicyId, origin, rnonce, S, cb, cs, bytes32("evi"), epoch, uint64(block.timestamp + 30 days)
                )
            )
        );
        bytes[] memory sigs = new bytes[](quorum);
        for (uint256 i = 0; i < quorum; i++) sigs[i] = _sig(pks[i], rdigest);
        if (origin == 0) {
            hub.queuePrimaryRuling(
                dealId,
                RulingAuth({
                    origin: 0,
                    rulingNonce: rnonce,
                    sellerAward: S,
                    buyerCost: cb,
                    sellerCost: cs,
                    evidenceCommitment: bytes32("evi"),
                    authEpoch: epoch,
                    queueExpiry: uint64(block.timestamp + 30 days),
                    signatures: sigs
                })
            );
        } else {
            hub.queueFallbackRuling(
                dealId,
                RulingAuth({
                    origin: 1,
                    rulingNonce: rnonce,
                    sellerAward: S,
                    buyerCost: cb,
                    sellerCost: cs,
                    evidenceCommitment: bytes32("evi"),
                    authEpoch: epoch,
                    queueExpiry: uint64(block.timestamp + 30 days),
                    signatures: sigs
                })
            );
        }
    }

    // Storage-array accessors (forge invariant passes value types only).
    function primaryPksRef() internal view returns (uint256[] storage) {
        return primaryPks;
    }

    function fallbackPksRef() internal view returns (uint256[] storage) {
        return fallbackPks;
    }

    function vetoIt(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        Deal memory d = hub.getDeal(dealId);
        require(d.rulingQueued, "n/a");
        bool primary = d.rulingOrigin == 0;
        VetoSig[] memory vsigs = new VetoSig[](2);
        for (uint256 i = 0; i < 2; i++) {
            address authority = vm.addr(vetoPks[i]);
            bytes32 vnonce = keccak256(abi.encode("inv-veto", dealId, i, seed));
            uint64 expiry = uint64(block.timestamp + 7 days);
            bytes32 vdigest = hub.actionDigest(
                keccak256(abi.encode(MidmanDK.VETO_TYPEHASH, dealId, d.rulingDigest, authority, vnonce, expiry))
            );
            vsigs[i] = VetoSig({authority: authority, nonce: vnonce, expiry: expiry, signature: _sig(vetoPks[i], vdigest)});
        }
        if (primary) hub.vetoPrimaryRuling(dealId, d.rulingDigest, vsigs);
        else hub.vetoFallbackRuling(dealId, d.rulingDigest, vsigs);
    }

    function execute(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        hub.executeRuling(dealId);
    }

    function deadlock(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        hub.markDeadlock(dealId);
    }

    function escape(uint256 seed) public {
        (bytes32 dealId,,) = _pick(seed);
        hub.catastrophicEscape(dealId);
    }

    function settleMutual(uint256 seed, uint256 awardSeed) public {
        (bytes32 dealId, address buyer, address seller) = _pick(seed);
        Deal memory d = hub.getDeal(dealId);
        require(d.phase != 9, "n/a");
        uint256 S = bound(awardSeed, 0, d.principal);
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 sdigest = hub.actionDigest(
            keccak256(
                abi.encode(MidmanDK.SETTLE_TYPEHASH, dealId, d.termsHash, S, 0, 0, d.phase, bytes32(d.settlementNonce), expiry)
            )
        );
        // Buyer/seller keys for this deal: recover index by address scan.
        uint256 bpk = _findPk(buyerPks, buyer);
        uint256 spk = _findPk(sellerPks, seller);
        hub.mutualSettlement(
            dealId, S, 0, 0, d.phase, bytes32(d.settlementNonce), expiry, _sig(bpk, sdigest), _sig(spk, sdigest)
        );
    }

    function _findPk(uint256[] storage pks, address who) internal view returns (uint256) {
        for (uint256 i = 0; i < pks.length; i++) {
            if (vm.addr(pks[i]) == who) return pks[i];
        }
        revert("unknown actor");
    }

    function claim(uint256 seed, uint8 kind) public {
        require(kind <= 5, "kind");
        (bytes32 dealId,,) = _pick(seed);
        bytes32 id = hub.claimIdOf(dealId, kind);
        (, uint256 amount) = hub.getClaim(id);
        require(amount > 0, "n/a");
        hub.claimFor(dealId, kind);
        ghostClaimed += amount;
    }

    function donate(uint256 seed) public {
        uint256 amount = bound(seed, 1, 1_000_000);
        usdc.transfer(address(hub), amount);
        ghostDonated += amount;
    }

    function warpTime(uint256 delta) public {
        vm.warp(block.timestamp + bound(delta, 0, 20 days));
    }
}
