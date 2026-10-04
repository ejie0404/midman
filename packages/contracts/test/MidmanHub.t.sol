// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanHub} from "../src/MidmanHub.sol";
import {MidmanPolicies} from "../src/MidmanPolicies.sol";
import {MockUSDC, MockFeed} from "./Mocks.t.sol";
import {
    MidmanDK,
    DealTerms,
    Deal,
    Admission,
    AllowanceIntent,
    ReadinessAuth,
    Payment3009,
    RulingAuth,
    VetoSig,
    ReserveAuth,
    BadTerms,
    Expired,
    AlreadyFunded,
    Revoked,
    DisputeExhausted,
    BadAward,
    Paused,
    NothingToRescue
} from "../src/DealTypes.sol";

/// @notice Phase 4 starter suite: every spec transition has an implementation
/// path exercised here at least once. Fuzz/invariant/boundary depth is Phase 5.
contract MidmanHubTest is Test {
    MidmanHub public hub;
    MidmanPolicies public policies;
    MockUSDC public usdc;
    MockFeed public feed;

    // Actors.
    uint256 buyerPk = 0xB0B;
    uint256 sellerPk = 0x5E11;
    uint256 admissionPk = 0xAD;
    uint256 govPk = 0x60;
    address buyer;
    address seller;
    address admission;
    address governance;
    address pauser;
    address treasury;

    // Panels (3+3 disjoint, 3 veto).
    uint256[] primaryPks = [0x101, 0x102, 0x103, 0x104, 0x105];
    uint256[] fallbackPks = [0x201, 0x202, 0x203, 0x204, 0x205];
    uint256[] vetoPks = [0x301, 0x302, 0x303];
    address[] primary;
    address[] fbPanel;
    address[] veto;

    bytes32 feePolicy = keccak256("FEEv1");
    bytes32 categoryPolicy = keccak256("CATv1");
    bytes32 noReadiness = keccak256("READY-NONE");
    bytes32 evidencePolicy = keccak256("EVIv1");
    bytes32 bondPolicy = keccak256("BONDv1");
    bytes32 arbPolicy = keccak256("ARBv1");
    bytes32 outagePolicy = keccak256("OUTv1");
    bytes32 catPolicy = keccak256("ESCv1");

    uint256 constant P = 100_000_000; // 100 USDC
    uint256 constant DEAL_NONCE = 0;
    uint64 constant START = 1_000_000;
    uint256 dealCounter;

    function setUp() public virtual {
        vm.warp(START);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);
        admission = vm.addr(admissionPk);
        governance = vm.addr(govPk);
        pauser = address(uint160(0x9A05));
        treasury = address(0x7EA5);
        for (uint256 i = 0; i < primaryPks.length; i++) primary.push(vm.addr(primaryPks[i]));
        for (uint256 i = 0; i < fallbackPks.length; i++) fbPanel.push(vm.addr(fallbackPks[i]));
        for (uint256 i = 0; i < vetoPks.length; i++) veto.push(vm.addr(vetoPks[i]));

        feed = new MockFeed();
        usdc = new MockUSDC();
        policies = new MidmanPolicies(governance, pauser, admission, treasury, address(feed), primary, fbPanel, veto);
        hub = new MidmanHub(address(usdc), address(policies));

        vm.startPrank(governance);
        policies.registerFeePolicy(feePolicy, keccak256("fee-content"));
        policies.registerCategoryPolicy(categoryPolicy, keccak256("cat-content"), 3_600);
        policies.registerReadinessPolicy(noReadiness, keccak256("ready-content"), false);
        policies.registerEvidencePolicy(evidencePolicy, keccak256("evi-content"));
        policies.registerBondPolicy(bondPolicy, keccak256("bond-content"), 5_000_000, 5_000_000);
        policies.registerArbitrationPolicy(arbPolicy, keccak256("arb-content"), 0x07);
        policies.registerOutagePolicy(outagePolicy, keccak256("out-content"), 1_800, 8);
        policies.registerCatastrophicPolicy(catPolicy, keccak256("esc-content"));
        vm.stopPrank();

        usdc.mint(buyer, 1_000_000_000);
        usdc.mint(seller, 1_000_000_000);
    }

    // ---- Builders ----
    function _terms(uint256 principal, uint16 bps) internal returns (DealTerms memory t) {
        dealCounter += 1;
        t.dealId = keccak256(abi.encode("deal", dealCounter));
        t.termsVersion = 1;
        t.buyerAddress = buyer;
        t.sellerAddress = seller;
        t.sellerPayoutAddress = seller;
        t.buyerRefundAddress = buyer;
        t.buyerBondRefundAddress = buyer;
        t.sellerBondRefundAddress = seller;
        t.token = address(usdc);
        t.principal = principal;
        // ceil quote at 25bps for 7200s duration, min 500_000.
        uint256 q = (principal * 25 + 9_999) / 10_000;
        t.quotedPlatformFee = q < 500_000 ? 500_000 : q;
        t.buyerFeeBps = bps;
        t.agreementHash = keccak256("agreement-bytes");
        t.feePolicyId = feePolicy;
        t.deliveryPeriodSeconds = 3_600;
        t.inspectionPeriodSeconds = 3_600;
        t.categoryPolicyId = categoryPolicy;
        t.readinessPolicyId = noReadiness;
        t.readinessConsentHash = bytes32(0);
        t.evidencePolicyId = evidencePolicy;
        t.bondPolicyId = bondPolicy;
        t.arbitrationPolicyId = arbPolicy;
        t.outagePolicyId = outagePolicy;
        t.catastrophicPolicyId = catPolicy;
        t.platformFeeRecipient = address(0xFEE);
        t.arbitrationCostRecipient = address(0xA8B);
        t.fundingDeadline = uint64(block.timestamp + 7 days);
        t.nonce = keccak256(abi.encode("nonce", dealCounter));
        t.salt = keccak256(abi.encode("salt", dealCounter));
        t.factory = address(0);
        t.implementation = address(0);
        t.custodyAddress = address(hub);
    }

    function _fundedAmount(DealTerms memory t) internal pure returns (uint256) {
        uint256 prepaid = (t.quotedPlatformFee * t.buyerFeeBps) / 10_000;
        return t.principal + prepaid;
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Empty reserve authorization for fresh-token bond paths (only
    /// read when collateralSource == existing claim).
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

    /// @notice Owner-signed ReserveExistingClaim authorization for bonding an
    /// existing vested claim. Binds deal, agreement, owner, claim, amount,
    /// party, nonce and expiry; the owner MUST be the claim's recipient.
    function _reserveAuth(
        bytes32 dealId,
        bytes32 agreementDigest,
        uint256 ownerPk,
        bytes32 sourceClaimId,
        uint256 amount,
        uint8 party,
        bytes32 nonce,
        uint64 expiresAt
    ) internal view returns (ReserveAuth memory r) {
        address owner = vm.addr(ownerPk);
        bytes32 structHash = keccak256(
            abi.encode(
                MidmanDK.RESERVE_TYPEHASH, dealId, agreementDigest, owner, sourceClaimId, amount, party, nonce, expiresAt
            )
        );
        bytes32 digest = hub.actionDigest(structHash);
        r = ReserveAuth({
            owner: owner,
            sourceClaimId: sourceClaimId,
            amount: amount,
            party: party,
            nonce: nonce,
            expiresAt: expiresAt,
            signature: _sig(ownerPk, digest)
        });
    }

    /// @notice Param builder WITHOUT approve/submit, so rejection tests can
    /// place expectRevert immediately before hub.fund (an approve would
    /// otherwise consume the expectation).
    function _buildFund(DealTerms memory t, bool use3009)
        internal
        returns (
            bytes32 digest,
            bytes memory sb,
            bytes memory ss,
            Payment3009 memory pay,
            AllowanceIntent memory intent,
            Admission memory adm,
            ReadinessAuth memory ready,
            uint256 amount
        )
    {
        digest = hub.agreementDigestOf(t);
        sb = _sig(buyerPk, digest);
        ss = _sig(sellerPk, digest);
        amount = _fundedAmount(t);
        bytes32 admissionNonce = keccak256(abi.encode("adm", t.dealId));
        bytes32 adigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ADMISSION_TYPEHASH, digest, bytes32(0), admissionNonce, uint64(block.timestamp + 1 days), true))
        );
        adm = Admission({
            minPolicyId: bytes32(0),
            admissionNonce: admissionNonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(admissionPk, adigest)
        });
        ready = ReadinessAuth({attestedAt: 0, nonce: bytes32(0), expiresAt: 0, signature: new bytes(0)});
        if (use3009) {
            bytes32 salt = keccak256(abi.encode("pay", t.dealId));
            bytes32 tokenNonce = keccak256(abi.encode(t.dealId, digest, salt));
            bytes32 authDigest =
                usdc.authDigest(buyer, address(hub), amount, block.timestamp - 1, block.timestamp + 1 days, tokenNonce);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, authDigest);
            pay = Payment3009({
                validAfter: block.timestamp - 1,
                validBefore: block.timestamp + 1 days,
                paymentSalt: salt,
                v: v,
                r: r,
                s: s,
                use3009: true
            });
        } else {
            bytes32 salt = keccak256(abi.encode("pay", t.dealId));
            bytes32 inonce = keccak256(abi.encode("intent", t.dealId));
            bytes32 idigest = hub.actionDigest(
                keccak256(
                    abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, amount, salt, inonce, uint64(block.timestamp + 1 days))
                )
            );
            intent = AllowanceIntent({
                paymentSalt: salt,
                nonce: inonce,
                expiresAt: uint64(block.timestamp + 1 days),
                signature: _sig(buyerPk, idigest)
            });
        }
    }

    function _fund(DealTerms memory t, bool use3009) internal returns (bytes32 digest) {
        digest = hub.agreementDigestOf(t);
        bytes memory sb = _sig(buyerPk, digest);
        bytes memory ss = _sig(sellerPk, digest);
        uint256 amount = _fundedAmount(t);

        bytes32 admissionNonce = keccak256(abi.encode("adm", t.dealId));
        bytes32 adigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ADMISSION_TYPEHASH, digest, bytes32(0), admissionNonce, uint64(block.timestamp + 1 days), true))
        );
        Admission memory adm = Admission({
            minPolicyId: bytes32(0),
            admissionNonce: admissionNonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(admissionPk, adigest)
        });
        ReadinessAuth memory ready =
            ReadinessAuth({attestedAt: 0, nonce: bytes32(0), expiresAt: 0, signature: new bytes(0)});

        if (use3009) {
            bytes32 salt = keccak256(abi.encode("pay", t.dealId));
            bytes32 tokenNonce = keccak256(abi.encode(t.dealId, digest, salt));
            bytes32 authDigest = usdc.authDigest(buyer, address(hub), amount, block.timestamp - 1, block.timestamp + 1 days, tokenNonce);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, authDigest);
            Payment3009 memory pay = Payment3009({
                validAfter: block.timestamp - 1,
                validBefore: block.timestamp + 1 days,
                paymentSalt: salt,
                v: v,
                r: r,
                s: s,
                use3009: true
            });
            AllowanceIntent memory empty;
            hub.fund(t, sb, ss, pay, empty, adm, ready);
        } else {
            vm.prank(buyer);
            usdc.approve(address(hub), amount);
            bytes32 salt = keccak256(abi.encode("pay", t.dealId));
            bytes32 inonce = keccak256(abi.encode("intent", t.dealId));
            bytes32 idigest = hub.actionDigest(
                keccak256(
                    abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, amount, salt, inonce, uint64(block.timestamp + 1 days))
                )
            );
            AllowanceIntent memory intent = AllowanceIntent({
                paymentSalt: salt,
                nonce: inonce,
                expiresAt: uint64(block.timestamp + 1 days),
                signature: _sig(buyerPk, idigest)
            });
            Payment3009 memory nopay;
            hub.fund(t, sb, ss, nopay, intent, adm, ready);
        }
    }

    function _deliver(bytes32 dealId) internal {
        vm.prank(seller);
        hub.markDelivered(dealId, keccak256("delivery-manifest"), bytes32(0), 0, new bytes(0));
    }

    // ---- T01 ----
    function testFundAllowance() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        (bool funded, uint8 phase) = _dealHead(t.dealId);
        assertTrue(funded);
        assertEq(uint256(phase), 0);
        assertEq(hub.totalLiabilities(), P + 500_000);
    }

    function testFund3009() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, true);
        assertEq(hub.totalLiabilities(), P + 500_000);
    }

    function testFundRejectsWrongQuote() public {
        DealTerms memory t = _terms(P, 10_000);
        t.quotedPlatformFee = 1; // wrong
        (
            bytes32 digest,
            bytes memory sb,
            bytes memory ss,
            Payment3009 memory pay,
            AllowanceIntent memory intent,
            Admission memory adm,
            ReadinessAuth memory ready,
            uint256 amount
        ) = _buildFund(t, false);
        digest;
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        vm.expectRevert(BadTerms.selector);
        hub.fund(t, sb, ss, pay, intent, adm, ready);
    }

    function testFundRejectsRevoked() public {
        DealTerms memory t = _terms(P, 10_000);
        vm.prank(seller);
        hub.revokeUnfundedTerms(t, seller, bytes32(0), 0, new bytes(0));
        (
            ,
            bytes memory sb,
            bytes memory ss,
            Payment3009 memory pay,
            AllowanceIntent memory intent,
            Admission memory adm,
            ReadinessAuth memory ready,
            uint256 amount
        ) = _buildFund(t, false);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        vm.expectRevert(Revoked.selector);
        hub.fund(t, sb, ss, pay, intent, adm, ready);
    }

    function testFundRejectsDoubleFunding() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        (
            ,
            bytes memory sb,
            bytes memory ss,
            Payment3009 memory pay,
            AllowanceIntent memory intent,
            Admission memory adm,
            ReadinessAuth memory ready,
            uint256 amount
        ) = _buildFund(t, false);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        vm.expectRevert(AlreadyFunded.selector);
        hub.fund(t, sb, ss, pay, intent, adm, ready);
    }

    /// @notice Every payout/refund recipient must be nonzero at funding, so a
    /// nonzero entitlement can never silently vanish from the ledger.
    function testFundRejectsZeroRecipients() public {
        for (uint256 i = 0; i < 4; i++) {
            DealTerms memory t = _terms(P, 10_000);
            if (i == 0) t.sellerPayoutAddress = address(0);
            if (i == 1) t.buyerRefundAddress = address(0);
            if (i == 2) t.buyerBondRefundAddress = address(0);
            if (i == 3) t.sellerBondRefundAddress = address(0);
            (
                ,
                bytes memory sb,
                bytes memory ss,
                Payment3009 memory pay,
                AllowanceIntent memory intent,
                Admission memory adm,
                ReadinessAuth memory ready,
                uint256 amount
            ) = _buildFund(t, false);
            vm.prank(buyer);
            usdc.approve(address(hub), amount);
            vm.expectRevert(BadTerms.selector);
            hub.fund(t, sb, ss, pay, intent, adm, ready);
        }
    }

    function testPaymentAuthCannotFundAnotherDeal() public {
        DealTerms memory a = _terms(P, 10_000);
        bytes32 digestA = hub.agreementDigestOf(a);
        // Build a valid 3009 auth for deal A, then try to fund deal B with it.
        uint256 amount = _fundedAmount(a);
        bytes32 salt = keccak256("reuse");
        bytes32 tokenNonce = keccak256(abi.encode(a.dealId, digestA, salt));
        bytes32 authDigest = usdc.authDigest(buyer, address(hub), amount, block.timestamp - 1, block.timestamp + 1 days, tokenNonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, authDigest);

        DealTerms memory b = _terms(P, 10_000);
        bytes32 digestB = hub.agreementDigestOf(b);
        Payment3009 memory pay = Payment3009({
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 days,
            paymentSalt: salt,
            v: v,
            r: r,
            s: s,
            use3009: true
        });
        bytes32 admissionNonce = keccak256("adm-b");
        bytes32 adigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ADMISSION_TYPEHASH, digestB, bytes32(0), admissionNonce, uint64(block.timestamp + 1 days), true))
        );
        Admission memory adm = Admission({
            minPolicyId: bytes32(0),
            admissionNonce: admissionNonce,
            expiresAt: uint64(block.timestamp + 1 days),
            signature: _sig(admissionPk, adigest)
        });
        AllowanceIntent memory empty;
        ReadinessAuth memory ready;
        vm.expectRevert(); // token auth bound to deal A cannot fund deal B
        hub.fund(b, _sig(buyerPk, digestB), _sig(sellerPk, digestB), pay, empty, adm, ready);
    }

    // ---- T05 release ----
    function testReleaseAndClaim() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.prank(buyer);
        hub.approveSeller(t.dealId, bytes32("termv1"), bytes32(0), 0, new bytes(0));
        // buyer-paid full release: buyer 0, seller P, fee F.
        hub.claimFor(t.dealId, 1);
        assertEq(usdc.balanceOf(seller), 1_000_000_000 + P);
        hub.claimFor(t.dealId, 2);
        assertEq(usdc.balanceOf(address(0xFEE)), 500_000);
        assertEq(hub.totalLiabilities(), 0);
    }

    function testReleaseByNonBuyerReverts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.prank(seller);
        vm.expectRevert();
        hub.approveSeller(t.dealId, bytes32("termv1"), bytes32("n"), uint64(block.timestamp + 1 days), new bytes(0));
    }

    // ---- T06 seller refund ----
    function testSellerRefund() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        vm.prank(seller);
        hub.refundBuyer(t.dealId, bytes32("termv1"), bytes32(0), 0, new bytes(0));
        hub.claimFor(t.dealId, 0);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
    }

    // ---- T04 non-delivery ----
    function testNonDeliveryRefund() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        vm.warp(block.timestamp + 3_600 + 1);
        hub.refundForNonDelivery(t.dealId);
        hub.claimFor(t.dealId, 0);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
    }

    // ---- T08 timeout ----
    function testTimeoutSettlesSeller() public {
        DealTerms memory t = _terms(P, 0); // seller-pays
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 3_600 + 1);
        hub.finalizeAfterTimeout(t.dealId);
        hub.claimFor(t.dealId, 1);
        // seller-paid full: seller P - F.
        assertEq(usdc.balanceOf(seller), 1_000_000_000 + (P - 500_000));
    }

    // ---- T09/T12 lapse ----
    function testLapseExhaustsDisputeRight() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        vm.warp(block.timestamp + 100);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        vm.warp(block.timestamp + 2 days);
        hub.lapseDispute(t.dealId);
        vm.prank(buyer);
        vm.expectRevert(DisputeExhausted.selector);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        // Original inspection anchor preserved: timeout still settles seller.
        vm.warp(block.timestamp + 3_600 + 1);
        hub.finalizeAfterTimeout(t.dealId);
    }

    // ---- Full arbitration: escalate -> primary ruling -> execute ----
    function _escalateFresh(bytes32 dealId, bytes32 termsHash, uint64 openedAt)
        internal
        returns (uint64 escAt)
    {
        vm.warp(openedAt + 86_400 + 1);
        vm.prank(buyer);
        usdc.approve(address(hub), 5_000_000);
        vm.prank(buyer);
        hub.escalate(dealId, 5_000_000, 0, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());
        return uint64(block.timestamp);
    }

    function _rulingSigs(bytes32 digest, uint256[] storage pks, uint256 n) internal returns (bytes[] memory sigs) {
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) sigs[i] = _sig(pks[i], digest);
    }

    function testFullSellerRuling() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        // respondent posts too
        vm.prank(seller);
        usdc.approve(address(hub), 5_000_000);
        vm.prank(seller);
        hub.postRespondentBond(t.dealId, 5_000_000, false, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        // queue primary ruling S=P, costs: Cb=5e6, Cs=0.
        bytes32 rulingNonce = keccak256("ruling-1");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rulingNonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rulingNonce,
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
        vm.warp(block.timestamp + 24 hours + 1);
        hub.executeRuling(t.dealId);
        hub.claimFor(t.dealId, 1); // seller P
        hub.claimFor(t.dealId, 2); // fee F
        hub.claimFor(t.dealId, 4); // seller bond refund
        hub.claimFor(t.dealId, 5); // arb cost = buyer bond
        assertEq(usdc.balanceOf(seller), 1_000_000_000 - 5_000_000 + P + 5_000_000);
        assertEq(usdc.balanceOf(address(0xA8B)), 5_000_000);
        assertEq(hub.totalLiabilities(), 0);
    }

    function hubDigest(DealTerms memory t) internal view returns (bytes32) {
        return hub.agreementDigestOf(t);
    }

    function testPartialRulingProportional() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        // S=70M: E=350_000, buyerFee=350_000; Cb=3.5M, Cs=0 (no respondent bond).
        uint256 S = 70_000_000;
        bytes32 rulingNonce = keccak256("ruling-partial");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rulingNonce, S, 3_500_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rulingNonce,
                sellerAward: S,
                buyerCost: 3_500_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
        vm.warp(block.timestamp + 24 hours + 1);
        hub.executeRuling(t.dealId);
        (address r0, uint256 a0) = hub.getClaim(hub.claimIdOf(t.dealId, 0));
        (address r1, uint256 a1) = hub.getClaim(hub.claimIdOf(t.dealId, 1));
        assertEq(a0, 30_150_000);
        assertEq(a1, 70_000_000);
        assertEq(r0, buyer);
        assertEq(r1, seller);
    }

    function testRulingRejectsWrongBondCosts() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        bytes32 rulingNonce = keccak256("ruling-bad");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rulingNonce, P, 0, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        vm.expectRevert(BadAward.selector); // Cb must equal 5M for S=P
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rulingNonce,
                sellerAward: P,
                buyerCost: 0,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
    }

    // ---- Veto -> fallback ----
    function testVetoThenFallbackRuling() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        uint64 escAt = _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(t.dealId);
        bytes32 rulingNonce = keccak256("ruling-veto");
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(0), rulingNonce, P, 5_000_000, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rulingNonce,
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
        // Veto with 2-of-3 veto sigs.
        VetoSig[] memory vsigs = new VetoSig[](2);
        for (uint256 i = 0; i < 2; i++) {
            bytes32 vnonce = keccak256(abi.encode("veto", i));
            uint64 expiry = uint64(block.timestamp + 7 days);
            address authority = vm.addr(vetoPks[i]);
            bytes32 vdigest = hub.actionDigest(
                keccak256(abi.encode(MidmanDK.VETO_TYPEHASH, t.dealId, rdigest, authority, vnonce, expiry))
            );
            vsigs[i] = VetoSig({authority: authority, nonce: vnonce, expiry: expiry, signature: _sig(vetoPks[i], vdigest)});
        }
        hub.vetoPrimaryRuling(t.dealId, rdigest, vsigs);
        // Fallback ruling S=0 (buyer wins): Cb=0.
        bytes32 rnonce2 = keccak256("ruling-fb");
        bytes32 rdigest2 = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, t.dealId, hubDigest(t), arbPolicy, uint8(1), rnonce2, 0, 0, 0, bytes32("evi"), uint64(1), uint64(block.timestamp + 30 days)
                )
            )
        );
        hub.queueFallbackRuling(
            t.dealId,
            RulingAuth({
                origin: 1,
                rulingNonce: rnonce2,
                sellerAward: 0,
                buyerCost: 0,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: uint64(block.timestamp + 30 days),
                signatures: _rulingSigs(rdigest2, fallbackPks, 2)
            })
        );
        vm.warp(block.timestamp + 24 hours + 1);
        hub.executeRuling(t.dealId);
        hub.claimFor(t.dealId, 0);
        hub.claimFor(t.dealId, 3); // claimant bond refund (Cb=0 on full buyer win)
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
    }

    // ---- T23 escape ----
    function testCatastrophicEscape() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(openedAt + 5_184_000 + 1);
        hub.catastrophicEscape(t.dealId);
        ( , uint256 a0) = hub.getClaim(hub.claimIdOf(t.dealId, 0));
        (, uint256 a1) = hub.getClaim(hub.claimIdOf(t.dealId, 1));
        assertEq(a0, P / 2 + 500_000);
        assertEq(a1, P / 2);
        (, uint256 fee) = hub.getClaim(hub.claimIdOf(t.dealId, 2));
        assertEq(fee, 0);
    }

    function testEscapeOddPrincipalToBuyer() public {
        DealTerms memory t = _terms(5_000_001, 10_000);
        _fund(t, false);
        _deliver(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        _escalateFresh(t.dealId, bytes32(0), openedAt);
        vm.warp(openedAt + 5_184_000 + 1);
        hub.catastrophicEscape(t.dealId);
        (, uint256 a0) = hub.getClaim(hub.claimIdOf(t.dealId, 0));
        (, uint256 a1) = hub.getClaim(hub.claimIdOf(t.dealId, 1));
        assertEq(a0, 2_500_001 + 500_000);
        assertEq(a1, 2_500_000);
    }

    // ---- T07 mutual ----
    function testMutualSettlement() public {
        DealTerms memory t = _terms(P, 5_000); // split fee
        _fund(t, false);
        _deliver(t.dealId);
        bytes32 digest = hubDigest(t);
        uint64 expiry = uint64(block.timestamp + 1 days);
        // Offers commit to the live offer epoch (every phase transition retires it).
        bytes32 liveNonce = bytes32(hub.getDeal(t.dealId).settlementNonce);
        bytes32 sdigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.SETTLE_TYPEHASH, t.dealId, digest, 40_000_000, 0, 0, uint8(1), liveNonce, expiry))
        );
        hub.mutualSettlement(t.dealId, 40_000_000, 0, 0, 1, liveNonce, expiry, _sig(buyerPk, sdigest), _sig(sellerPk, sdigest));
        // E = floor(500000*40/100) = 200000; buyerFee = floor(200000*5000/10000)=100000.
        (, uint256 a0) = hub.getClaim(hub.claimIdOf(t.dealId, 0));
        (, uint256 a1) = hub.getClaim(hub.claimIdOf(t.dealId, 1));
        assertEq(a0, 60_000_000 + (250_000 - 100_000));
        assertEq(a1, 40_000_000 - 100_000);
    }

    // ---- Existing-claim bond reserve ----
    function testEscalateWithVestedClaim() public {
        // Deal A settles to the buyer first (seller refund -> buyerPF claim).
        DealTerms memory a = _terms(P, 10_000);
        _fund(a, false);
        vm.prank(seller);
        hub.refundBuyer(a.dealId, bytes32("termv1"), bytes32(0), 0, new bytes(0));
        bytes32 claimA = hub.claimIdOf(a.dealId, 0);
        // Deal B escalates by reserving that vested claim.
        DealTerms memory b = _terms(P, 10_000);
        _fund(b, false);
        _deliver(b.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(b.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        vm.warp(openedAt + 86_400 + 1);
        uint256 liabBefore = hub.totalLiabilities();
        bytes32 enonce = keccak256("esc-existing");
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 edigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ESCALATE_TYPEHASH, b.dealId, hubDigest(b), buyer, 5_000_000, uint8(1), bondPolicy, claimA, enonce, expiry))
        );
        hub.escalate(
            b.dealId,
            5_000_000,
            1,
            claimA,
            enonce,
            expiry,
            _sig(buyerPk, edigest),
            _reserveAuth(b.dealId, hubDigest(b), buyerPk, claimA, 5_000_000, 0, keccak256("reserve-existing"), expiry)
        );
        assertEq(hub.totalLiabilities(), liabBefore); // bucket move, no new value
        (, uint256 left) = hub.getClaim(claimA);
        assertEq(left, (P + 500_000) - 5_000_000);
    }

    /// @notice EVM regression: a party that names another wallet as its bond-
    /// refund address cannot reserve that wallet's existing claim without the
    /// claim owner's ReserveExistingClaim authorization.
    function testReserveClaimRequiresOwnerAuth() public {
        address victim = vm.addr(0xBEEF);
        uint256 victimPk = 0xBEEF;

        // Victim owns a vested claim (buyer funds, refund directed to victim).
        DealTerms memory a = _terms(P, 10_000);
        a.buyerRefundAddress = victim;
        _fund(a, false);
        vm.prank(seller);
        hub.refundBuyer(a.dealId, bytes32("termv1"), bytes32(0), 0, new bytes(0));
        bytes32 claimA = hub.claimIdOf(a.dealId, 0);
        (address recA, uint256 amtA) = hub.getClaim(claimA);
        assertEq(recA, victim);
        assertEq(amtA, P + 500_000);

        // Attacker's deal names the victim as bond-refund address.
        DealTerms memory b = _terms(P, 10_000);
        b.buyerBondRefundAddress = victim;
        _fund(b, false);
        _deliver(b.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        vm.prank(buyer);
        hub.openDispute(b.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        vm.warp(openedAt + 86_400 + 1);

        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 enonce = keccak256("esc-attack");
        bytes32 edigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ESCALATE_TYPEHASH, b.dealId, hubDigest(b), buyer, 5_000_000, uint8(1), bondPolicy, claimA, enonce, expiry))
        );
        bytes memory esig = _sig(buyerPk, edigest);

        // 1. No owner authorization at all.
        vm.expectRevert(BadTerms.selector);
        hub.escalate(b.dealId, 5_000_000, 1, claimA, enonce, expiry, esig, _noReserve());

        // 2. Attacker's own signature presented as owner (owner != recipient).
        ReserveAuth memory forged =
            _reserveAuth(b.dealId, hubDigest(b), buyerPk, claimA, 5_000_000, 0, keccak256("forge"), expiry);
        vm.expectRevert(BadTerms.selector);
        hub.escalate(b.dealId, 5_000_000, 1, claimA, enonce, expiry, esig, forged);

        // 3. Victim-signed authorization for a different amount.
        ReserveAuth memory wrongAmt =
            _reserveAuth(b.dealId, hubDigest(b), victimPk, claimA, 1_000_000, 0, keccak256("wrong"), expiry);
        vm.expectRevert(BadTerms.selector);
        hub.escalate(b.dealId, 5_000_000, 1, claimA, enonce, expiry, esig, wrongAmt);

        // 4. Correct victim authorization succeeds; liabilities only move buckets.
        uint256 liabBefore = hub.totalLiabilities();
        ReserveAuth memory good =
            _reserveAuth(b.dealId, hubDigest(b), victimPk, claimA, 5_000_000, 0, keccak256("good"), expiry);
        hub.escalate(b.dealId, 5_000_000, 1, claimA, enonce, expiry, esig, good);
        assertEq(hub.totalLiabilities(), liabBefore);
        (, uint256 left) = hub.getClaim(claimA);
        assertEq(left, amtA - 5_000_000);

        // 5. Expired owner authorization reverts while the escalation sig is live.
        DealTerms memory c = _terms(P, 10_000);
        c.buyerBondRefundAddress = victim;
        _fund(c, false);
        _deliver(c.dealId);
        uint64 openedC = uint64(block.timestamp + 100);
        vm.warp(openedC);
        vm.prank(buyer);
        hub.openDispute(c.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
        vm.warp(openedC + 86_400 + 1);
        uint64 expiryC = uint64(block.timestamp + 1 days);
        uint64 shortAuth = uint64(block.timestamp + 1 hours);
        bytes32 enonceC = keccak256("esc-stale-auth");
        bytes32 edigestC = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ESCALATE_TYPEHASH, c.dealId, hubDigest(c), buyer, 5_000_000, uint8(1), bondPolicy, claimA, enonceC, expiryC))
        );
        // Owner signs a 1-hour authorization; submission happens after it lapses
        // but inside the escalation window with a live escalation signature.
        ReserveAuth memory stale =
            _reserveAuth(c.dealId, hubDigest(c), victimPk, claimA, 5_000_000, 0, keccak256("stale"), shortAuth);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(Expired.selector);
        hub.escalate(
            c.dealId, 5_000_000, 1, claimA, enonceC, expiryC, _sig(buyerPk, edigestC), stale
        );
    }

    // ---- Pause / rescue ----
    function testPauseBlocksFunding() public {
        vm.prank(pauser);
        hub.pauseNewFunding();
        DealTerms memory t = _terms(P, 10_000);
        (
            ,
            bytes memory sb,
            bytes memory ss,
            Payment3009 memory pay,
            AllowanceIntent memory intent,
            Admission memory adm,
            ReadinessAuth memory ready,
            uint256 amount
        ) = _buildFund(t, false);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        vm.expectRevert(Paused.selector);
        hub.fund(t, sb, ss, pay, intent, adm, ready);
        vm.prank(governance);
        hub.proposeUnpause();
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(governance);
        hub.executeUnpause();
        _fund(t, false);
    }

    function testRescueOnlyExcess() public {
        DealTerms memory t = _terms(P, 10_000);
        _fund(t, false);
        vm.prank(governance);
        vm.expectRevert(NothingToRescue.selector);
        hub.rescueExcess(1);
        // Unsolicited donation creates excess, never a credited deal.
        vm.prank(buyer);
        usdc.transfer(address(hub), 1_000_000);
        vm.prank(governance);
        hub.rescueExcess(1_000_000);
        assertEq(usdc.balanceOf(treasury), 1_000_000);
    }

    // ---- Head reader (avoids stack juggling in assertions) ----
    function _dealHead(bytes32 dealId) internal view returns (bool funded, uint8 phase) {
        Deal memory d = hub.getDeal(dealId);
        return (d.funded, d.phase);
    }
}
