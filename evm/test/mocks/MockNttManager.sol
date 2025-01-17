// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "../../src/NttManager/NttManager.sol";
import "../../src/NttManager/NttManagerNoRateLimiting.sol";

contract MockNttManagerContract is NttManager {
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId,
        uint64 rateLimitDuration,
        bool skipRateLimiting
    ) NttManager(endpoint, executor, token, mode, chainId, rateLimitDuration, skipRateLimiting) {}

    /// We create a dummy storage variable here with standard solidity slot assignment.
    /// Then we check that its assigned slot is 0, i.e. that the super contract doesn't
    /// define any storage variables (and instead uses deterministic slots).
    /// See `test_noAutomaticSlot` below.
    uint256 my_slot;

    function lastSlot() public pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := my_slot.slot
        }
    }

    function setGasLimitToZero(
        uint16 peerChainId
    ) external onlyOwner {
        _getPeersStorage()[peerChainId].gasLimit = 0;
    }

    struct OldNttManagerPeer {
        bytes32 peerAddress;
        uint8 tokenDecimals;
    }
}

contract MockNttManagerNoRateLimitingContract is NttManagerNoRateLimiting {
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId
    ) NttManagerNoRateLimiting(endpoint, executor, token, mode, chainId) {}

    /// We create a dummy storage variable here with standard solidity slot assignment.
    /// Then we check that its assigned slot is 0, i.e. that the super contract doesn't
    /// define any storage variables (and instead uses deterministic slots).
    /// See `test_noAutomaticSlot` below.
    uint256 my_slot;

    function lastSlot() public pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := my_slot.slot
        }
    }
}

contract MockNttManagerMigrateBasic is NttManager {
    // Call the parents constructor
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId,
        uint64 rateLimitDuration,
        bool skipRateLimiting
    ) NttManager(endpoint, executor, token, mode, chainId, rateLimitDuration, skipRateLimiting) {}

    function _migrate() internal view override {
        _checkThresholdInvariants();
        revert("Proper migrate called");
    }
}

contract MockNttManagerImmutableCheck is NttManager {
    // Call the parents constructor
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId,
        uint64 rateLimitDuration,
        bool skipRateLimiting
    ) NttManager(endpoint, executor, token, mode, chainId, rateLimitDuration, skipRateLimiting) {}
}

contract MockNttManagerImmutableRemoveCheck is NttManager {
    // Call the parents constructor
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId,
        uint64 rateLimitDuration,
        bool skipRateLimiting
    ) NttManager(endpoint, executor, token, mode, chainId, rateLimitDuration, skipRateLimiting) {}

    // Turns on the capability to EDIT the immutables
    function _migrate() internal override {
        _setMigratesImmutables(true);
    }
}

contract MockNttManagerStorageLayoutChange is NttManager {
    address a;
    address b;
    address c;

    // Call the parents constructor
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId,
        uint64 rateLimitDuration,
        bool skipRateLimiting
    ) NttManager(endpoint, executor, token, mode, chainId, rateLimitDuration, skipRateLimiting) {}

    function setData() public {
        a = address(0x1);
        b = address(0x2);
        c = address(0x3);
    }
}
