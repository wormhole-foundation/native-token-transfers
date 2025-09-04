// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

struct TokenId {
    // TODO: swapping these around might make it easier to pack the chainId into
    // adjacent slots. need to review the use sites.
    uint16 chainId;
    bytes32 tokenAddress;
}

library TokenIdLib {
    using BytesParsing for bytes;

    function encode(
        TokenId memory tokenId
    ) internal pure returns (bytes memory encoded) {
        encoded = abi.encodePacked(tokenId.chainId, tokenId.tokenAddress);
    }

    function asTokenIdUnchecked(
        bytes memory encoded,
        uint256 offset
    ) internal pure returns (TokenId memory tokenId, uint256 newOffset) {
        (tokenId.chainId, offset) = encoded.asUint16Unchecked(offset);
        (tokenId.tokenAddress, offset) = encoded.asBytes32Unchecked(offset);
        newOffset = offset;
    }
}
