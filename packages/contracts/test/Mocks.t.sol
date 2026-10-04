// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Mintable 6-decimal USDC stand-in with a functional EIP-3009
/// `receiveWithAuthorization` path for testing atomic gasless funding.
/// Production verification runs against the real native Base USDC (Phase 5 fork).
contract MockUSDC is ERC20, EIP712 {
    mapping(address => mapping(bytes32 => bool)) public authorizationUsed;
    mapping(address => bool) public blocked; // token-level freeze/blacklist emulation

    bytes32 public constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    constructor() ERC20("MockUSDC", "mUSDC") EIP712("MockUSDC", "1") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "BLOCKED");
        super._update(from, to, value);
    }

    function authDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "AUTH_EXPIRED");
        require(!authorizationUsed[from][nonce], "AUTH_USED");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        require(err == ECDSA.RecoverError.NoError && recovered == from, "BAD_AUTH");
        authorizationUsed[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/// @notice Programmable sequencer uptime feed. Default: healthy (answer 0).
/// Outage scenarios are programmed per-round in Phase 5 tests.
/// latestRoundData reports fixed round start times like a real feed (never
/// the wall clock), so live-interval derivation is testable.
contract MockFeed {
    int256 public answer;
    uint80 public roundId = 1;
    mapping(uint80 => Round) public rounds;
    uint256 public latestStartedAt = 1;

    struct Round {
        int256 ans;
        uint256 startedAt;
    }

    constructor() {
        answer = 0;
        rounds[1] = Round({ans: 0, startedAt: 1});
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, latestStartedAt, latestStartedAt, roundId);
    }

    function getRoundData(uint80 rid) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[rid];
        return (rid, r.ans, r.startedAt, r.startedAt, rid);
    }

    /// @notice Program a down round followed by an up round for outage tests.
    function programOutage(uint80 downRound, uint256 downStart, uint256 upStart) external {
        rounds[downRound] = Round({ans: 1, startedAt: downStart});
        rounds[downRound + 1] = Round({ans: 0, startedAt: upStart});
        roundId = downRound + 1;
        latestStartedAt = upStart;
    }

    /// @notice Program a standalone up round (clears any trailing down round).
    function programUpRound(uint80 r, uint256 startedAt) external {
        rounds[r] = Round({ans: 0, startedAt: startedAt});
        roundId = r;
        latestStartedAt = startedAt;
    }

    /// @notice Flip the live answer (ongoing-outage vs healthy).
    function setDown(bool down) external {
        answer = down ? int256(1) : int256(0);
        if (down) latestStartedAt = block.timestamp;
    }
}
