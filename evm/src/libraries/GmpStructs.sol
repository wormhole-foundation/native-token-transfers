// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

library GmpStructs {
    using BytesParsing for bytes;

    error PayloadTooLong(uint256 length);
    error InvalidPrefix();

    /// @dev Prefix for all GenericMesage payloads
    ///      This is 0x99'G''M''P'
    bytes4 constant GMP_PREFIX = 0x99474D50;

    struct GenericMessage {
        /// @notice target chain
        uint16 toChain;
        /// @notice contract to deliver the payload to
        bytes32 callee;
        /// @notice sender of the message
        bytes32 sender;
        /// @notice calldata to pass to the recipient contract
        bytes data;
    }

    function encodeGenericMessage(
        GenericMessage memory message
    ) internal pure returns (bytes memory) {
        if (message.data.length > type(uint16).max) {
            revert PayloadTooLong(message.data.length);
        }

        return abi.encodePacked(
            GMP_PREFIX,
            message.toChain,
            message.callee,
            message.sender,
            uint16(message.data.length),
            message.data
        );
    }

    function parseGenericMessage(
        bytes memory encoded
    ) internal pure returns (GenericMessage memory message) {
        uint256 offset = 0;
        bytes4 prefix;
        (prefix, offset) = encoded.asBytes4Unchecked(offset);
        if (prefix != GMP_PREFIX) revert InvalidPrefix();

        (message.toChain, offset) = encoded.asUint16Unchecked(offset);
        (message.callee, offset) = encoded.asBytes32Unchecked(offset);
        (message.sender, offset) = encoded.asBytes32Unchecked(offset);
        uint16 dataLength;
        (dataLength, offset) = encoded.asUint16Unchecked(offset);
        (message.data, offset) = encoded.sliceUnchecked(offset, dataLength);
        encoded.checkLength(offset);
    }
}
