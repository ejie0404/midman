// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MidmanDK} from "../src/DealTypes.sol";

/// @notice Phase 7 integration proof: the off-chain canonical-terms builder
/// (apps/api/src/fullTerms.ts, also used by the web acceptance flow) produces
/// byte-identical EIP-712 digests to the contract for identical inputs.
/// Fixed vector recorded in apps/api/test/journey.test.mjs.
contract DigestParityTest is Test {
    address constant BUYER = 0x1111111111111111111111111111111111111111;
    address constant SELLER = 0x2222222222222222222222222222222222222222;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant HUB = 0x00000000000000000000000000000000000000AA;

    // Recorded off-chain outputs for the vector below.
    bytes32 constant EXPECTED_STRUCT =
        0xaba36be58e620311090653518dad915d624cf182de91867c8f20a4e3fa37edc0;
    bytes32 constant EXPECTED_DIGEST =
        0x9f2e8d55198db46098fc63e3085dcc747841d9a36cd0747271105150f475394b;

    function structHash() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MidmanDK.DEAL_TERMS_TYPEHASH,
                bytes32(0x1111111111111111111111111111111111111111111111111111111111111111), // dealId
                uint32(1), // termsVersion
                BUYER,
                SELLER,
                SELLER, // sellerPayoutAddress
                BUYER, // buyerRefundAddress
                BUYER, // buyerBondRefundAddress
                SELLER, // sellerBondRefundAddress
                USDC, // token
                uint256(100_000_000), // principal
                uint256(500_000), // quotedPlatformFee
                uint16(10_000), // buyerFeeBps
                bytes32(uint256(1)), // agreementHash
                bytes32(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa), // feePolicyId
                uint32(3_600), // deliveryPeriodSeconds
                uint32(43_200), // inspectionPeriodSeconds
                bytes32(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb), // categoryPolicyId
                bytes32(0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc), // readinessPolicyId
                bytes32(0), // readinessConsentHash
                bytes32(0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd), // evidencePolicyId
                bytes32(0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee), // bondPolicyId
                bytes32(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff), // arbitrationPolicyId
                bytes32(uint256(5)), // outagePolicyId
                bytes32(uint256(6)), // catastrophicPolicyId
                BUYER, // platformFeeRecipient
                SELLER, // arbitrationCostRecipient
                uint64(100_604_800), // fundingDeadline
                bytes32(0x3333333333333333333333333333333333333333333333333333333333333333), // nonce
                bytes32(0x4444444444444444444444444444444444444444444444444444444444444444), // salt
                address(0), // factory
                address(0), // implementation
                HUB // custodyAddress
            )
        );
    }

    function testStructHashParity() public pure {
        assertEq(structHash(), EXPECTED_STRUCT, "field order/type parity");
    }

    function testFullDigestParity() public pure {
        // Reconstruct the exact OZ EIP712 domain separator for
        // MidmanEscrow/1/8453/0xaa (viem builds the identical separator).
        bytes32 sep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MidmanEscrow")),
                keccak256(bytes("1")),
                uint256(8_453),
                HUB
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", sep, structHash()));
        assertEq(digest, EXPECTED_DIGEST, "full digest parity incl. domain");
    }
}
