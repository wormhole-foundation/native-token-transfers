// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "./TokenId.sol";
import "./TokenMeta.sol";

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

// A token is either
//
// a) local
// b) foreign
//
// If it's foreign, then it has a local representation token

struct TokenInfo {
    TokenMeta meta;
    TokenId token;
}

library TokenInfoLib {
    using BytesParsing for bytes;
    using TokenMetaLib for TokenMeta;
    using TokenMetaLib for bytes;
    using TokenIdLib for TokenId;
    using TokenIdLib for bytes;

    function encode(
        TokenInfo memory m
    ) public pure returns (bytes memory encoded) {
        return abi.encodePacked(m.meta.encode(), m.token.encode());
    }

    function asTokenInfoUnchecked(
        bytes memory encoded,
        uint256 offset
    ) internal pure returns (TokenInfo memory tokenInfo, uint256 newOffset) {
        (tokenInfo.meta, offset) = encoded.asTokenMetaUnchecked(offset);
        (tokenInfo.token, offset) = encoded.asTokenIdUnchecked(offset);
        newOffset = offset;
    }
}
