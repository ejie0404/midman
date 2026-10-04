// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Finance} from "../src/Finance.sol";

/// @notice Fuzz + reference-model checks for the exact ledger math.
/// The reference model below is written independently (plain checked
/// arithmetic) and cross-checked against Finance on every fuzz case.
contract FinanceFuzzTest is Test {
    struct Settlement {
        uint256 prepaid;
        uint256 earned;
        uint256 buyerFee;
        uint256 sellerFee;
        uint256 buyerClaim;
        uint256 sellerClaim;
    }

    function referenceModel(uint256 P, uint256 F, uint256 S, uint16 b) internal pure returns (Settlement memory r) {
        r.prepaid = (F * b) / 10_000;
        r.earned = (F * S) / P;
        r.buyerFee = (r.earned * b) / 10_000;
        r.sellerFee = r.earned - r.buyerFee;
        r.buyerClaim = P - S + (r.prepaid - r.buyerFee);
        r.sellerClaim = S - r.sellerFee;
    }

    function testFuzz_NormalMatchesReference(uint256 P, uint256 F, uint256 S, uint8 alloc) public {
        P = bound(P, 5_000_000, 1_000_000_000_000_000);
        F = bound(F, 500_000, P);
        S = bound(S, 0, P);
        uint16 b = alloc % 3 == 0 ? uint16(0) : (alloc % 3 == 1 ? uint16(5_000) : uint16(10_000));
        Settlement memory r = referenceModel(P, F, S, b);
        assertEq(Finance.earnedFee(F, S, P), r.earned, "earned");
        assertEq(Finance.buyerFeeShare(r.earned, b), r.buyerFee, "buyerFee");
        assertEq(r.buyerClaim + r.sellerClaim + r.earned, P + r.prepaid, "conservation");
        assertLe(r.buyerFee, r.prepaid, "prepaid refund nonneg");
        if (S == 0) assertEq(r.earned, 0, "zero award earns zero");
        if (S == P) assertEq(r.earned, F, "full award earns full");
    }

    function testFuzz_QuoteCeilProperty(uint256 P, uint32 duration) public {
        P = bound(P, 5_000_000, 1_000_000_000_000_000);
        duration = uint32(bound(duration, 1, 90 days));
        uint256 F = Finance.ceilQuote(P, duration);
        uint256 rate = Finance.feeRateBps(duration);
        assertGe(F, 500_000, "minimum quote");
        assertLe(F, P, "fee within principal");
        if (F > 500_000) {
            // Ceil is exact: F*10000 - P*rate is in [0, 10000).
            uint256 scaled = F * 10_000;
            assertGe(scaled, P * rate, "covers schedule");
            assertLt(scaled - P * rate, 10_000, "within one unit");
        }
    }

    function testFuzz_BondFormulaEndpoints(uint256 P, uint256 Qb, uint256 Qs, uint256 S) public {
        P = bound(P, 5_000_000, 1_000_000_000_000_000);
        Qb = bound(Qb, 0, 1_000_000_000_000);
        Qs = bound(Qs, 0, 1_000_000_000_000);
        S = bound(S, 0, P);
        (uint256 cb, uint256 cs) = Finance.bondCosts(P, S, Qb, Qs);
        assertLe(cb, Qb, "bounded buyer cost");
        assertLe(cs, Qs, "bounded seller cost");
        if (S == 0) {
            assertEq(cb, 0, "buyer wins: no buyer cost");
            assertEq(cs, Qs, "buyer wins: full respondent cost");
        }
        if (S == P) {
            assertEq(cb, Qb, "seller wins: full claimant cost");
            assertEq(cs, 0, "seller wins: no seller cost");
        }
        // Solvency: refunds + costs == posted.
        assertEq((Qb - cb) + (Qs - cs) + (cb + cs), Qb + Qs, "bond conservation");
    }

    function testFuzz_CatastrophicDust(uint256 P) public {
        P = bound(P, 5_000_000, 1_000_000_000_000_000);
        (uint256 buyerShare, uint256 sellerShare) = Finance.catastrophicSplit(P);
        assertEq(buyerShare + sellerShare, P, "split conservation");
        assertEq(buyerShare, (P + 1) / 2, "odd unit to buyer");
        assertEq(sellerShare, P / 2, "seller floor");
    }

    function testFuzz_TinyAwards(uint256 P, uint256 S, uint8 alloc) public {
        P = bound(P, 5_000_000, 10_000_000);
        S = bound(S, 0, 2); // 0, 1, 2 smallest units
        uint16 b = alloc % 3 == 0 ? uint16(0) : (alloc % 3 == 1 ? uint16(5_000) : uint16(10_000));
        uint256 F = Finance.ceilQuote(P, 3_600);
        Settlement memory r = referenceModel(P, F, S, b);
        assertEq(r.buyerClaim + r.sellerClaim + r.earned, P + r.prepaid, "tiny conservation");
    }

    function test_FeeTierBoundaries() public {
        assertEq(Finance.feeRateBps(10_800), 25);
        assertEq(Finance.feeRateBps(10_801), 50);
        assertEq(Finance.feeRateBps(86_399), 50);
        assertEq(Finance.feeRateBps(86_400), 70);
        assertEq(Finance.feeRateBps(259_200), 70);
        assertEq(Finance.feeRateBps(259_201), 100);
        assertEq(Finance.feeRateBps(604_800), 100);
        assertEq(Finance.feeRateBps(604_801), 200);
    }
}
