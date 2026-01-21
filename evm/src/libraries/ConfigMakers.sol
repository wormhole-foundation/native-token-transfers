// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

library ConfigMakers {
    using BytesParsing for bytes;

    uint8 public constant TYPE_ADDITIONAL_BLOCKS = 1;

    /// @notice Encodes an additional blocks custom consistency level configuration.
    /// @param consistencyLevel The consistency level to wait for.
    /// @param blocksToWait The number of additional blocks to wait after the consistency level is reached.
    /// @return config The encoded config as bytes32.
    function makeAdditionalBlocksConfig(
        uint8 consistencyLevel,
        uint16 blocksToWait
    ) internal pure returns (bytes32 config) {
        bytes28 padding;
        bytes memory encoded =
            abi.encodePacked(TYPE_ADDITIONAL_BLOCKS, consistencyLevel, blocksToWait, padding);
        (config,) = encoded.asBytes32Unchecked(0);
    }
}
