// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanHub} from "../../src/MidmanHub.sol";
import {MidmanPolicies} from "../../src/MidmanPolicies.sol";
import {MockUSDC, MockFeed} from "../Mocks.t.sol";
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
    BadNonce,
    BadPhase,
    DisputeExhausted,
    Expired,
    NoQuorum,
    Revoked
} from "../../src/DealTypes.sol";

/// @notice Phase 10 adversarial acceptance suite: false delivery, partial
/// awards, lapse, missing respondent, mutual settlement, veto->fallback,
/// revocation, catastrophic escape, token-wide failure, subsidized-case abuse,
/// permissionless relayer transitions and consent/authorization boundaries.
/// Self-contained: helper patterns are copied from the Journey/Arbitration
/// suites; only the shared mocks are imported. Nothing is imported from other
/// test files.
///
/// Timestamps after `vm.warp` are always read through `_now()` (an external
/// cheatcode call) because the via-IR optimizer may CSE `block.timestamp` and
/// reuse pre-warp values.
contract AcceptanceTest is Test {
    MidmanHub public hub;
    MidmanPolicies public policies;
    MockUSDC public usdc;
    MockFeed public feed;

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
    address relayer = address(0x1E1A7E12);
    address stranger = address(0xBADB0B);
    address feeRecipient = address(0xFEE);
    address arbRecipient = address(0xA8B);

    uint256[] primaryPks = [0x101, 0x102, 0x103, 0x104, 0x105];
    uint256[] fallbackPks = [0x201, 0x202, 0x203, 0x204, 0x205];
    uint256[] vetoPks = [0x301, 0x302, 0x303];
    address[] primary;
    address[] fbPanel;
    address[] veto;

    bytes32 feePolicy = keccak256("FEEv1");
    bytes32 categoryPolicy = keccak256("CATv1");
    bytes32 noReadiness = keccak256("READY-NONE");
    bytes32 readinessPolicy = keccak256("READY-REQ");
    bytes32 evidencePolicy = keccak256("EVIv1");
    bytes32 bondPolicy = keccak256("BONDv1");
    bytes32 arbPolicy = keccak256("ARBv1");
    bytes32 outagePolicy = keccak256("OUTv1");
    bytes32 catPolicy = keccak256("ESCv1");

    uint256 constant P = 100_000_000; // 100 USDC
    uint256 constant FEE = 500_000; // min-floor quote at 25bps/7200s
    uint256 constant BOND = 5_000_000; // 5 USDC per contesting party
    uint256 constant FUNDED = P + FEE; // 100.5 USDC
    uint64 constant START = 1_000_000;
    uint256 dealCounter;

    function setUp() public {
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
        policies.registerReadinessPolicy(readinessPolicy, keccak256("ready-req-content"), true);
        policies.registerEvidencePolicy(evidencePolicy, keccak256("evi-content"));
        policies.registerBondPolicy(bondPolicy, keccak256("bond-content"), BOND, BOND);
        policies.registerArbitrationPolicy(arbPolicy, keccak256("arb-content"), 0x07);
        policies.registerOutagePolicy(outagePolicy, keccak256("out-content"), 1_800, 8);
        policies.registerCatastrophicPolicy(catPolicy, keccak256("esc-content"));
        vm.stopPrank();

        usdc.mint(buyer, 1_000_000_000);
        usdc.mint(seller, 1_000_000_000);
    }

    // ================= Copied helper patterns =================
    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

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
        uint256 q = (principal * 25 + 9_999) / 10_000;
        t.quotedPlatformFee = q < FEE ? FEE : q;
        t.buyerFeeBps = bps;
        t.agreementHash = keccak256("agreement-bytes");
        t.feePolicyId = feePolicy;
        t.deliveryPeriodSeconds = 3_600;
        t.inspectionPeriodSeconds = 3_600;
        t.categoryPolicyId = categoryPolicy;
        t.readinessPolicyId = readinessPolicy;
        t.readinessConsentHash = keccak256("ready-consent");
        t.evidencePolicyId = evidencePolicy;
        t.bondPolicyId = bondPolicy;
        t.arbitrationPolicyId = arbPolicy;
        t.outagePolicyId = outagePolicy;
        t.catastrophicPolicyId = catPolicy;
        t.platformFeeRecipient = feeRecipient;
        t.arbitrationCostRecipient = arbRecipient;
        t.fundingDeadline = uint64(_now() + 7 days);
        t.nonce = keccak256(abi.encode("nonce", dealCounter));
        t.salt = keccak256(abi.encode("salt", dealCounter));
        t.factory = address(0);
        t.implementation = address(0);
        t.custodyAddress = address(hub);
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _admission(bytes32 digest, bytes32 dealId) internal returns (Admission memory adm) {
        bytes32 anonce = keccak256(abi.encode("adm", dealId));
        uint64 exp = uint64(_now() + 1 days);
        bytes32 adigest =
            hub.actionDigest(keccak256(abi.encode(MidmanDK.ADMISSION_TYPEHASH, digest, categoryPolicy, anonce, exp, true)));
        adm = Admission({minPolicyId: categoryPolicy, admissionNonce: anonce, expiresAt: exp, signature: _sig(admissionPk, adigest)});
    }

    function _ready(DealTerms memory t, bytes32 digest) internal view returns (ReadinessAuth memory r) {
        uint64 attestedAt = uint64(_now());
        uint64 expiresAt = uint64(_now() + 2 hours);
        bytes32 nonce = keccak256(abi.encode("ready", t.dealId));
        bytes32 rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.READINESS_TYPEHASH, t.dealId, digest, t.buyerAddress, attestedAt, nonce, expiresAt
                )
            )
        );
        r = ReadinessAuth({attestedAt: attestedAt, nonce: nonce, expiresAt: expiresAt, signature: _sig(buyerPk, rdigest)});
    }

    function _fundedAmount(DealTerms memory t) internal pure returns (uint256) {
        return t.principal + (t.quotedPlatformFee * t.buyerFeeBps) / 10_000;
    }

    /// @notice Build funding parameters WITHOUT approving or submitting, so
    /// rejection tests can place `vm.expectRevert` immediately before `fund`.
    function _prepFundAllowance(DealTerms memory t)
        internal
        returns (bytes32 digest, bytes memory sb, bytes memory ss, AllowanceIntent memory intent, Admission memory adm, uint256 amount)
    {
        digest = hub.agreementDigestOf(t);
        sb = _sig(buyerPk, digest);
        ss = _sig(sellerPk, digest);
        amount = _fundedAmount(t);
        bytes32 salt = keccak256(abi.encode("pay", t.dealId));
        bytes32 inonce = keccak256(abi.encode("intent", t.dealId));
        uint64 exp = uint64(_now() + 1 days);
        bytes32 idigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, amount, salt, inonce, exp))
        );
        intent = AllowanceIntent({paymentSalt: salt, nonce: inonce, expiresAt: exp, signature: _sig(buyerPk, idigest)});
        adm = _admission(digest, t.dealId);
    }

    function _fundAllowance(DealTerms memory t) internal returns (bytes32 digest) {
        bytes memory sb;
        bytes memory ss;
        AllowanceIntent memory intent;
        Admission memory adm;
        uint256 amount;
        (digest, sb, ss, intent, adm, amount) = _prepFundAllowance(t);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        Payment3009 memory nopay;
        hub.fund(t, sb, ss, nopay, intent, adm, _ready(t, digest));
    }

    function _deliverDirect(bytes32 dealId) internal {
        vm.prank(seller);
        hub.markDelivered(dealId, keccak256("delivery-manifest"), bytes32(0), 0, new bytes(0));
    }

    function _openDisputeDirect(bytes32 dealId) internal {
        vm.prank(buyer);
        hub.openDispute(dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));
    }

    function _escalateAt(bytes32 dealId, uint64 openedAt) internal returns (uint64 escAt) {
        vm.warp(openedAt + 86_400 + 1);
        vm.prank(buyer);
        usdc.approve(address(hub), BOND);
        vm.prank(buyer);
        hub.escalate(dealId, BOND, 0, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());
        return uint64(_now());
    }

    function _respondentBond(bytes32 dealId) internal {
        vm.prank(seller);
        usdc.approve(address(hub), BOND);
        vm.prank(seller);
        hub.postRespondentBond(dealId, BOND, false, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());
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

    function _submitEvidence(bytes32 dealId, address uploader, uint32 seq, bytes32 prev) internal returns (bytes32) {
        bytes32[] memory files = new bytes32[](1);
        files[0] = keccak256(abi.encode("file", uploader, seq));
        vm.prank(uploader);
        hub.submitEvidenceCommitment(dealId, uploader, seq, prev, files, keccak256("meta"), bytes32(0), 0, new bytes(0));
        return hub.getDeal(dealId).manifestHead;
    }

    function _toMem(uint256[] storage a) internal returns (uint256[] memory m) {
        m = new uint256[](a.length);
        for (uint256 i = 0; i < a.length; i++) m[i] = a[i];
    }

    function _sigsMem(bytes32 digest, uint256[] memory pks, uint256 n) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    function _rulingDigest(
        bytes32 dealId,
        bytes32 termsHash,
        uint8 origin,
        bytes32 rnonce,
        uint256 award,
        uint256 buyerCost,
        uint256 sellerCost,
        bytes32 evi,
        uint64 epoch,
        uint64 expiry
    ) internal view returns (bytes32) {
        return hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH,
                    dealId,
                    termsHash,
                    arbPolicy,
                    origin,
                    rnonce,
                    award,
                    buyerCost,
                    sellerCost,
                    evi,
                    epoch,
                    expiry
                )
            )
        );
    }

    /// @notice Build the ruling authorization + digest WITHOUT calling the hub's
    /// state-changing queue function.
    function _prepQueue(
        bytes32 dealId,
        uint8 origin,
        bytes32 rnonce,
        uint256 award,
        uint256 buyerCost,
        uint256 sellerCost,
        bytes32 evi,
        uint64 epoch,
        uint256[] memory pks,
        uint256 n
    ) internal view returns (RulingAuth memory r, bytes32 rdigest) {
        uint64 expiry = uint64(_now() + 30 days);
        bytes32 termsHash = hub.getDeal(dealId).termsHash;
        rdigest = _rulingDigest(dealId, termsHash, origin, rnonce, award, buyerCost, sellerCost, evi, epoch, expiry);
        r = RulingAuth({
            origin: origin,
            rulingNonce: rnonce,
            sellerAward: award,
            buyerCost: buyerCost,
            sellerCost: sellerCost,
            evidenceCommitment: evi,
            authEpoch: epoch,
            queueExpiry: expiry,
            signatures: _sigsMem(rdigest, pks, n)
        });
    }

    function _sendQueue(bytes32 dealId, RulingAuth memory r) internal {
        if (r.origin == 0) hub.queuePrimaryRuling(dealId, r);
        else hub.queueFallbackRuling(dealId, r);
    }

    function _queueWithPks(
        bytes32 dealId,
        uint8 origin,
        bytes32 rnonce,
        uint256 award,
        uint256 buyerCost,
        uint256 sellerCost,
        bytes32 evi,
        uint64 epoch,
        uint256[] memory pks,
        uint256 n
    ) internal returns (bytes32 rdigest) {
        RulingAuth memory r;
        (r, rdigest) = _prepQueue(dealId, origin, rnonce, award, buyerCost, sellerCost, evi, epoch, pks, n);
        _sendQueue(dealId, r);
    }

    function _vetoSigs(bytes32 dealId, bytes32 rdigest, uint256 n, bytes32 salt)
        internal
        returns (VetoSig[] memory vs)
    {
        vs = new VetoSig[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 vnonce = keccak256(abi.encode(salt, i));
            uint64 expiry = uint64(_now() + 7 days);
            address authority = vm.addr(vetoPks[i]);
            bytes32 vdigest =
                hub.actionDigest(keccak256(abi.encode(MidmanDK.VETO_TYPEHASH, dealId, rdigest, authority, vnonce, expiry)));
            vs[i] = VetoSig({authority: authority, nonce: vnonce, expiry: expiry, signature: _sig(vetoPks[i], vdigest)});
        }
    }

    function _phase(bytes32 dealId) internal view returns (uint8) {
        return hub.getDeal(dealId).phase;
    }

    function _claimsSum(bytes32 dealId) internal view returns (uint256 sum) {
        for (uint8 k = 0; k < 6; k++) {
            (, uint256 a) = hub.getClaim(hub.claimIdOf(dealId, k));
            sum += a;
        }
    }

    function _assertClaim(bytes32 dealId, uint8 kind, address recipient, uint256 amount) internal view {
        (address r, uint256 a) = hub.getClaim(hub.claimIdOf(dealId, kind));
        assertEq(r, recipient);
        assertEq(a, amount);
    }

    /// @notice Drain every non-empty claim kind for a deal (empty kinds revert NoClaim).
    function _drain(bytes32 dealId) internal {
        for (uint8 k = 0; k < 6; k++) {
            try hub.claimFor(dealId, k) {} catch {}
        }
    }

    function _assertSolvent() internal view {
        assertGe(usdc.balanceOf(address(hub)), hub.totalLiabilities(), "hub solvent");
    }

    function _gas(string memory label, uint256 g0) internal {
        emit log_named_uint(label, g0 - gasleft());
    }

    /// @notice Open + fund + deliver + dispute + escalate, returning (deal, openedAt, escAt).
    function _disputedEscalated(uint16 bps)
        internal
        returns (DealTerms memory t, uint64 openedAt, uint64 escAt)
    {
        t = _terms(P, bps);
        _fundAllowance(t);
        _deliverDirect(t.dealId);
        openedAt = uint64(_now() + 100);
        vm.warp(openedAt);
        _openDisputeDirect(t.dealId);
        escAt = _escalateAt(t.dealId, openedAt);
    }

    function _advanceToPrimary(uint64 escAt, bytes32 dealId) internal {
        vm.warp(escAt + 86_400 + 1);
        hub.advanceToPrimary(dealId);
        assertEq(_phase(dealId), 5, "primary review");
    }

    // ================= 1: false delivery, S=0 buyer win, claimant only =================
    function testAcceptance01_FalseDeliveryBuyerWin() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);

        // Both sides file evidence; only the claimant posted a bond.
        bytes32 head1 = _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        bytes32 head2 = _submitEvidence(t.dealId, seller, 1, head1);
        assertEq(hub.getDeal(t.dealId).manifestCount, 2, "both evidence chained");

        _advanceToPrimary(escAt, t.dealId);

        uint256 g = gasleft();
        _queueWithPks(t.dealId, 0, keccak256("A1"), 0, 0, 0, head2, 1, _toMem(primaryPks), 2);
        _gas("A1_queue", g);

        vm.warp(_now() + 24 hours + 1);
        g = gasleft();
        hub.executeRuling(t.dealId);
        _gas("A1_execute", g);

        uint256 inflow = FUNDED + BOND;
        _assertClaim(t.dealId, 0, buyer, FUNDED); // full principal + prepaid fee
        _assertClaim(t.dealId, 1, address(0), 0); // seller nothing
        _assertClaim(t.dealId, 2, address(0), 0); // zero earned fee
        _assertClaim(t.dealId, 3, buyer, BOND); // claimant bond refunded whole
        _assertClaim(t.dealId, 4, address(0), 0);
        _assertClaim(t.dealId, 5, address(0), 0); // zero arb revenue
        assertEq(_claimsSum(t.dealId), inflow, "A1 conservation");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer made whole");
        assertEq(usdc.balanceOf(seller), 1_000_000_000, "seller untouched");
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(arbRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 2: partial award S=70% with both bonds =================
    function testAcceptance02_PartialAwardBothBonds() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        _advanceToPrimary(escAt, t.dealId);

        uint256 S = 70_000_000;
        uint256 g = gasleft();
        _queueWithPks(t.dealId, 0, keccak256("A2"), S, 3_500_000, 1_500_000, bytes32("evi"), 1, _toMem(primaryPks), 2);
        _gas("A2_queue", g);

        vm.warp(_now() + 24 hours + 1);
        g = gasleft();
        hub.executeRuling(t.dealId);
        _gas("A2_execute", g);

        uint256 inflow = FUNDED + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, 30_150_000);
        _assertClaim(t.dealId, 1, seller, 70_000_000);
        _assertClaim(t.dealId, 2, feeRecipient, 350_000); // floor(F*S/P)
        _assertClaim(t.dealId, 3, buyer, 1_500_000); // Qb - floor(Qb*S/P)
        _assertClaim(t.dealId, 4, seller, 3_500_000); // Qs - floor(Qs*(P-S)/P)
        _assertClaim(t.dealId, 5, arbRecipient, 5_000_000); // exact Cb+Cs
        assertEq(_claimsSum(t.dealId), inflow, "A2 conservation");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 926_150_000);
        assertEq(usdc.balanceOf(seller), 1_068_500_000);
        assertEq(usdc.balanceOf(feeRecipient), 350_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 3: lapsed escalation -> timeout, dispute exhausted =================
    function testAcceptance03_LapsedEscalation() public {
        DealTerms memory t = _terms(P, 10_000);
        _fundAllowance(t);
        _deliverDirect(t.dealId);
        uint64 deliveredAt = hub.getDeal(t.dealId).deliveredAt;
        uint64 openedAt = uint64(_now() + 100);
        vm.warp(openedAt);
        _openDisputeDirect(t.dealId);

        // No escalation: lapse once the escalation window closes.
        vm.warp(openedAt + 2 * 86_400 + 1);
        hub.lapseDispute(t.dealId);
        assertEq(_phase(t.dealId), 1, "back to delivered");

        // One-shot dispute right is spent.
        vm.prank(buyer);
        vm.expectRevert(DisputeExhausted.selector);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));

        // Original inspection anchor preserved: timeout settles the seller.
        vm.warp(deliveredAt + 3_600 + 1);
        hub.finalizeAfterTimeout(t.dealId);

        uint256 inflow = FUNDED;
        _assertClaim(t.dealId, 1, seller, P);
        _assertClaim(t.dealId, 2, feeRecipient, FEE);
        assertEq(_claimsSum(t.dealId), inflow, "A3 conservation");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 899_500_000);
        assertEq(usdc.balanceOf(seller), 1_100_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 500_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 4: missing respondent, award on claimant evidence =================
    function testAcceptance04_MissingRespondent() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        bytes32 evi = _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        // No seller bond and no seller evidence: review proceeds anyway.
        assertEq(hub.getDeal(t.dealId).respondentBond, 0, "no respondent bond");

        _advanceToPrimary(escAt, t.dealId);
        _queueWithPks(t.dealId, 0, keccak256("A4"), 0, 0, 0, evi, 1, _toMem(primaryPks), 2);
        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(t.dealId);

        uint256 inflow = FUNDED + BOND;
        _assertClaim(t.dealId, 0, buyer, FUNDED);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 5, address(0), 0); // no fictional arb revenue
        assertEq(_claimsSum(t.dealId), inflow, "A4 conservation");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
        assertEq(usdc.balanceOf(seller), 1_000_000_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 5: mutual settlement mid-dispute + stale nonce =================
    function testAcceptance05_MutualMidDispute() public {
        (DealTerms memory t, , ) = _disputedEscalated(10_000); // each transition retires the offer epoch

        uint256 S = 40_000_000;
        uint256 buyerCost = 1_000_000;
        uint256 sellerCost = 2_000_000;
        uint64 expiry = uint64(_now() + 1 days);
        bytes32 termsHash = hub.agreementDigestOf(t);

        bytes32 staleDigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.SETTLE_TYPEHASH, t.dealId, termsHash, S, buyerCost, sellerCost, MidmanDK.PH_EVIDENCE, bytes32(uint256(1)), expiry
                )
            )
        );
        bytes memory staleB = _sig(buyerPk, staleDigest);
        bytes memory staleS = _sig(sellerPk, staleDigest);

        _respondentBond(t.dealId); // new collateral retires the stale offer epoch

        vm.expectRevert(BadNonce.selector);
        hub.mutualSettlement(t.dealId, S, buyerCost, sellerCost, MidmanDK.PH_EVIDENCE, bytes32(uint256(1)), expiry, staleB, staleS);

        // Costs are bilaterally bounded by the posted bonds.
        assertLe(buyerCost, hub.getDeal(t.dealId).claimantBond, "buyerCost bounded");
        assertLe(sellerCost, hub.getDeal(t.dealId).respondentBond, "sellerCost bounded");

        bytes32 liveNonce = bytes32(hub.getDeal(t.dealId).settlementNonce);
        bytes32 freshDigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.SETTLE_TYPEHASH, t.dealId, termsHash, S, buyerCost, sellerCost, MidmanDK.PH_EVIDENCE, liveNonce, expiry
                )
            )
        );
        hub.mutualSettlement(
            t.dealId, S, buyerCost, sellerCost, MidmanDK.PH_EVIDENCE, liveNonce, expiry, _sig(buyerPk, freshDigest), _sig(sellerPk, freshDigest)
        );

        uint256 inflow = FUNDED + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, 60_300_000);
        _assertClaim(t.dealId, 1, seller, 40_000_000);
        _assertClaim(t.dealId, 2, feeRecipient, 200_000);
        _assertClaim(t.dealId, 3, buyer, 4_000_000);
        _assertClaim(t.dealId, 4, seller, 3_000_000);
        _assertClaim(t.dealId, 5, arbRecipient, 3_000_000);
        assertEq(_claimsSum(t.dealId), inflow, "A5 conservation");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 958_800_000);
        assertEq(usdc.balanceOf(seller), 1_038_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 200_000);
        assertEq(usdc.balanceOf(arbRecipient), 3_000_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 6: primary veto is cancel-only; fallback decides =================
    function testAcceptance06_VetoThenFallback() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        _advanceToPrimary(escAt, t.dealId);

        bytes32 rdigest =
            _queueWithPks(t.dealId, 0, keccak256("A6-primary"), P, BOND, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        assertEq(_phase(t.dealId), 7, "ruling pending");
        assertEq(_claimsSum(t.dealId), 0, "no payout while pending");

        // 2-of-3 independent veto: cancel-only, creates no claims.
        hub.vetoPrimaryRuling(t.dealId, rdigest, _vetoSigs(t.dealId, rdigest, 2, keccak256("A6-veto")));
        assertEq(_phase(t.dealId), 6, "fallback review after veto");
        assertEq(_claimsSum(t.dealId), 0, "veto pays nothing");
        (, , uint256 claimsBucket) = hub.ledgerTotals();
        assertEq(claimsBucket, 0, "no claim liability from veto");
        vm.expectRevert(BadPhase.selector);
        hub.executeRuling(t.dealId); // veto has no payout authority

        // Independent fallback panel rules S=0 (buyer wins): Cs=Qs.
        _queueWithPks(t.dealId, 1, keccak256("A6-fallback"), 0, 0, BOND, bytes32("evi"), 1, _toMem(fallbackPks), 2);
        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(t.dealId);

        uint256 inflow = FUNDED + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, FUNDED);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 5, arbRecipient, BOND);
        assertEq(_claimsSum(t.dealId), inflow, "A6 conservation");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
        assertEq(usdc.balanceOf(seller), 995_000_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 7: revoked terms cannot be funded =================
    function testAcceptance07_RevokedTerms() public {
        DealTerms memory t = _terms(P, 10_000);
        bytes32 digest = hub.agreementDigestOf(t);

        vm.prank(seller);
        hub.revokeUnfundedTerms(t, seller, bytes32(0), 0, new bytes(0));
        assertTrue(hub.isRevoked(digest), "terms revoked");

        (bytes32 d2, bytes memory sb, bytes memory ss, AllowanceIntent memory intent, Admission memory adm, uint256 amount) =
            _prepFundAllowance(t);
        assertEq(d2, digest, "digest stable");

        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        Payment3009 memory nopay;
        ReadinessAuth memory ready = _ready(t, digest);
        vm.expectRevert(Revoked.selector);
        hub.fund(t, sb, ss, nopay, intent, adm, ready);

        // No custody entered, no liability created.
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ============ 8: fixed 60-day cutoff, odd-unit escape, zero fee ============
    function testAcceptance08_LongDeadlineEscapeOddUnit() public {
        uint256 oddP = 100_000_001; // odd principal: unit to buyer
        uint256 fundedOdd = oddP + FEE; // 100_500_001

        DealTerms memory t = _terms(oddP, 10_000);
        _fundAllowance(t);
        _deliverDirect(t.dealId);
        uint64 openedAt = uint64(_now() + 100);
        vm.warp(openedAt);
        _openDisputeDirect(t.dealId);
        _escalateAt(t.dealId, openedAt);
        _respondentBond(t.dealId);

        // escapeAt is the fixed production constant, independent of any deadline.
        assertEq(hub.escapeAt(t.dealId), openedAt + 5_184_000, "fixed 60-day cutoff");

        vm.warp(openedAt + 5_184_000); // exactly at the cutoff
        hub.catastrophicEscape(t.dealId);

        uint256 buyerShare = oddP - (oddP / 2); // ceil(oddP/2)
        uint256 sellerShare = oddP / 2; // floor(oddP/2)
        uint256 inflow = fundedOdd + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, buyerShare + FEE);
        _assertClaim(t.dealId, 1, seller, sellerShare);
        _assertClaim(t.dealId, 2, address(0), 0); // zero fee on escape
        _assertClaim(t.dealId, 3, buyer, BOND); // bonds refunded
        _assertClaim(t.dealId, 4, seller, BOND);
        _assertClaim(t.dealId, 5, address(0), 0);
        assertEq(_claimsSum(t.dealId), inflow, "A8 conservation");
        assertEq(buyerShare, sellerShare + 1, "odd unit to buyer");

        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000 - fundedOdd - BOND + buyerShare + FEE + BOND);
        assertEq(usdc.balanceOf(seller), 1_000_000_000 - BOND + sellerShare + BOND);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(arbRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 9: token-wide failure preserves liability =================
    function testAcceptance09_TokenWideFailure() public {
        DealTerms memory t = _terms(P, 10_000);
        _fundAllowance(t);
        _deliverDirect(t.dealId);
        vm.warp(_now() + 3_600 + 1);
        hub.finalizeAfterTimeout(t.dealId); // settles seller

        assertEq(_claimsSum(t.dealId), FUNDED, "A9 conservation");

        usdc.setBlocked(seller, true);
        vm.expectRevert();
        hub.claimFor(t.dealId, 1); // token transfer fails
        assertEq(hub.totalLiabilities(), FUNDED, "blocked claim preserves liability");
        assertEq(_claimsSum(t.dealId), FUNDED, "claim state rolled back");

        usdc.setBlocked(seller, false);
        _assertSolvent();
        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 899_500_000);
        assertEq(usdc.balanceOf(seller), 1_100_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 500_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 10: subsidized-case abuse stays solvent =================
    function testAcceptance10_SubsidizedCaseAbuse() public {
        uint256 tinyP = 5_000_000; // 5 USDC minimum
        uint256 tinyFunded = tinyP + FEE; // 5.5 USDC
        uint256 perDeal = tinyFunded + BOND; // fully refunded buyer + bond
        bytes32[] memory ids = new bytes32[](5);

        for (uint256 i = 0; i < 5; i++) {
            DealTerms memory t = _terms(tinyP, 10_000);
            _fundAllowance(t);
            _deliverDirect(t.dealId);
            uint64 openedAt = uint64(_now() + 100);
            vm.warp(openedAt);
            _openDisputeDirect(t.dealId);
            uint64 escAt = _escalateAt(t.dealId, openedAt);
            _advanceToPrimary(escAt, t.dealId);
            _queueWithPks(t.dealId, 0, keccak256(abi.encode("A10", i)), 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
            vm.warp(_now() + 24 hours + 1);
            hub.executeRuling(t.dealId);
            ids[i] = t.dealId;
        }

        for (uint256 i = 0; i < 5; i++) {
            assertEq(_claimsSum(ids[i]), perDeal, "A10 per-deal conservation");
            _assertClaim(ids[i], 0, buyer, tinyFunded);
            _assertClaim(ids[i], 3, buyer, BOND);
            _assertClaim(ids[i], 5, address(0), 0); // zero arb revenue per subsidized case
        }

        uint256 globalLiab = hub.totalLiabilities();
        assertEq(globalLiab, 5 * perDeal, "A10 aggregate liabilities");
        _assertSolvent();

        for (uint256 i = 0; i < 5; i++) _drain(ids[i]);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer fully refunded on all cases");
        assertEq(usdc.balanceOf(seller), 1_000_000_000, "seller untouched");
        assertEq(usdc.balanceOf(arbRecipient), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= 11: permissionless transitions via a relayer =================
    function testAcceptance11_PermissionlessRelayer() public {
        // ---- timeout: anyone may finalize ----
        DealTerms memory tA = _terms(P, 10_000);
        _fundAllowance(tA);
        _deliverDirect(tA.dealId);
        vm.warp(_now() + 3_600 + 1);
        uint256 g = gasleft();
        vm.prank(relayer);
        hub.finalizeAfterTimeout(tA.dealId);
        _gas("A11_timeout_relayer", g);
        assertEq(_phase(tA.dealId), 9, "timeout settled by relayer");
        assertEq(_claimsSum(tA.dealId), FUNDED, "A11 T conservation");

        // ---- claim: anyone may trigger the fixed-recipient payout ----
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(relayer);
        hub.claimFor(tA.dealId, 1);
        vm.prank(relayer);
        hub.claimFor(tA.dealId, 2);
        assertEq(usdc.balanceOf(seller), sellerBefore + P, "relayer-triggered claim pays seller");
        assertEq(usdc.balanceOf(relayer), 0, "relayer gains nothing");

        // ---- lapse: anyone may lapse an un-escalated dispute ----
        DealTerms memory tL = _terms(P, 10_000);
        _fundAllowance(tL);
        _deliverDirect(tL.dealId);
        uint64 deliveredL = hub.getDeal(tL.dealId).deliveredAt;
        uint64 openedL = uint64(_now() + 100);
        vm.warp(openedL);
        _openDisputeDirect(tL.dealId);
        vm.warp(openedL + 2 * 86_400 + 1);
        vm.prank(relayer);
        hub.lapseDispute(tL.dealId);
        assertEq(_phase(tL.dealId), 1, "lapsed by relayer");
        vm.warp(deliveredL + 3_600 + 1);
        vm.prank(relayer);
        hub.finalizeAfterTimeout(tL.dealId);
        assertEq(_phase(tL.dealId), 9, "lapsed deal timeout settled by relayer");

        // ---- advance + execute: anyone may progress and execute a queued award ----
        DealTerms memory tE = _terms(P, 10_000);
        _fundAllowance(tE);
        _deliverDirect(tE.dealId);
        uint64 openedE = uint64(_now() + 100);
        vm.warp(openedE);
        _openDisputeDirect(tE.dealId);
        uint64 escE = _escalateAt(tE.dealId, openedE);
        vm.warp(escE + 86_400 + 1);
        vm.prank(relayer);
        hub.advanceToPrimary(tE.dealId);
        assertEq(_phase(tE.dealId), 5, "advanced by relayer");
        _queueWithPks(tE.dealId, 0, keccak256("A11-exec"), 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.warp(_now() + 24 hours + 1);
        vm.prank(relayer);
        hub.executeRuling(tE.dealId);
        assertEq(_phase(tE.dealId), 9, "executed by relayer");

        // ---- escape: anyone may trigger the fixed 60-day split ----
        DealTerms memory tX = _terms(P, 10_000);
        _fundAllowance(tX);
        _deliverDirect(tX.dealId);
        uint64 openedX = uint64(_now() + 100);
        vm.warp(openedX);
        _openDisputeDirect(tX.dealId);
        _escalateAt(tX.dealId, openedX);
        _respondentBond(tX.dealId);
        vm.warp(openedX + 5_184_000);
        vm.prank(relayer);
        hub.catastrophicEscape(tX.dealId);
        assertEq(_phase(tX.dealId), 9, "escaped by relayer");

        // Conservation per undrained deal, then global solvency and drain.
        // (T was already settled AND claimed above, so its claims are consumed.)
        assertEq(_claimsSum(tL.dealId), FUNDED, "A11 L conservation");
        assertEq(_claimsSum(tE.dealId), FUNDED + BOND, "A11 E conservation");
        assertEq(_claimsSum(tX.dealId), FUNDED + 2 * BOND, "A11 X conservation");
        _assertSolvent();

        _drain(tA.dealId);
        _drain(tL.dealId);
        _drain(tE.dealId);
        _drain(tX.dealId);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ============ 12: consent / authorization boundaries ============
    function testAcceptance12_AuthorizationBoundaries() public {
        // ---- non-seller cannot markDelivered; non-buyer cannot openDispute ----
        DealTerms memory d1 = _terms(P, 10_000);
        _fundAllowance(d1);
        vm.prank(buyer);
        vm.expectRevert(Expired.selector);
        hub.markDelivered(d1.dealId, keccak256("m"), bytes32(0), 0, new bytes(0));

        _deliverDirect(d1.dealId);
        vm.prank(seller);
        vm.expectRevert(Expired.selector);
        hub.openDispute(d1.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));

        // Legitimate buyer flow proceeds and settles (claimant-only S=0).
        uint64 opened1 = uint64(_now() + 100);
        vm.warp(opened1);
        _openDisputeDirect(d1.dealId);
        uint64 esc1 = _escalateAt(d1.dealId, opened1);
        _advanceToPrimary(esc1, d1.dealId);
        _queueWithPks(d1.dealId, 0, keccak256("A12-d1"), 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(d1.dealId);

        // ---- outsider cannot manufacture a ruling (non-panel signatures) ----
        (DealTerms memory d2, , uint64 esc2) = _disputedEscalated(10_000);
        _advanceToPrimary(esc2, d2.dealId);
        uint256[] memory outsiderPks = new uint256[](2);
        outsiderPks[0] = 0xDEAD;
        outsiderPks[1] = 0xBEEF;
        (RulingAuth memory bogus,) =
            _prepQueue(d2.dealId, 0, keccak256("A12-bogus"), 0, 0, 0, bytes32("evi"), 1, outsiderPks, 2);
        vm.prank(stranger);
        vm.expectRevert(NoQuorum.selector);
        _sendQueue(d2.dealId, bogus);

        _queueWithPks(d2.dealId, 0, keccak256("A12-d2"), 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(d2.dealId);

        // ---- duplicate rulingNonce across deals is globally rejected ----
        (DealTerms memory d3, , uint64 esc3) = _disputedEscalated(10_000);
        (DealTerms memory d4, , uint64 esc4) = _disputedEscalated(10_000);
        _advanceToPrimary(esc3, d3.dealId);
        _advanceToPrimary(esc4, d4.dealId);

        bytes32 shared = keccak256("A12-shared");
        _queueWithPks(d3.dealId, 0, shared, 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        (RulingAuth memory dup,) =
            _prepQueue(d4.dealId, 0, shared, 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.expectRevert(BadNonce.selector);
        _sendQueue(d4.dealId, dup);

        _queueWithPks(d4.dealId, 0, keccak256("A12-fresh"), 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        assertTrue(hub.isRulingNonceUsed(shared), "shared nonce consumed once");

        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(d3.dealId);
        hub.executeRuling(d4.dealId);

        // All four deals are buyer-win claimant-only: buyer fully refunded.
        assertEq(_claimsSum(d1.dealId), FUNDED + BOND, "A12 d1 conservation");
        assertEq(_claimsSum(d2.dealId), FUNDED + BOND, "A12 d2 conservation");
        assertEq(_claimsSum(d3.dealId), FUNDED + BOND, "A12 d3 conservation");
        assertEq(_claimsSum(d4.dealId), FUNDED + BOND, "A12 d4 conservation");
        _assertSolvent();

        _drain(d1.dealId);
        _drain(d2.dealId);
        _drain(d3.dealId);
        _drain(d4.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer whole across all boundary deals");
        assertEq(usdc.balanceOf(seller), 1_000_000_000);
        assertEq(usdc.balanceOf(arbRecipient), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }
}
