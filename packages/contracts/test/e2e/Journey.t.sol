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
    ReserveAuth,
    BadNonce
} from "../../src/DealTypes.sol";

/// @notice Phase 7 end-to-end acceptance: happy path, disputed paths,
/// recovery/direct fallbacks, and settlement-nonce discipline, each on a
/// fresh deal with exact integer ledger vectors and conservation checks.
/// Self-contained: helper patterns are copied from the unit suite; only the
/// shared mocks are imported.
contract JourneyTest is Test {
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
        t.fundingDeadline = uint64(block.timestamp + 7 days);
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
        uint64 exp = uint64(block.timestamp + 1 days);
        bytes32 adigest =
            hub.actionDigest(keccak256(abi.encode(MidmanDK.ADMISSION_TYPEHASH, digest, categoryPolicy, anonce, exp, true)));
        adm = Admission({minPolicyId: categoryPolicy, admissionNonce: anonce, expiresAt: exp, signature: _sig(admissionPk, adigest)});
    }

    function _ready(DealTerms memory t, bytes32 digest) internal view returns (ReadinessAuth memory r) {
        uint64 attestedAt = uint64(block.timestamp);
        uint64 expiresAt = uint64(block.timestamp + 2 hours);
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

    /// @notice Allowance-path funding (direct buyer approve).
    function _fundAllowance(DealTerms memory t) internal returns (bytes32 digest) {
        digest = hub.agreementDigestOf(t);
        uint256 amount = _fundedAmount(t);
        vm.prank(buyer);
        usdc.approve(address(hub), amount);
        bytes32 salt = keccak256(abi.encode("pay", t.dealId));
        bytes32 inonce = keccak256(abi.encode("intent", t.dealId));
        uint64 exp = uint64(block.timestamp + 1 days);
        bytes32 idigest = hub.actionDigest(
            keccak256(abi.encode(MidmanDK.ALLOWANCE_TYPEHASH, t.dealId, digest, buyer, amount, salt, inonce, exp))
        );
        AllowanceIntent memory intent =
            AllowanceIntent({paymentSalt: salt, nonce: inonce, expiresAt: exp, signature: _sig(buyerPk, idigest)});
        Payment3009 memory nopay;
        hub.fund(t, _sig(buyerPk, digest), _sig(sellerPk, digest), nopay, intent, _admission(digest, t.dealId), _ready(t, digest));
    }

    /// @notice 3009-path funding; `submitter` may be the buyer or a relayer.
    function _fund3009(DealTerms memory t, address submitter) internal returns (bytes32 digest) {
        digest = hub.agreementDigestOf(t);
        uint256 amount = _fundedAmount(t);
        bytes32 salt = keccak256(abi.encode("pay", t.dealId));
        bytes32 tokenNonce = keccak256(abi.encode(t.dealId, digest, salt));
        uint64 vAfter = uint64(block.timestamp - 1);
        uint64 before = uint64(block.timestamp + 1 days);
        bytes32 authDigest = usdc.authDigest(buyer, address(hub), amount, vAfter, before, tokenNonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, authDigest);
        Payment3009 memory pay =
            Payment3009({validAfter: vAfter, validBefore: before, paymentSalt: salt, v: v, r: r, s: s, use3009: true});
        AllowanceIntent memory empty;
        vm.prank(submitter);
        hub.fund(t, _sig(buyerPk, digest), _sig(sellerPk, digest), pay, empty, _admission(digest, t.dealId), _ready(t, digest));
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
        return uint64(block.timestamp);
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

    function _submitEvidence(bytes32 dealId, address uploader) internal returns (bytes32 commitment) {
        bytes32[] memory files = new bytes32[](1);
        files[0] = keccak256("file1");
        vm.prank(uploader);
        hub.submitEvidenceCommitment(
            dealId, uploader, 0, bytes32(0), files, keccak256("meta"), bytes32(0), 0, new bytes(0)
        );
        commitment = hub.getDeal(dealId).manifestHead;
    }

    function _rulingSigs(bytes32 digest, uint256[] storage pks, uint256 n) internal returns (bytes[] memory sigs) {
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) sigs[i] = _sig(pks[i], digest);
    }

    function _queuePrimary(
        bytes32 dealId,
        bytes32 termsHash,
        bytes32 rnonce,
        uint256 award,
        uint256 buyerCost,
        uint256 sellerCost,
        bytes32 evi
    ) internal returns (bytes32 rdigest) {
        uint64 expiry = uint64(block.timestamp + 30 days);
        rdigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.RULING_TYPEHASH, dealId, termsHash, arbPolicy, uint8(0), rnonce, award, buyerCost, sellerCost, evi, uint64(1), expiry
                )
            )
        );
        hub.queuePrimaryRuling(
            dealId,
            RulingAuth({
                origin: 0,
                rulingNonce: rnonce,
                sellerAward: award,
                buyerCost: buyerCost,
                sellerCost: sellerCost,
                evidenceCommitment: evi,
                authEpoch: 1,
                queueExpiry: expiry,
                signatures: _rulingSigs(rdigest, primaryPks, 2)
            })
        );
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

    function _gas(string memory label, uint256 g0) internal {
        emit log_named_uint(label, g0 - gasleft());
    }

    // ================= Journey A: happy path via 3009 =================
    function testJourneyA_HappyPath() public {
        DealTerms memory t = _terms(P, 10_000);
        uint256 funded = _fundedAmount(t);
        assertEq(funded, P + FEE);

        uint256 g = gasleft();
        _fund3009(t, buyer);
        _gas("A_fund_3009", g);

        assertEq(hub.totalLiabilities(), funded);
        assertEq(usdc.balanceOf(address(hub)), hub.totalLiabilities());

        g = gasleft();
        _deliverDirect(t.dealId);
        _gas("A_deliver", g);

        g = gasleft();
        vm.prank(buyer);
        hub.approveSeller(t.dealId, bytes32("termv1"), bytes32(0), 0, new bytes(0));
        _gas("A_release", g);

        // Exact ledger vector: S=P, no bonds. E=F, buyerFee=F.
        _assertClaim(t.dealId, 0, address(0), 0);
        _assertClaim(t.dealId, 1, seller, P);
        _assertClaim(t.dealId, 2, feeRecipient, FEE);
        _assertClaim(t.dealId, 3, address(0), 0);
        _assertClaim(t.dealId, 4, address(0), 0);
        _assertClaim(t.dealId, 5, address(0), 0);
        assertEq(_claimsSum(t.dealId), funded, "A conservation");

        g = gasleft();
        hub.claimFor(t.dealId, 1);
        _gas("A_claim_seller", g);
        g = gasleft();
        hub.claimFor(t.dealId, 2);
        _gas("A_claim_fee", g);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000 - funded);
        assertEq(usdc.balanceOf(seller), 1_000_000_000 + P);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ================= Journey B: full dispute, partial S=70% =================
    function testJourneyB_PartialRuling() public {
        DealTerms memory t = _terms(P, 10_000);
        uint256 g = gasleft();
        _fundAllowance(t);
        _gas("B_fund_allowance", g);
        _deliverDirect(t.dealId);

        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        g = gasleft();
        _openDisputeDirect(t.dealId);
        _gas("B_openDispute", g);

        g = gasleft();
        uint64 escAt = _escalateAt(t.dealId, openedAt);
        _gas("B_escalate", g);

        g = gasleft();
        _respondentBond(t.dealId);
        _gas("B_respondentBond", g);

        g = gasleft();
        bytes32 evi = _submitEvidence(t.dealId, buyer);
        _gas("B_evidence", g);

        vm.warp(escAt + 86_400 + 1);
        g = gasleft();
        hub.advanceToPrimary(t.dealId);
        _gas("B_advancePrimary", g);

        // S=70M: E=350k, buyerFee=350k; Cb=3.5M, Cs=1.5M.
        uint256 S = 70_000_000;
        g = gasleft();
        _queuePrimary(t.dealId, hub.agreementDigestOf(t), keccak256("ruling-B"), S, 3_500_000, 1_500_000, evi);
        _gas("B_queueRuling", g);

        vm.warp(block.timestamp + 24 hours + 1);
        g = gasleft();
        hub.executeRuling(t.dealId);
        _gas("B_execute", g);

        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, 30_150_000);
        _assertClaim(t.dealId, 1, seller, 70_000_000);
        _assertClaim(t.dealId, 2, feeRecipient, 350_000);
        _assertClaim(t.dealId, 3, buyer, 1_500_000);
        _assertClaim(t.dealId, 4, seller, 3_500_000);
        _assertClaim(t.dealId, 5, arbRecipient, 5_000_000);
        assertEq(_claimsSum(t.dealId), inflow, "B conservation");
        assertEq(hub.totalLiabilities(), inflow);

        for (uint8 k = 0; k < 6; k++) hub.claimFor(t.dealId, k);

        assertEq(usdc.balanceOf(buyer), 926_150_000);
        assertEq(usdc.balanceOf(seller), 1_068_500_000);
        assertEq(usdc.balanceOf(feeRecipient), 350_000);
        assertEq(usdc.balanceOf(arbRecipient), 5_000_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ============ Journey C: missing respondent + catastrophic ============
    function testJourneyC_BuyerWinAndEscape() public {
        // ---- Deal 1: buyer win S=0, no respondent bond ----
        DealTerms memory a = _terms(P, 10_000);
        _fundAllowance(a);
        _deliverDirect(a.dealId);
        uint64 openedA = uint64(block.timestamp + 100);
        vm.warp(openedA);
        _openDisputeDirect(a.dealId);
        uint64 escA = _escalateAt(a.dealId, openedA);
        vm.warp(escA + 86_400 + 1);
        hub.advanceToPrimary(a.dealId);
        // S=0: E=0; Cb=0 (claimant refunded whole), Cs=0; zero arb revenue.
        _queuePrimary(a.dealId, hub.agreementDigestOf(a), keccak256("ruling-C1"), 0, 0, 0, bytes32("evi"));
        vm.warp(block.timestamp + 24 hours + 1);
        hub.executeRuling(a.dealId);

        uint256 inflowA = (P + FEE) + BOND;
        _assertClaim(a.dealId, 0, buyer, P + FEE);
        _assertClaim(a.dealId, 1, address(0), 0);
        _assertClaim(a.dealId, 2, address(0), 0);
        _assertClaim(a.dealId, 3, buyer, BOND);
        _assertClaim(a.dealId, 4, address(0), 0);
        _assertClaim(a.dealId, 5, address(0), 0);
        assertEq(_claimsSum(a.dealId), inflowA, "C1 conservation");

        hub.claimFor(a.dealId, 0);
        hub.claimFor(a.dealId, 3);
        assertEq(usdc.balanceOf(arbRecipient), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);

        // ---- Deal 2 (fresh): catastrophic escape, 60-day warp ----
        DealTerms memory b = _terms(P, 10_000);
        _fundAllowance(b);
        _deliverDirect(b.dealId);
        uint64 openedB = uint64(block.timestamp + 100);
        vm.warp(openedB);
        _openDisputeDirect(b.dealId);
        _escalateAt(b.dealId, openedB);
        _respondentBond(b.dealId);

        uint256 g = gasleft();
        vm.warp(openedB + 5_184_000 + 1); // production 60-day constant untouched
        hub.catastrophicEscape(b.dealId);
        _gas("C_escape", g);

        uint256 inflowB = (P + FEE) + 2 * BOND;
        _assertClaim(b.dealId, 0, buyer, P / 2 + FEE);
        _assertClaim(b.dealId, 1, seller, P / 2);
        _assertClaim(b.dealId, 2, address(0), 0);
        _assertClaim(b.dealId, 3, buyer, BOND);
        _assertClaim(b.dealId, 4, seller, BOND);
        _assertClaim(b.dealId, 5, address(0), 0);
        assertEq(_claimsSum(b.dealId), inflowB, "C2 conservation");

        hub.claimFor(b.dealId, 0);
        hub.claimFor(b.dealId, 1);
        hub.claimFor(b.dealId, 3);
        hub.claimFor(b.dealId, 4);

        assertEq(usdc.balanceOf(buyer), 950_000_000);
        assertEq(usdc.balanceOf(seller), 1_050_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ============ Journey D: relayer calldata + direct recovery ============
    function testJourneyD_RelayerEquivalence() public {
        DealTerms memory t = _terms(P, 10_000);
        uint256 funded = _fundedAmount(t);

        // Funding itself is permissionless: relayer submits buyer/seller-signed terms + 3009 auth.
        uint256 g = gasleft();
        _fund3009(t, relayer);
        _gas("D_fund_relayer_3009", g);
        bytes32 termsHash = hub.agreementDigestOf(t);

        // Seller-signed delivery submitted by the relayer.
        bytes32 manifest = keccak256("delivery-manifest");
        bytes32 dnonce = keccak256("D-deliver");
        uint64 dexp = uint64(block.timestamp + 1 days);
        bytes32 dstruct =
            keccak256(abi.encode(MidmanDK.DELIVER_TYPEHASH, t.dealId, termsHash, seller, manifest, dnonce, dexp));
        g = gasleft();
        vm.prank(relayer);
        hub.markDelivered(t.dealId, manifest, dnonce, dexp, _sig(sellerPk, hub.actionDigest(dstruct)));
        _gas("D_deliver_relayer", g);

        // Buyer-signed release submitted by the relayer: same end state, no relayer trust.
        bytes32 apolicy = bytes32("termv1");
        bytes32 anon = keccak256("D-approve");
        uint64 aexp = uint64(block.timestamp + 1 days);
        bytes32 astruct =
            keccak256(abi.encode(MidmanDK.APPROVE_TYPEHASH, t.dealId, termsHash, buyer, apolicy, anon, aexp));
        g = gasleft();
        vm.prank(relayer);
        hub.approveSeller(t.dealId, apolicy, anon, aexp, _sig(buyerPk, hub.actionDigest(astruct)));
        _gas("D_release_relayer", g);

        _assertClaim(t.dealId, 1, seller, P);
        _assertClaim(t.dealId, 2, feeRecipient, FEE);
        assertEq(_claimsSum(t.dealId), funded, "D conservation");

        // Permissionless recovery: anyone triggers the fixed-recipient payout;
        // recipient pulls their own directly (emergency-style, no relayer needed).
        g = gasleft();
        vm.prank(relayer);
        hub.claimFor(t.dealId, 1);
        _gas("D_claim_via_relayer", g);
        g = gasleft();
        vm.prank(feeRecipient);
        hub.claimFor(t.dealId, 2);
        _gas("D_claim_direct", g);

        assertEq(usdc.balanceOf(seller), 1_000_000_000 + P);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000 - funded);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    // ===== Journey E: mutual settlement mid-dispute + nonce discipline =====
    function testJourneyE_MutualMidDispute() public {
        DealTerms memory t = _terms(P, 10_000);
        _fundAllowance(t);
        _deliverDirect(t.dealId);
        uint64 openedAt = uint64(block.timestamp + 100);
        vm.warp(openedAt);
        _openDisputeDirect(t.dealId);
        _escalateAt(t.dealId, openedAt); // settlementNonce 0 -> 1

        // Stale offer crafted at nonce 1 (before respondent bond posts).
        // Note: deliver/dispute/escalate each retire the offer epoch already.
        uint256 S = 40_000_000;
        uint256 buyerCost = 1_000_000;
        uint256 sellerCost = 2_000_000;
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 termsHash = hub.agreementDigestOf(t);
        bytes32 staleDigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.SETTLE_TYPEHASH,
                    t.dealId,
                    termsHash,
                    S,
                    buyerCost,
                    sellerCost,
                    MidmanDK.PH_EVIDENCE,
                    bytes32(uint256(1)),
                    expiry
                )
            )
        );
        bytes memory staleB = _sig(buyerPk, staleDigest);
        bytes memory staleS = _sig(sellerPk, staleDigest);

        _respondentBond(t.dealId); // new collateral retires the stale offer epoch.

        vm.expectRevert(BadNonce.selector);
        hub.mutualSettlement(
            t.dealId, S, buyerCost, sellerCost, MidmanDK.PH_EVIDENCE, bytes32(uint256(1)), expiry, staleB, staleS
        );

        // Fresh offer at the live nonce settles: E=200k, buyerFee=200k.
        bytes32 liveNonce = bytes32(hub.getDeal(t.dealId).settlementNonce);
        bytes32 freshDigest = hub.actionDigest(
            keccak256(
                abi.encode(
                    MidmanDK.SETTLE_TYPEHASH,
                    t.dealId,
                    termsHash,
                    S,
                    buyerCost,
                    sellerCost,
                    MidmanDK.PH_EVIDENCE,
                    liveNonce,
                    expiry
                )
            )
        );
        uint256 g = gasleft();
        hub.mutualSettlement(
            t.dealId,
            S,
            buyerCost,
            sellerCost,
            MidmanDK.PH_EVIDENCE,
            liveNonce,
            expiry,
            _sig(buyerPk, freshDigest),
            _sig(sellerPk, freshDigest)
        );
        _gas("E_mutual", g);

        uint256 inflow = (P + FEE) + 2 * BOND;
        _assertClaim(t.dealId, 0, buyer, 60_300_000);
        _assertClaim(t.dealId, 1, seller, 40_000_000);
        _assertClaim(t.dealId, 2, feeRecipient, 200_000);
        _assertClaim(t.dealId, 3, buyer, 4_000_000);
        _assertClaim(t.dealId, 4, seller, 3_000_000);
        _assertClaim(t.dealId, 5, arbRecipient, 3_000_000);
        assertEq(_claimsSum(t.dealId), inflow, "E conservation");

        for (uint8 k = 0; k < 6; k++) hub.claimFor(t.dealId, k);

        assertEq(usdc.balanceOf(buyer), 958_800_000);
        assertEq(usdc.balanceOf(seller), 1_038_000_000);
        assertEq(usdc.balanceOf(feeRecipient), 200_000);
        assertEq(usdc.balanceOf(arbRecipient), 3_000_000);
        assertEq(hub.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }
}
