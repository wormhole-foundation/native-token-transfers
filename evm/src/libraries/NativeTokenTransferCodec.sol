// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "./TokenId.sol";
import "./TokenMeta.sol";
import "./TokenInfo.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "./TrimmedAmount.sol";

/// @title NativeTokenTransferCodec
/// @notice Library for encoding and decoding native token transfer messages in the multi-token NTT system
library NativeTokenTransferCodec {
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;
    using BytesParsing for bytes;
    using TokenIdLib for TokenId;
    using TokenIdLib for bytes;
    using TokenMetaLib for TokenMeta;
    using TokenMetaLib for bytes;
    using TokenInfoLib for TokenInfo;
    using TokenInfoLib for bytes;

    error IncorrectPrefix(bytes4 prefix);
    error PayloadTooLong(uint256 length);

    struct NativeTokenTransfer {
        TrimmedAmount amount;
        TokenInfo token;
        bytes32 sender;
        bytes32 to;
        bytes additionalPayload;
    }

    /// @dev Prefix for all NativeTokenTransfer payloads
    ///      This is 0x99'N''T''T'
    ///      TODO: change this? currently clashes with NTT
    bytes4 constant NTT_PREFIX = 0x994E5454;

    function encodeNativeTokenTransfer(
        NativeTokenTransfer memory m
    ) internal pure returns (bytes memory encoded) {
        TrimmedAmount transferAmount = m.amount;

        // Always include payload length prefix for consistent wire format
        if (m.additionalPayload.length > type(uint16).max) {
            revert PayloadTooLong(m.additionalPayload.length);
        }
        uint16 additionalPayloadLength = uint16(m.additionalPayload.length);

        return abi.encodePacked(
            NTT_PREFIX,
            transferAmount.getDecimals(),
            transferAmount.getAmount(),
            m.token.encode(),
            m.sender,
            m.to,
            additionalPayloadLength,
            m.additionalPayload
        );
    }

    function parseNativeTokenTransfer(
        bytes memory encoded
    ) internal pure returns (NativeTokenTransfer memory m) {
        uint256 offset = 0;
        bytes4 prefix;
        (prefix, offset) = encoded.asBytes4Unchecked(offset);
        if (prefix != NTT_PREFIX) {
            revert IncorrectPrefix(prefix);
        }

        uint8 decimals;
        (decimals, offset) = encoded.asUint8Unchecked(offset);
        uint64 amount;
        (amount, offset) = encoded.asUint64Unchecked(offset);
        m.amount = packTrimmedAmount(amount, decimals);

        (m.token, offset) = encoded.asTokenInfoUnchecked(offset);
        (m.sender, offset) = encoded.asBytes32Unchecked(offset);
        (m.to, offset) = encoded.asBytes32Unchecked(offset);

        // Always parse the payload length prefix
        uint256 payloadLength;
        (payloadLength, offset) = encoded.asUint16Unchecked(offset);
        (m.additionalPayload, offset) = encoded.sliceUnchecked(offset, payloadLength);

        encoded.checkLength(offset);
    }
}
