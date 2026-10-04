// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Exact integer ledger math mirroring specs/financial-ledger.md and
/// approved policy register P-01..P-04. All money is USDC smallest units.
/// No floating point anywhere. Buyer-floor / seller-remainder split throughout.
library Finance {
    uint256 internal constant MIN_PRINCIPAL = 5_000_000; // 5 USDC
    uint256 internal constant MIN_QUOTED_FEE = 500_000; // 0.50 USDC
    uint256 internal constant MIN_BOND = 5_000_000; // 5 USDC per contesting party
    uint256 internal constant FEE_DENOMINATOR = 10_000;

    /// @notice Locked fee tiers on delivery+inspection duration in seconds.
    /// Boundaries: <=10800 -> 25; <86400 -> 50; <=259200 -> 70; <=604800 -> 100; else 200.
    function feeRateBps(uint32 durationSeconds) internal pure returns (uint256) {
        if (durationSeconds <= 10_800) return 25;
        if (durationSeconds < 86_400) return 50;
        if (durationSeconds <= 259_200) return 70;
        if (durationSeconds <= 604_800) return 100;
        return 200;
    }

    /// @notice P-01: F = max(500_000, ceil(P * rateBps / 10_000)).
    function ceilQuote(uint256 principal, uint32 durationSeconds) internal pure returns (uint256) {
        uint256 q = Math.mulDiv(principal, feeRateBps(durationSeconds), FEE_DENOMINATOR, Math.Rounding.Ceil);
        return q < MIN_QUOTED_FEE ? MIN_QUOTED_FEE : q;
    }

    /// @notice L-NORMAL actual fee: floor(F * S / P). Full precision, never (S/P)*F.
    function earnedFee(uint256 quotedFee, uint256 sellerAward, uint256 principal)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(quotedFee, sellerAward, principal);
    }

    /// @notice L-NORMAL buyer share: floor(E * b / 10_000). Seller takes remainder.
    function buyerFeeShare(uint256 actualFee, uint16 buyerFeeBps) internal pure returns (uint256) {
        return Math.mulDiv(actualFee, buyerFeeBps, FEE_DENOMINATOR);
    }

    /// @notice P-03 partial-ruling bond costs, enforced exactly on-chain.
    /// Cb = floor(Qb * S / P); Cs = floor(Qs * (P - S) / P).
    function bondCosts(uint256 principal, uint256 sellerAward, uint256 buyerBond, uint256 sellerBond)
        internal
        pure
        returns (uint256 buyerCost, uint256 sellerCost)
    {
        buyerCost = Math.mulDiv(buyerBond, sellerAward, principal);
        sellerCost = Math.mulDiv(sellerBond, principal - sellerAward, principal);
    }

    /// @notice P-02 catastrophic split: odd smallest unit goes to the buyer.
    function catastrophicSplit(uint256 principal)
        internal
        pure
        returns (uint256 buyerShare, uint256 sellerShare)
    {
        sellerShare = principal / 2;
        buyerShare = principal - sellerShare;
    }
}
