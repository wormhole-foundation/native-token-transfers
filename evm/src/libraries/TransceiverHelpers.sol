// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

error InvalidFork(uint256 evmChainId, uint256 blockChainId);

function checkFork(
    uint256 evmChainId
) view {
    if (isFork(evmChainId)) {
        revert InvalidFork(evmChainId, block.chainid);
    }
}

function isFork(
    uint256 evmChainId
) view returns (bool) {
    return evmChainId != block.chainid;
}

function min(
    uint256 a,
    uint256 b
) pure returns (uint256) {
    return a < b ? a : b;
}

// @dev Count the number of set bits in a uint64 using parallel bit counting.
function countSetBits(
    uint64 x
) pure returns (uint8) {
    unchecked {
        x = x - ((x >> 1) & 0x5555555555555555);
        x = (x & 0x3333333333333333) + ((x >> 2) & 0x3333333333333333);
        x = (x + (x >> 4)) & 0x0f0f0f0f0f0f0f0f;
        return uint8((x * 0x0101010101010101) >> 56);
    }
}
