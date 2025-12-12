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

// @dev Count the number of set bits in a uint64
function countSetBits(
    uint64 x
) pure returns (uint8 count) {
    while (x != 0) {
        x &= x - 1;
        count++;
    }

    return count;
}
