// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/WormholeRelayerSDK.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import "../../libraries/TransceiverHelpers.sol";
import "../../libraries/TransceiverStructs.sol";

import "../../interfaces/IWormholeTransceiver.sol";
import "../../interfaces/ISpecialRelayer.sol";
import "../../interfaces/INttManager.sol";

import "./WormholeTransceiverState.sol";

/// @title WormholeTransceiver
/// @author Wormhole Project Contributors.
/// @notice Transceiver implementation for Wormhole.
///
/// @dev This contract is responsible for sending and receiving NTT messages
///      that are authenticated through Wormhole Core.
///
/// @dev Messages can be delivered either via standard relaying or special relaying, or
///      manually via the core layer.
///
/// @dev Once a message is received, it is delivered to its corresponding
///      NttManager contract.
contract WormholeTransceiver is
    IWormholeTransceiver,
    IWormholeReceiver,
    WormholeTransceiverState
{
    using BytesParsing for bytes;

    string public constant WORMHOLE_TRANSCEIVER_VERSION = "1.1.0";

    constructor(
        address nttManager,
        address wormholeCoreBridge,
        address wormholeRelayerAddr,
        address specialRelayerAddr,
        uint8 _consistencyLevel,
        uint256 _gasLimit
    )
        WormholeTransceiverState(
            nttManager,
            wormholeCoreBridge,
            wormholeRelayerAddr,
            specialRelayerAddr,
            _consistencyLevel,
            _gasLimit
        )
    {}

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
        (parsedTransceiverMessage, parsedNttManagerMessage) = TransceiverStructs
            .parseTransceiverAndNttManagerMessage(WH_TRANSCEIVER_PAYLOAD_PREFIX, payload);

        _deliverToNttManager(
            sourceChainId,
            parsedTransceiverMessage.sourceNttManagerAddress,
            parsedTransceiverMessage.recipientNttManagerAddress,
            parsedNttManagerMessage
        );
    }

    /// @inheritdoc IWormholeReceiver
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalMessages,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32 deliveryHash
    ) external payable onlyRelayer {
        if (getWormholePeer(sourceChain) != sourceAddress) {
            revert InvalidWormholePeer(sourceChain, sourceAddress);
        }

        // VAA replay protection:
        // - Note that this VAA is for the AR delivery, not for the raw message emitted by the source
        // - chain Transceiver contract. The VAAs received by this entrypoint are different than the
        // - VAA received by the receiveMessage entrypoint.
        if (isVAAConsumed(deliveryHash)) {
            revert TransferAlreadyCompleted(deliveryHash);
        }
        _setVAAConsumed(deliveryHash);

        // We don't honor additional messages in this handler.
        if (additionalMessages.length > 0) {
            revert UnexpectedAdditionalMessages();
        }

        // emit `ReceivedRelayedMessage` event
        emit ReceivedRelayedMessage(deliveryHash, sourceChain, sourceAddress);

        // parse the encoded Transceiver payload
        TransceiverStructs.TransceiverMessage memory parsedTransceiverMessage;
        TransceiverStructs.NttManagerMessage memory parsedNttManagerMessage;
        (parsedTransceiverMessage, parsedNttManagerMessage) = TransceiverStructs
            .parseTransceiverAndNttManagerMessage(WH_TRANSCEIVER_PAYLOAD_PREFIX, payload);

        _deliverToNttManager(
            sourceChain,
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
        uint16 targetChain,
        TransceiverStructs.TransceiverInstruction memory instruction
    ) internal view override returns (uint256 nativePriceQuote) {
        // Check the special instruction up front to see if we should skip sending via a relayer
        WormholeTransceiverInstruction memory weIns =
            parseWormholeTransceiverInstruction(instruction.payload);
        if (weIns.shouldSkipRelayerSend) {
            return wormhole.messageFee();
        }

        if (_checkInvalidRelayingConfig(targetChain)) {
            revert InvalidRelayingConfig(targetChain);
        }

        if (_shouldRelayViaStandardRelaying(targetChain)) {
            (uint256 cost,) = wormholeRelayer.quoteEVMDeliveryPrice(targetChain, 0, gasLimit);
            return cost;
        } else if (isSpecialRelayingEnabled(targetChain)) {
            uint256 cost = specialRelayer.quoteDeliveryPrice(getNttManagerToken(), targetChain, 0);
            // We need to pay both the special relayer cost and the Wormhole message fee independently
            return cost + wormhole.messageFee();
        } else {
            return wormhole.messageFee();
        }
    }

    function _sendMessage(
        uint16 recipientChain,
        uint256 deliveryPayment,
        address caller,
        bytes32 recipientNttManagerAddress,
        bytes32 refundAddress,
        TransceiverStructs.TransceiverInstruction memory instruction,
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

        WormholeTransceiverInstruction memory weIns =
            parseWormholeTransceiverInstruction(instruction.payload);

        if (!weIns.shouldSkipRelayerSend && _shouldRelayViaStandardRelaying(recipientChain)) {
            // NOTE: standard relaying supports refunds. The amount to be refunded will be sent
            // to a refundAddress specified by the client on the destination chain.

            // push onto the stack again to avoid stack too deep error
            bytes32 refundRecipient = refundAddress;
            uint16 destinationChain = recipientChain;

            wormholeRelayer.sendToEvm{value: deliveryPayment}(
                destinationChain,
                fromWormholeFormat(getWormholePeer(destinationChain)),
                encodedTransceiverPayload,
                0, // receiverValue
                0, // paymentForExtraReceiverValue,
                gasLimit,
                destinationChain,
                fromWormholeFormat(refundRecipient),
                wormholeRelayer.getDefaultDeliveryProvider(),
                new VaaKey[](0),
                consistencyLevel
            );

            emit RelayingInfo(uint8(RelayingType.Standard), refundAddress, deliveryPayment);
        } else if (!weIns.shouldSkipRelayerSend && isSpecialRelayingEnabled(recipientChain)) {
            uint256 wormholeFee = wormhole.messageFee();
            uint64 sequence = wormhole.publishMessage{value: wormholeFee}(
                0, encodedTransceiverPayload, consistencyLevel
            );
            specialRelayer.requestDelivery{value: deliveryPayment - wormholeFee}(
                getNttManagerToken(), recipientChain, 0, sequence
            );

            // NOTE: specialized relaying does not currently support refunds. The zero address
            // is used as a placeholder for the refund address until support is added.
            emit RelayingInfo(uint8(RelayingType.Special), bytes32(0), deliveryPayment);
        } else {
            wormhole.publishMessage{value: deliveryPayment}(
                0, encodedTransceiverPayload, consistencyLevel
            );

            // NOTE: manual relaying does not currently support refunds. The zero address
            // is used as refundAddress.
            emit RelayingInfo(uint8(RelayingType.Manual), bytes32(0), deliveryPayment);
        }

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
