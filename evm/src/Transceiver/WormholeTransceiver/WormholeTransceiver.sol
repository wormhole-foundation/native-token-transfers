// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-sdk/libraries/BytesParsing.sol";
import {ICoreBridge} from "wormhole-sdk/interfaces/ICoreBridge.sol";
import {CoreBridgeLib} from "wormhole-sdk/libraries/CoreBridge.sol";
import {VaaLib} from "wormhole-sdk/libraries/VaaLib.sol";
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

    string public constant WORMHOLE_TRANSCEIVER_VERSION = "2.1.0";

    constructor(
        address nttManager,
        address wormholeCoreBridge,
        uint8 _consistencyLevel,
        uint8 _customConsistencyLevel,
        uint16 _additionalBlocks,
        address _customConsistencyLevelAddress
    )
        WormholeTransceiverState(
            nttManager,
            wormholeCoreBridge,
            _consistencyLevel,
            _customConsistencyLevel,
            _additionalBlocks,
            _customConsistencyLevelAddress
        )
    {}

    // ==================== External Interface ===============================================

    function getTransceiverType() external pure override returns (string memory) {
        return "wormhole";
    }

    /// @inheritdoc IWormholeTransceiver
    function receiveMessage(
        bytes calldata encodedMessage
    ) external {
        (uint16 sourceChainId, bytes calldata payload) = _verifyMessage(encodedMessage);

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
        (instruction.shouldSkipRelayerSend, offset) = encoded.asBoolMemUnchecked(offset);
        BytesParsing.checkLength(encoded.length, offset);
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
            toUniversalAddress(caller),
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
        bytes calldata encodedMessage
    ) internal returns (uint16, bytes calldata) {
        checkFork(wormholeTransceiver_evmChainId);

        // Verify VAA using client-side verification (gas-optimized vs CoreBridge external call).
        // The calldata variant avoids copying the entire VAA into memory.
        (
            ,,
            uint16 emitterChainId,
            bytes32 emitterAddress,
            uint64 sequence,,
            bytes calldata payload
        ) = CoreBridgeLib.decodeAndVerifyVaaCd(address(wormhole), encodedMessage);

        // ensure that the message came from a registered peer contract
        if (getWormholePeer(emitterChainId) != emitterAddress) {
            revert InvalidWormholePeer(emitterChainId, emitterAddress);
        }

        // Replay protection using the same double-keccak digest as the old CoreBridge
        // parseAndVerifyVM (backward compatible across upgrades). Computed directly from
        // calldata using the SDK's optimized keccak utilities (no abi.encodePacked allocation).
        bytes32 vaaDigest = VaaLib.calcVaaDoubleHashCd(encodedMessage);
        if (isVAAConsumed(vaaDigest)) {
            revert TransferAlreadyCompleted(vaaDigest);
        }
        _setVAAConsumed(vaaDigest);

        emit ReceivedMessage(vaaDigest, emitterChainId, emitterAddress, sequence);

        return (emitterChainId, payload);
    }
}
