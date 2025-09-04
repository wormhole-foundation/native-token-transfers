// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

struct TokenMeta {
    bytes32 name;
    bytes32 symbol;
    uint8 decimals;
}

library TokenMetaLib {
    using BytesParsing for bytes;

    function encode(
        TokenMeta memory m
    ) public pure returns (bytes memory encoded) {
        return abi.encodePacked(m.name, m.symbol, m.decimals);
    }

    function asTokenMetaUnchecked(
        bytes memory encoded,
        uint256 offset
    ) internal pure returns (TokenMeta memory tokenMeta, uint256 newOffset) {
        (tokenMeta.name, offset) = encoded.asBytes32Unchecked(offset);
        (tokenMeta.symbol, offset) = encoded.asBytes32Unchecked(offset);
        (tokenMeta.decimals, offset) = encoded.asUint8Unchecked(offset);
        newOffset = offset;
    }
}
