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
    BadTerms,
    NoQuorum,
    DisputeExhausted
} from "../../src/DealTypes.sol";

/// @notice Phase 9 reviewer-operations rehearsal: staff completes every supported
/// arbitration outcome on a local EVM (time travel via vm.warp; production
/// constants untouched) within the signed rules (P-05..P-08).
/// Self-contained: helper patterns are copied from the Journey suite; only the
/// shared mocks are imported. Nothing is imported from other test files.
contract ArbitrationTest is Test {
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

    /// @dev Fresh timestamp via the cheatcode. Direct `block.timestamp` reads
    /// after `vm.warp` can be CSE'd by the via-IR optimizer (TIMESTAMP is
    /// assumed block-stable), silently reusing a pre-warp value. Reading
    /// through an external cheatcode call defeats that assumption.
    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
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

    function _fundAllowance(DealTerms memory t) internal returns (bytes32 digest) {
        digest = hub.agreementDigestOf(t);
        uint256 amount = _fundedAmount(t);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        bytes32 salt = keccak256(abi.encode("pay", t.dealId));
        bytes32 inonce = keccak256(abi.encode("intent", t.dealId));
        uint64 exp = uint64(_now() + 1 days);
        bytes32 idigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, amount, salt, inonce, exp))
        );
        AllowanceIntent memory intent =
            AllowanceIntent({paymentSalt: salt, nonce: inonce, expiresAt: exp, signature: _sig(buyerPk, idigest)});
        Payment3009 memory nopay;
        hub.fund(t, _sig(buyerPk, digest), _sig(sellerPk, digest), nopay, intent, _admission(digest, t.dealId), _ready(t, digest));
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
        hub.submitEvidenceCommitment(
            dealId, uploader, seq, prev, files, keccak256("meta"), bytes32(0), 0, new bytes(0)
        );
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
                    MidmanDK.RULING_TYPEHASH, dealId, termsHash, arbPolicy, origin, rnonce, award, buyerCost, sellerCost, evi, epoch, expiry
                )
            )
        );
    }

    /// @notice Queue a ruling signed by an explicit in-memory key set at an explicit epoch.
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

    /// @notice Build the ruling authorization + digest WITHOUT calling the hub's
    /// state-changing queue function. Split out because `vm.expectRevert`
    /// applies to the next external call: any prior `hub.getDeal`/digest view
    /// call inside a combined helper would silently consume the expectation.
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

    /// @notice Single external queue call: safe to place directly after `vm.expectRevert`.
    function _sendQueue(bytes32 dealId, RulingAuth memory r) internal {
        if (r.origin == 0) hub.queuePrimaryRuling(dealId, r);
        else hub.queueFallbackRuling(dealId, r);
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
            bytes32 vdigest = hub.actionDigest(
                keccak256(abi.encode(MidmanDK.VETO_TYPEHASH, dealId, rdigest, authority, vnonce, expiry))
            );
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
        assertEq(usdc.balanceOf(address(hub)), hub.totalLiabilities(), "hub solvent");
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

    // ================= R1: full primary path, both bonds + both evidence =================
    function test_R1_FullPrimaryBothBonds() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        uint256 g = gasleft();
        _respondentBond(t.dealId);
        _gas("R1_respondentBond", g);

        g = gasleft();
        bytes32 head1 = _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        bytes32 head2 = _submitEvidence(t.dealId, seller, 1, head1);
        _gas("R1_evidence_both", g);
        assertEq(hub.getDeal(t.dealId).manifestCount, 2, "both commitments chained");

        _advanceToPrimary(escAt, t.dealId);

        // S=70M partial: E=floor(500k*70/100)=350k, buyerFee=350k;
        // Cb=floor(5M*70/100)=3.5M, Cs=floor(5M*30/100)=1.5M.
        g = gasleft();
        _queueWithPks(t.dealId, 0, keccak256("R1"), 70_000_000, 3_500_000, 1_500_000, head2, 1, _toMem(primaryPks), 2);
        _gas("R1_queuePrimary", g);

        vm.warp(_now() + 24 hours + 1);
        g = gasleft();
        hub.executeRuling(t.dealId);
        _gas("R1_execute", g);

        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, 30_150_000);
        _assertClaim(t.dealId, 1, seller, 70_000_000);
        _assertClaim(t.dealId, 2, feeRecipient, 350_000); // exact earned fee
        _assertClaim(t.dealId, 3, buyer, 1_500_000);
        _assertClaim(t.dealId, 4, seller, 3_500_000);
        _assertClaim(t.dealId, 5, arbRecipient, 5_000_000); // exact arb cost Cb+Cs
        assertEq(_claimsSum(t.dealId), inflow, "R1 conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 926_150_000);
        assertEq(usdc.balanceOf(seller), 1_068_500_000);
        assertEq(usdc.balanceOf(feeRecipient), 350_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ============ R2: primary queue -> veto -> fallback queue, origin separation ============
    function test_R2_VetoToFallbackOriginSeparation() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        _advanceToPrimary(escAt, t.dealId);

        // Fallback-panel sigs are rejected for a PRIMARY origin (wrong panel).
        {
            uint64 expiry = uint64(_now() + 30 days);
            bytes32 termsHash = hub.getDeal(t.dealId).termsHash;
            bytes32 bad = _rulingDigest(t.dealId, termsHash, 0, keccak256("R2-bad"), P, 5_000_000, 0, bytes32("evi"), 1, expiry);
            vm.expectRevert(NoQuorum.selector);
            hub.queuePrimaryRuling(
                t.dealId,
                RulingAuth({
                    origin: 0,
                    rulingNonce: keccak256("R2-bad"),
                    sellerAward: P,
                    buyerCost: 5_000_000,
                    sellerCost: 0,
                    evidenceCommitment: bytes32("evi"),
                    authEpoch: 1,
                    queueExpiry: expiry,
                    signatures: _sigsMem(bad, _toMem(fallbackPks), 2)
                })
            );
        }

        uint256 g = gasleft();
        bytes32 rdigest = _queueWithPks(t.dealId, 0, keccak256("R2-primary"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        _gas("R2_queuePrimary", g);
        assertEq(_phase(t.dealId), 7, "ruling pending");

        // Veto 2-of-3 (cancel-only). Ops log (off-chain record): reason =
        // "primary award S=P inconsistent with delivery-record v3 (reviewer
        // runbook RB-7 section 2); cancel only, no replacement award proposed".
        g = gasleft();
        hub.vetoPrimaryRuling(t.dealId, rdigest, _vetoSigs(t.dealId, rdigest, 2, keccak256("R2-veto")));
        _gas("R2_vetoPrimary", g);
        assertEq(_phase(t.dealId), 6, "fallback review after veto");

        // Primary-panel sigs are rejected for a FALLBACK origin (wrong panel).
        {
            uint64 expiry = uint64(_now() + 30 days);
            bytes32 termsHash = hub.getDeal(t.dealId).termsHash;
            bytes32 bad = _rulingDigest(t.dealId, termsHash, 1, keccak256("R2-bad2"), 0, 0, 5_000_000, bytes32("evi"), 1, expiry);
            vm.expectRevert(NoQuorum.selector);
            hub.queueFallbackRuling(
                t.dealId,
                RulingAuth({
                    origin: 1,
                    rulingNonce: keccak256("R2-bad2"),
                    sellerAward: 0,
                    buyerCost: 0,
                    sellerCost: 5_000_000,
                    evidenceCommitment: bytes32("evi"),
                    authEpoch: 1,
                    queueExpiry: expiry,
                    signatures: _sigsMem(bad, _toMem(primaryPks), 2)
                })
            );
        }

        // Independent fallback sigs queue the fallback ruling: S=0 buyer win.
        g = gasleft();
        _queueWithPks(t.dealId, 1, keccak256("R2-fallback"), 0, 0, 5_000_000, bytes32("evi"), 1, _toMem(fallbackPks), 2);
        _gas("R2_queueFallback", g);

        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(t.dealId);

        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, P + FEE);
        _assertClaim(t.dealId, 1, address(0), 0);
        _assertClaim(t.dealId, 2, address(0), 0);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 4, address(0), 0);
        _assertClaim(t.dealId, 5, arbRecipient, BOND);
        assertEq(_claimsSum(t.dealId), inflow, "R2 conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
        assertEq(usdc.balanceOf(seller), 995_000_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ============ R3a: rotation after evidence invalidates the old epoch ============
    function test_R3a_RotationInvalidatesOldEpoch() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _submitEvidence(t.dealId, buyer, 0, bytes32(0));
        _advanceToPrimary(escAt, t.dealId);

        // Rotate panels via the 72h timelock AFTER evidence but BEFORE queue.
        uint256[] memory npk = new uint256[](5);
        uint256[] memory nfk = new uint256[](5);
        address[] memory np = new address[](5);
        address[] memory nf = new address[](5);
        address[] memory nv = new address[](3);
        for (uint256 i = 0; i < 5; i++) {
            npk[i] = 0xB001 + i;
            nfk[i] = 0xC001 + i;
            np[i] = vm.addr(npk[i]);
            nf[i] = vm.addr(nfk[i]);
        }
        for (uint256 i = 0; i < 3; i++) nv[i] = vm.addr(vetoPks[i]);
        uint256 g = gasleft();
        vm.prank(governance);
        policies.proposePanel(np, nf, nv);
        vm.warp(_now() + 72 hours + 1);
        vm.prank(governance);
        policies.executePanel();
        _gas("R3a_rotate", g);
        assertEq(policies.authEpoch(), 2, "epoch 2");

        // Old-epoch queue reverts (BadTerms: epoch currency check).
        (RulingAuth memory rOld,) =
            _prepQueue(t.dealId, 0, keccak256("R3a-old"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.expectRevert(BadTerms.selector);
        _sendQueue(t.dealId, rOld);

        // New-epoch queue with the rotated panel succeeds: S=P full seller win.
        g = gasleft();
        _queueWithPks(t.dealId, 0, keccak256("R3a-new"), P, 5_000_000, 0, bytes32("evi"), 2, npk, 2);
        _gas("R3a_queueNewEpoch", g);

        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(t.dealId);

        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 1, seller, P);
        _assertClaim(t.dealId, 2, feeRecipient, FEE);
        _assertClaim(t.dealId, 3, address(0), 0);
        _assertClaim(t.dealId, 4, seller, BOND);
        _assertClaim(t.dealId, 5, arbRecipient, BOND);
        assertEq(_claimsSum(t.dealId), inflow, "R3a conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(seller), 1_100_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 500_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ============ R3b: queued ruling survives rotation; old epoch dead for new queues ============
    function test_R3b_QueuedSurvivesRotation() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _advanceToPrimary(escAt, t.dealId);

        // Queue BEFORE rotation at epoch 1: S=P.
        _queueWithPks(t.dealId, 0, keccak256("R3b-early"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        uint64 execAt = hub.getDeal(t.dealId).rulingExecuteAt;

        // Rotate during the execution delay.
        address[] memory np = new address[](5);
        address[] memory nf = new address[](5);
        address[] memory nv = new address[](3);
        for (uint256 i = 0; i < 5; i++) {
            np[i] = vm.addr(0xD001 + i);
            nf[i] = vm.addr(0xE001 + i);
        }
        for (uint256 i = 0; i < 3; i++) nv[i] = vm.addr(vetoPks[i]);
        vm.prank(governance);
        policies.proposePanel(np, nf, nv);
        vm.warp(_now() + 72 hours + 1);
        vm.prank(governance);
        policies.executePanel();
        assertEq(policies.authEpoch(), 2, "epoch 2");
        assertGe(_now(), execAt, "delay elapsed across rotation");

        // Pending ruling survives: executes without epoch recheck (P-07).
        uint256 g = gasleft();
        hub.executeRuling(t.dealId);
        _gas("R3b_executeAfterRotation", g);
        _assertClaim(t.dealId, 1, seller, P);

        // A second queue attempt with the old epoch reverts: fresh deal, epoch 1 sigs.
        (DealTerms memory u, uint64 openedU,) = _disputedEscalated(10_000);
        _respondentBond(u.dealId);
        uint64 escU = hub.getDeal(u.dealId).escalatedAt;
        _advanceToPrimary(escU, u.dealId);
        (RulingAuth memory rOldU,) =
            _prepQueue(u.dealId, 0, keccak256("R3b-old"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.expectRevert(BadTerms.selector);
        _sendQueue(u.dealId, rOldU);
        openedU;

        uint256 inflowT = (P + FEE) + 2 * BOND;
        assertEq(_claimsSum(t.dealId), inflowT, "R3b conservation (deal 1)");
        _drain(t.dealId);
        _drain(u.dealId); // nothing claimable yet; deal 2 still in review
        assertEq(hub.getDeal(u.dealId).phase, 5, "deal 2 still in primary review");
        _assertSolvent();
    }

    // ================= R4: veto bounds + fallback veto into DEADLOCK =================
    function test_R4_VetoBounds() public {
        // ---- Deal V1: primary veto timing bounds ----
        (DealTerms memory v, , uint64 escV) = _disputedEscalated(10_000);
        _advanceToPrimary(escV, v.dealId);
        bytes32 rv = _queueWithPks(v.dealId, 0, keccak256("R4-v1"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        uint64 execV = hub.getDeal(v.dealId).rulingExecuteAt;

        // Veto with 1-of-3 reverts (below 2-of-3 quorum).
        VetoSig[] memory one = _vetoSigs(v.dealId, rv, 1, keccak256("R4-1of3"));
        vm.expectRevert(NoQuorum.selector);
        hub.vetoPrimaryRuling(v.dealId, rv, one);

        // Veto after executeAt reverts.
        VetoSig[] memory two = _vetoSigs(v.dealId, rv, 2, keccak256("R4-2of3"));
        vm.warp(execV + 1);
        vm.expectRevert(BadPhase.selector);
        hub.vetoPrimaryRuling(v.dealId, rv, two);

        // Execute, then veto of the already-executed ruling reverts.
        hub.executeRuling(v.dealId);
        vm.expectRevert(BadPhase.selector);
        hub.vetoPrimaryRuling(v.dealId, rv, two);

        // ---- Deal V2: fallback veto past fallback end lands in DEADLOCK ----
        (DealTerms memory w, uint64 openedW, uint64 escW) = _disputedEscalated(10_000);
        _respondentBond(w.dealId);
        _advanceToPrimary(escW, w.dealId);
        uint64 primaryEnd = escW + 86_400 + 7 days;
        vm.warp(primaryEnd + 1);
        hub.activateFallback(w.dealId);
        uint64 fbStart = hub.getDeal(w.dealId).fallbackStartedAt;
        assertEq(_phase(w.dealId), 6, "fallback review");

        // Queue 12h before fallback end; executeAt lands 12h past fallback end.
        vm.warp(fbStart + 7 days - 12 hours);
        bytes32 rw = _queueWithPks(w.dealId, 1, keccak256("R4-v2"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(fallbackPks), 2);
        uint64 execW = hub.getDeal(w.dealId).rulingExecuteAt;

        // Veto after fallback end but before executeAt: DEADLOCK, not fallback review.
        vm.warp(fbStart + 7 days + 1);
        assertLt(_now(), execW, "veto still inside execution window");
        VetoSig[] memory twoFb = _vetoSigs(w.dealId, rw, 2, keccak256("R4-fb"));
        hub.vetoFallbackRuling(w.dealId, rw, twoFb);
        assertEq(_phase(w.dealId), 8, "DEADLOCK after late fallback veto");

        // Escape path still available from DEADLOCK.
        uint256 g = gasleft();
        vm.warp(openedW + 5_184_000 + 1);
        hub.catastrophicEscape(w.dealId);
        _gas("R4_escapeFromDeadlock", g);
        assertEq(_phase(w.dealId), 9, "settled via escape");

        uint256 inflowV = (P + FEE) + BOND; // V1: claimant bond only
        assertEq(_claimsSum(v.dealId), inflowV, "R4 conservation (V1)");
        uint256 inflowW = (P + FEE) + 2 * BOND;
        _assertClaim(w.dealId, 0, buyer, P / 2 + FEE);
        _assertClaim(w.dealId, 1, seller, P / 2);
        _assertClaim(w.dealId, 3, buyer, BOND);
        _assertClaim(w.dealId, 4, seller, BOND);
        assertEq(_claimsSum(w.dealId), inflowW, "R4 conservation (V2)");

        _drain(v.dealId);
        _drain(w.dealId);
        assertEq(usdc.balanceOf(buyer), 844_500_000);
        assertEq(usdc.balanceOf(seller), 1_150_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 500_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= R5: ruling-nonce globality across deals =================
    function test_R5_RulingNonceGlobal() public {
        (DealTerms memory a, , uint64 escA) = _disputedEscalated(10_000);
        (DealTerms memory b, , uint64 escB) = _disputedEscalated(10_000);
        _advanceToPrimary(escA, a.dealId);
        _advanceToPrimary(escB, b.dealId);

        // Identical rulingNonce on deal A succeeds (S=70M partial, claimant-only bond).
        _queueWithPks(a.dealId, 0, keccak256("R5-shared"), 70_000_000, 3_500_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);

        // Same rulingNonce on deal B reverts: replay across deals impossible.
        (RulingAuth memory rB,) =
            _prepQueue(b.dealId, 0, keccak256("R5-shared"), 70_000_000, 3_500_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.expectRevert(BadNonce.selector);
        _sendQueue(b.dealId, rB);

        // Fresh nonce on deal B succeeds (proves the revert was nonce-only).
        _queueWithPks(b.dealId, 0, keccak256("R5-fresh"), 70_000_000, 3_500_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);

        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(a.dealId);
        hub.executeRuling(b.dealId);

        uint256 inflowEach = (P + FEE) + BOND;
        assertEq(_claimsSum(a.dealId), inflowEach, "R5 conservation (A)");
        assertEq(_claimsSum(b.dealId), inflowEach, "R5 conservation (B)");
        assertEq(hub.isRulingNonceUsed(keccak256("R5-shared")), true);

        _drain(a.dealId);
        _drain(b.dealId);
        assertEq(usdc.balanceOf(buyer), 852_300_000);
        assertEq(usdc.balanceOf(seller), 1_140_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 700_000);
        assertEq(usdc.balanceOf(arbRecipient), 7_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= R6: missing respondent subsidy path (S=0 buyer win) =================
    function test_R6_MissingRespondentSubsidy() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        // No respondent bond, no evidence from the seller; review proceeds regardless.
        _advanceToPrimary(escAt, t.dealId);

        // S=0: E=0, Cb=0, Cs=0 — zero arb revenue, claimant refunded in full.
        _queueWithPks(t.dealId, 0, keccak256("R6"), 0, 0, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(t.dealId);

        uint256 inflow = (P + FEE) + BOND;
        _assertClaim(t.dealId, 0, buyer, P + FEE);
        _assertClaim(t.dealId, 1, address(0), 0);
        _assertClaim(t.dealId, 2, address(0), 0); // fee zero on full buyer win
        _assertClaim(t.dealId, 3, buyer, BOND); // claimant refunded whole bond
        _assertClaim(t.dealId, 4, address(0), 0);
        _assertClaim(t.dealId, 5, address(0), 0); // zero arb revenue: subsidy path
        assertEq(_claimsSum(t.dealId), inflow, "R6 conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer made whole");
        assertEq(usdc.balanceOf(seller), 1_000_000_000, "seller untouched");
        assertEq(usdc.balanceOf(arbRecipient), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= R7: missing escalation lapses; timeout settles seller =================
    function test_R7_MissingEscalationLapse() public {
        DealTerms memory t = _terms(P, 10_000);
        _fundAllowance(t);
        _deliverDirect(t.dealId);
        uint64 deliveredAt = hub.getDeal(t.dealId).deliveredAt;
        uint64 openedAt = uint64(_now() + 100);
        vm.warp(openedAt);
        _openDisputeDirect(t.dealId);

        // Dispute opened but never escalated: lapse after the escalation window.
        // UX hook: the buyer was warned — frontend must surface the 24h+24h
        // escalation countdown and the one-shot dispute exhaustion warning
        // (P-15 product responsibility) before this point of no return.
        vm.warp(openedAt + 2 * 86_400 + 1);
        hub.lapseDispute(t.dealId);
        assertEq(_phase(t.dealId), 1, "back to delivered");

        // Second openDispute reverts: the single dispute right is exhausted.
        vm.prank(buyer);
        vm.expectRevert(DisputeExhausted.selector);
        hub.openDispute(t.dealId, 1, bytes32(0), bytes32(0), 0, new bytes(0));

        // Original inspection anchor preserved: timeout settles the seller.
        assertGe(_now(), deliveredAt + 3_600, "inspection elapsed");
        hub.finalizeAfterTimeout(t.dealId);

        uint256 inflow = P + FEE; // no bonds ever posted
        _assertClaim(t.dealId, 1, seller, P);
        _assertClaim(t.dealId, 2, feeRecipient, FEE);
        assertEq(_claimsSum(t.dealId), inflow, "R7 conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 899_500_000);
        assertEq(usdc.balanceOf(seller), 1_100_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 500_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= R8: late respondent bond rejected; claimant-only review =================
    function test_R8_LateRespondentBond() public {
        (DealTerms memory t, , uint64 escAt) = _disputedEscalated(10_000);
        bytes32 evi = _submitEvidence(t.dealId, buyer, 0, bytes32(0));

        // Post-respondent-bond AFTER the evidence cutoff reverts.
        vm.warp(escAt + 86_400 + 1);
        vm.prank(seller);
        usdc.approve(address(hub), BOND);
        vm.prank(seller);
        vm.expectRevert(BadPhase.selector);
        hub.postRespondentBond(t.dealId, BOND, false, bytes32(0), bytes32(0), 0, new bytes(0), _noReserve());

        // Review proceeds on claimant evidence alone (already materialized primary).
        hub.advanceToPrimary(t.dealId);
        assertEq(_phase(t.dealId), 5, "primary review");

        // S=0 on claimant evidence alone succeeds.
        _queueWithPks(t.dealId, 0, keccak256("R8"), 0, 0, 0, evi, 1, _toMem(primaryPks), 2);
        vm.warp(_now() + 24 hours + 1);
        hub.executeRuling(t.dealId);

        uint256 inflow = (P + FEE) + BOND;
        _assertClaim(t.dealId, 0, buyer, P + FEE);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 5, address(0), 0);
        assertEq(_claimsSum(t.dealId), inflow, "R8 conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000);
        assertEq(usdc.balanceOf(seller), 1_000_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= R9: deadlock with no ruling, then catastrophic escape =================
    function test_R9_DeadlockThenEscape() public {
        (DealTerms memory t, uint64 openedAt, uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _advanceToPrimary(escAt, t.dealId);

        // Force fallback expiry with no ruling queued at any point.
        uint64 primaryEnd = escAt + 86_400 + 7 days;
        vm.warp(primaryEnd + 1);
        hub.activateFallback(t.dealId);
        uint64 fbStart = hub.getDeal(t.dealId).fallbackStartedAt;
        vm.warp(fbStart + 7 days + 1);
        uint256 g = gasleft();
        hub.markDeadlock(t.dealId);
        _gas("R9_markDeadlock", g);
        assertEq(_phase(t.dealId), 8, "DEADLOCK");

        // Warp to escape and take the catastrophic path.
        g = gasleft();
        vm.warp(openedAt + 5_184_000 + 1);
        hub.catastrophicEscape(t.dealId);
        _gas("R9_escape", g);

        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, P / 2 + FEE);
        _assertClaim(t.dealId, 1, seller, P / 2);
        _assertClaim(t.dealId, 2, address(0), 0);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 4, seller, BOND);
        _assertClaim(t.dealId, 5, address(0), 0);
        assertEq(_claimsSum(t.dealId), inflow, "R9 conservation");

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 950_000_000);
        assertEq(usdc.balanceOf(seller), 1_050_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= X1: queue at escape-1s with 24h delay reverts =================
    function test_X1_QueueAtEscapeMinusOneReverts() public {
        (DealTerms memory t, uint64 openedAt, uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _advanceToPrimary(escAt, t.dealId);
        uint64 escapeAt = hub.escapeAt(t.dealId);
        assertEq(escapeAt, openedAt + 5_184_000, "fixed escape");

        // 1s before escape with the 24h tier-1 delay: executeAt would land past escape.
        vm.warp(escapeAt - 1);
        assertGe(_now() + 24 hours, escapeAt, "executeAt >= escapeAt");
        uint64 expiry = uint64(_now() + 30 days);
        bytes32 termsHash = hub.getDeal(t.dealId).termsHash;
        bytes32 rp = _rulingDigest(t.dealId, termsHash, 0, keccak256("X1p"), P, 5_000_000, 0, bytes32("evi"), 1, expiry);
        vm.expectRevert(BadPhase.selector);
        hub.queuePrimaryRuling(
            t.dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: keccak256("X1p"),
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: expiry,
                signatures: _sigsMem(rp, _toMem(primaryPks), 2)
            })
        );
        bytes32 rf = _rulingDigest(t.dealId, termsHash, 1, keccak256("X1f"), P, 5_000_000, 0, bytes32("evi"), 1, expiry);
        vm.expectRevert(BadPhase.selector);
        hub.queueFallbackRuling(
            t.dealId,
            RulingAuth({
                origin: 1,
                rulingNonce: keccak256("X1f"),
                sellerAward: P,
                buyerCost: 5_000_000,
                sellerCost: 0,
                evidenceCommitment: bytes32("evi"),
                authEpoch: 1,
                queueExpiry: expiry,
                signatures: _sigsMem(rf, _toMem(fallbackPks), 2)
            })
        );
        // No ruling was queued at escape-1 (both reverted; normalization side
        // effects roll back with the revert). Reaching the cutoff settles via
        // the fixed escape path independent of any keeper.
        vm.warp(escapeAt);
        hub.catastrophicEscape(t.dealId);
        assertEq(_phase(t.dealId), 9, "settled via fixed escape");
        assertEq(hub.getDeal(t.dealId).rulingQueued, false, "no ruling queued");
        _assertSolvent();
    }

    // ================= X2: voluntary release after escapeAt, before escape, settles =================
    function test_X2_VoluntaryReleaseAfterEscapeSettles() public {
        (DealTerms memory t, uint64 openedAt,) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        uint64 escapeAt = hub.escapeAt(t.dealId);

        // After escapeAt but before T23 executes, T05 remains available (P-08).
        vm.warp(escapeAt + 1);
        vm.prank(buyer);
        hub.approveSeller(t.dealId, bytes32("termv1"), bytes32(0), 0, new bytes(0));
        assertEq(_phase(t.dealId), 9, "settled via voluntary release");

        // Full seller economics with both bonds refunded (Cb=Cs=0): no bond griefing.
        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, address(0), 0);
        _assertClaim(t.dealId, 1, seller, P);
        _assertClaim(t.dealId, 2, feeRecipient, FEE);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 4, seller, BOND);
        _assertClaim(t.dealId, 5, address(0), 0);
        assertEq(_claimsSum(t.dealId), inflow, "X2 conservation");

        // Voluntary settlement preempts T23: escape of a settled deal reverts.
        vm.expectRevert(BadPhase.selector);
        hub.catastrophicEscape(t.dealId);
        openedAt;

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 899_500_000);
        assertEq(usdc.balanceOf(seller), 1_100_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 500_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }

    // ================= X3: ruling execution AT escapeAt reverts; T23 bypasses =================
    function test_X3_ExecuteAtEscapeRevertsThenEscape() public {
        (DealTerms memory t, uint64 openedAt, uint64 escAt) = _disputedEscalated(10_000);
        _respondentBond(t.dealId);
        _advanceToPrimary(escAt, t.dealId);
        _queueWithPks(t.dealId, 0, keccak256("X3"), P, 5_000_000, 0, bytes32("evi"), 1, _toMem(primaryPks), 2);
        uint64 escapeAt = hub.escapeAt(t.dealId);

        // Execution AT escapeAt reverts (executeAt window is now < escapeAt).
        vm.warp(escapeAt);
        vm.expectRevert(BadPhase.selector);
        hub.executeRuling(t.dealId);

        // T23 bypasses the pending award (P-08 precedence).
        hub.catastrophicEscape(t.dealId);
        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, P / 2 + FEE);
        _assertClaim(t.dealId, 1, seller, P / 2);
        _assertClaim(t.dealId, 3, buyer, BOND);
        _assertClaim(t.dealId, 4, seller, BOND);
        assertEq(_claimsSum(t.dealId), inflow, "X3 conservation");
        openedAt;

        _drain(t.dealId);
        assertEq(usdc.balanceOf(buyer), 950_000_000);
        assertEq(usdc.balanceOf(seller), 1_050_000_000);
        assertEq(hub.totalLiabilities(), 0);
        _assertSolvent();
    }
}
