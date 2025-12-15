// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import "../../libraries/TransceiverHelpers.sol";
import "../../libraries/TransceiverStructs.sol";

import "../../interfaces/IWormholeTransceiver.sol";
import "../../interfaces/INttManager.sol";

import "./WormholeTransceiverState.sol";

/// @title WormholeTransceiver
/// @author Wormhole Project Contributors.
/// @notice Transceiver implementation for Wormhole.
///
/// @dev This contract is responsible for sending and receiving NTT messages
///      that are authenticated through Wormhole Core.
///
/// @dev Messages are delivered manually via the core layer or through
///      external relayers/executors that call receiveMessage directly.
///
/// @dev Once a message is received, it is delivered to its corresponding
///      NttManager contract.
contract WormholeTransceiver is IWormholeTransceiver, WormholeTransceiverState {
    using BytesParsing for bytes;

    string public constant WORMHOLE_TRANSCEIVER_VERSION = "1.4.0";

    constructor(
        address nttManager,
        address wormholeCoreBridge,
        uint8 _consistencyLevel,
        uint256 _gasLimit
    ) WormholeTransceiverState(nttManager, wormholeCoreBridge, _consistencyLevel, _gasLimit) {}

    // ==================== External Interface ===============================================

    function getTransceiverType() external pure override returns (string memory) {
        return "wormhole";
    }

    /// @inheritdoc IWormholeTransceiver
    function receiveMessage(
        bytes memory encodedMessage
    ) external {
        uint16 sourceChainId;
        bytes memory payload;
        (sourceChainId, payload) = _verifyMessage(encodedMessage);

        // parse the encoded Transceiver payload
        TransceiverStructs.TransceiverMessage memory parsedTransceiverMessage;
        TransceiverStructs.NttManagerMessage memory parsedNttManagerMessage;
        (parsedTransceiverMessage, parsedNttManagerMessage) =
            TransceiverStructs.parseTransceiverAndNttManagerMessage(
                WH_TRANSCEIVER_PAYLOAD_PREFIX, payload
            );

        _deliverToNttManager(
            sourceChainId,
            parsedTransceiverMessage.sourceNttManagerAddress,
            parsedTransceiverMessage.recipientNttManagerAddress,
            parsedNttManagerMessage
        );
    }

    /// @inheritdoc IWormholeTransceiver
    function parseWormholeTransceiverInstruction(
        bytes memory encoded
    ) public pure returns (WormholeTransceiverInstruction memory instruction) {
        // If the user doesn't pass in any transceiver instructions then the default is false
        if (encoded.length == 0) {
            instruction.shouldSkipRelayerSend = false;
            return instruction;
        }

        uint256 offset = 0;
        (instruction.shouldSkipRelayerSend, offset) = encoded.asBoolUnchecked(offset);
        encoded.checkLength(offset);
    }

    /// @inheritdoc IWormholeTransceiver
    function encodeWormholeTransceiverInstruction(
        WormholeTransceiverInstruction memory instruction
    ) public pure returns (bytes memory) {
        return abi.encodePacked(instruction.shouldSkipRelayerSend);
    }

    // ==================== Internal ========================================================

    function _quoteDeliveryPrice(
        uint16, /* targetChain */
        TransceiverStructs.TransceiverInstruction memory /* instruction */
    ) internal view override returns (uint256 nativePriceQuote) {
        return wormhole.messageFee();
    }

    function _sendMessage(
        uint16 recipientChain,
        uint256 deliveryPayment,
        address caller,
        bytes32 recipientNttManagerAddress,
        bytes32, /* refundAddress */
        TransceiverStructs.TransceiverInstruction memory, /* instruction */
        bytes memory nttManagerMessage
    ) internal override {
        (
            TransceiverStructs.TransceiverMessage memory transceiverMessage,
            bytes memory encodedTransceiverPayload
        ) = TransceiverStructs.buildAndEncodeTransceiverMessage(
            WH_TRANSCEIVER_PAYLOAD_PREFIX,
            toWormholeFormat(caller),
            recipientNttManagerAddress,
            nttManagerMessage,
            new bytes(0)
        );

        wormhole.publishMessage{value: deliveryPayment}(
            0, encodedTransceiverPayload, consistencyLevel
        );

        // NOTE: manual relaying does not currently support refunds. The zero address
        // is used as refundAddress.
        emit RelayingInfo(uint8(RelayingType.Manual), bytes32(0), deliveryPayment);
        emit SendTransceiverMessage(recipientChain, transceiverMessage);
    }

    function _verifyMessage(
        bytes memory encodedMessage
    ) internal returns (uint16, bytes memory) {
        // verify VAA against Wormhole Core Bridge contract
        (IWormhole.VM memory vm, bool valid, string memory reason) =
            wormhole.parseAndVerifyVM(encodedMessage);

        // ensure that the VAA is valid
        if (!valid) {
            revert InvalidVaa(reason);
        }

        // ensure that the message came from a registered peer contract
        if (!_verifyBridgeVM(vm)) {
            revert InvalidWormholePeer(vm.emitterChainId, vm.emitterAddress);
        }

        // save the VAA hash in storage to protect against replay attacks.
        if (isVAAConsumed(vm.hash)) {
            revert TransferAlreadyCompleted(vm.hash);
        }
        _setVAAConsumed(vm.hash);

        // emit `ReceivedMessage` event
        emit ReceivedMessage(vm.hash, vm.emitterChainId, vm.emitterAddress, vm.sequence);

        return (vm.emitterChainId, vm.payload);
    }

    function _verifyBridgeVM(
        IWormhole.VM memory vm
    ) internal view returns (bool) {
        checkFork(wormholeTransceiver_evmChainId);
        return getWormholePeer(vm.emitterChainId) == vm.emitterAddress;
    }
}
