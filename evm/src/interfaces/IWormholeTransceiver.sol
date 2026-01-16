// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../libraries/TransceiverStructs.sol";

import "./IWormholeTransceiverState.sol";

interface IWormholeTransceiver is IWormholeTransceiverState {
    /// @notice The instruction for the WormholeTransceiver contract
    ///         to skip delivery via the relayer.
    struct WormholeTransceiverInstruction {
        bool shouldSkipRelayerSend;
    }

    /// @notice Emitted when a message is received.
    /// @dev Topic0
    ///     0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0.
    /// @param digest The digest of the message.
    /// @param emitterChainId The chain ID of the emitter.
    /// @param emitterAddress The address of the emitter.
    /// @param sequence The sequence of the message.
    event ReceivedMessage(
        bytes32 digest, uint16 emitterChainId, bytes32 emitterAddress, uint64 sequence
    );

    /// @notice Emitted when a message is sent from the transceiver.
    /// @dev Topic0
    ///      0x79376a0dc6cbfe6f6f8f89ad24c262a8c6233f8df181d3fe5abb2e2442e8c738.
    /// @param recipientChain The chain ID of the recipient.
    /// @param message The message.
    event SendTransceiverMessage(
        uint16 recipientChain, TransceiverStructs.TransceiverMessage message
    );

    /// @notice Error when the peer transceiver is invalid.
    /// @dev Selector: 0x79b1ce56.
    /// @param chainId The chain ID of the peer.
    /// @param peerAddress The address of the invalid peer.
    error InvalidWormholePeer(uint16 chainId, bytes32 peerAddress);

    /// @notice Error when the VAA has already been consumed.
    /// @dev Selector: 0x406e719e.
    /// @param vaaHash The hash of the VAA.
    error TransferAlreadyCompleted(bytes32 vaaHash);

    /// @notice Receive an attested message from the verification layer.
    ///         This function should verify the `encodedVm` and then deliver the attestation
    /// to the transceiver NttManager contract.
    /// @param encodedMessage The attested message.
    function receiveMessage(
        bytes memory encodedMessage
    ) external;

    /// @notice Parses the encoded instruction and returns the instruction struct.
    ///         This instruction is specific to the WormholeTransceiver contract.
    /// @param encoded The encoded instruction.
    /// @return instruction The parsed `WormholeTransceiverInstruction`.
    function parseWormholeTransceiverInstruction(
        bytes memory encoded
    ) external pure returns (WormholeTransceiverInstruction memory instruction);

    /// @notice Encodes the `WormholeTransceiverInstruction` into a byte array.
    /// @param instruction The `WormholeTransceiverInstruction` to encode.
    /// @return encoded The encoded instruction.
    function encodeWormholeTransceiverInstruction(
        WormholeTransceiverInstruction memory instruction
    ) external pure returns (bytes memory);
}
