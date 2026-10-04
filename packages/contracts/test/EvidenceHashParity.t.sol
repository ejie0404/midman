// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Evidence file-set hash parity: the off-chain canonical helper
/// (evidenceFilesHash in packages/chain/src/eip712.ts, used by
/// apps/api/src/commitments.ts) MUST equal keccak256(abi.encodePacked(fileHashes)) as computed in
/// HubDispute.submitEvidenceCommitment. abi.encode (length-prefixed, padded)
/// yields a DIFFERENT hash and is rejected on-chain — this test pins the
/// packed encoding with fixed vectors mirrored in
/// packages/chain/test/eip712-consolidation.test.mjs.
contract EvidenceHashParityTest is Test {
    bytes32 constant F1 = bytes32(0x1111111111111111111111111111111111111111111111111111111111111111);
    bytes32 constant F2 = bytes32(0x2222222222222222222222222222222222222222222222222222222222222222);
    bytes32 constant F3 = bytes32(0x3333333333333333333333333333333333333333333333333333333333333333);

    // Recorded off-chain (viem keccak256(concat(...))) before this file was written.
    bytes32 constant EXPECTED_PACKED_3 = bytes32(0x41524791bda53e6da2158f10c15e3672835515d6135111d11c7e9880cfcbe573);
    bytes32 constant EXPECTED_EMPTY = bytes32(0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470);
    // abi.encode of the same 3-file array (the WRONG pre-fix formula): must differ.
    bytes32 constant WRONG_ENCODE_3 = bytes32(0xb33141e287cdbb973ab6ab9cbd034a9f5772a7a2abd29f3b67efbbb90c107c7f);

    function testFilesHashParity() public pure {
        bytes32[] memory fileHashes = new bytes32[](3);
        fileHashes[0] = F1;
        fileHashes[1] = F2;
        fileHashes[2] = F3;
        assertEq(keccak256(abi.encodePacked(fileHashes)), EXPECTED_PACKED_3, "packed parity");
    }

    function testEmptyFilesHashParity() public pure {
        bytes32[] memory fileHashes = new bytes32[](0);
        assertEq(keccak256(abi.encodePacked(fileHashes)), EXPECTED_EMPTY, "empty parity");
    }

    function testPackedDiffersFromEncode() public pure {
        bytes32[] memory fileHashes = new bytes32[](3);
        fileHashes[0] = F1;
        fileHashes[1] = F2;
        fileHashes[2] = F3;
        // Guard against regressing to the pre-fix abi.encode formula.
        assertEq(keccak256(abi.encode(fileHashes)), WRONG_ENCODE_3, "encode reference");
        assertTrue(keccak256(abi.encodePacked(fileHashes)) != keccak256(abi.encode(fileHashes)), "encodings differ");
    }
}
