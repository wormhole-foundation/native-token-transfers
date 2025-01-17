// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "../../src/NttManager/NttManagerNoRateLimiting.sol";

contract MockNttManagerAdditionalPayloadContract is NttManagerNoRateLimiting {
    constructor(
        address endpoint,
        address executor,
        address token,
        Mode mode,
        uint16 chainId
    ) NttManagerNoRateLimiting(endpoint, executor, token, mode, chainId) {}

    event AdditionalPayloadSent(bytes payload);
    event AdditionalPayloadReceived(bytes payload);

    function _prepareNativeTokenTransfer(
        TrimmedAmount amount,
        bytes32 recipient,
        uint16 recipientChain,
        uint64, // sequence
        address, // sender
        bytes32 // refundAddress
    ) internal override returns (TransceiverStructs.NativeTokenTransfer memory) {
        bytes memory additionalPayload = abi.encodePacked("banana");
        emit AdditionalPayloadSent(additionalPayload);
        return TransceiverStructs.NativeTokenTransfer(
            amount, toWormholeFormat(token), recipient, recipientChain, additionalPayload
        );
    }

    function _handleAdditionalPayload(
        uint16, // sourceChainId
        bytes32, // sourceNttManagerAddress
        bytes32, // id
        bytes32, // sender
        TransceiverStructs.NativeTokenTransfer memory nativeTokenTransfer
    ) internal override {
        emit AdditionalPayloadReceived(nativeTokenTransfer.additionalPayload);
    }
}
