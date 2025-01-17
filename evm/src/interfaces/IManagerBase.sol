// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "example-messaging-endpoint/evm/src/libraries/UniversalAddress.sol";

import "../libraries/TransceiverStructs.sol";

interface IManagerBase {
    /// @notice The mode is either LOCKING or BURNING. In LOCKING mode, the NttManager locks the
    ///         tokens of the sender and mints an equivalent amount on the target chain. In BURNING
    ///         mode, the NttManager burns the tokens of the sender and mints an equivalent amount
    ///         on the target chain.LOCKING mode preserves the total supply of the tokens.
    enum Mode {
        LOCKING,
        BURNING
    }

    /// @notice Information about attestations for a given message.
    /// @dev The fields are as follows:
    ///      - executed: whether the message has been executed.
    ///      - attested: bitmap of transceivers that have attested to this message.
    ///                  (NOTE: might contain disabled transceivers)
    struct AttestationInfo {
        bool executed;
        uint64 attestedTransceivers;
    }

    struct _Sequence {
        uint64 num;
    }

    struct _Threshold {
        uint8 num;
    }

    /// @notice Emitted when a message has been attested to.
    /// @dev Topic0
    ///      0x35a2101eaac94b493e0dfca061f9a7f087913fde8678e7cde0aca9897edba0e5.
    /// @param digest The digest of the message.
    /// @param transceiver The address of the transceiver.
    /// @param index The index of the transceiver in the bitmap.
    event MessageAttestedTo(bytes32 digest, address transceiver, uint8 index);

    /// @notice Emitted when the threshold for a chain is changed.
    /// @dev Topic0
    ///      0x77bc50d64a1fb4b6ef32894bc26fc008f4ee08223914c45472c9d62088c97f38.
    /// @param chainId The chain for which the threshold was updated.
    /// @param oldThreshold The old threshold.
    /// @param threshold The new threshold.
    event ThresholdChanged(uint16 chainId, uint8 oldThreshold, uint8 threshold);

    /// @notice Emitted when an transceiver is removed from the nttManager.
    /// @dev Topic0
    ///      0x2fb241a51a63da05063ac6be1f963395b281e455e8085bd246a7e8502b8950d5.
    /// @param transceiver The address of the transceiver.
    /// @param transceiversNum The current number of transceivers.
    event TransceiverAdded(address transceiver, uint256 transceiversNum);

    /// @notice payment for a transfer is too low.
    /// @param requiredPayment The required payment.
    /// @param providedPayment The provided payment.
    error DeliveryPaymentTooLow(uint256 requiredPayment, uint256 providedPayment);

    /// @notice Error when the refund to the sender fails.
    /// @dev Selector 0x2ca23714.
    /// @param refundAmount The refund amount.
    error RefundFailed(uint256 refundAmount);

    /// @notice The number of thresholds should not be zero.
    error ZeroThreshold();

    error RetrievedIncorrectRegisteredTransceivers(uint256 retrieved, uint256 registered);

    /// @notice The threshold for transceiver attestations is too high.
    /// @param threshold The threshold.
    /// @param transceivers The number of transceivers.
    error ThresholdTooHigh(uint256 threshold, uint256 transceivers);

    /// @notice Error when the tranceiver already attested to the message.
    ///         To ensure the client does not continue to initiate calls to the attestationReceived function.
    /// @dev Selector 0x2113894.
    /// @param nttManagerMessageHash The hash of the message.
    error TransceiverAlreadyAttestedToMessage(bytes32 nttManagerMessageHash);

    /// @notice Error when the message is not approved.
    /// @dev Selector 0x451c4fb0.
    /// @param msgHash The hash of the message.
    error MessageNotApproved(bytes32 msgHash);

    /// @notice There are no transceivers enabled with the Manager
    /// @dev Selector 0x69cf632a
    error NoEnabledTransceivers();

    /// @notice Error when the manager doesn't have a peer registered for the destination chain
    /// @dev Selector 0x3af256bc.
    /// @param chainId The target Wormhole chain id
    error PeerNotRegistered(uint16 chainId);

    /// @notice Fetch the delivery price for a given recipient chain transfer.
    /// @param recipientChain The Wormhole chain ID of the transfer destination.
    /// @param transceiverInstructions The encoded adapter instructions to be passed to the endpoint.
    /// @return - The delivery prices associated with each enabled endpoint and the total price.
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) external view returns (uint256);

    /// @notice Sets the threshold for the number of attestations required for a message
    /// to be considered valid.
    /// @param chain The chain to which the threshold update applies.
    /// @param threshold The new threshold (number of attestations).
    /// @dev This method can only be executed by the `owner`.
    function setThreshold(uint16 chain, uint8 threshold) external;

    /// @notice Sets the transceiver for the given chain.
    /// @param transceiver The address of the transceiver.
    /// @dev This method can only be executed by the `owner`.
    function setTransceiver(
        address transceiver
    ) external;

    /// @notice This enables the sending of messages from the given transceiver on the given chain.
    /// @param transceiver The address of the Transceiver contract.
    /// @param chain The chain ID of the Transceiver contract.
    function enableSendTransceiver(uint16 chain, address transceiver) external;

    /// @notice This enables the receiving of messages by the given transceiver on the given chain.
    /// @param transceiver The address of the Transceiver contract.
    /// @param chain The chain ID of the Transceiver contract.
    function enableRecvTransceiver(uint16 chain, address transceiver) external;

    /// @notice This disables the sending of messages from the given transceiver on the given chain.
    /// @param transceiver The address of the Transceiver contract.
    /// @param chain The chain ID of the Transceiver contract.
    function disableSendTransceiver(uint16 chain, address transceiver) external;

    /// @notice This disables the receiving of messages by the given transceiver on the given chain.
    /// @param transceiver The address of the Transceiver contract.
    /// @param chain The chain ID of the Transceiver contract.
    function disableRecvTransceiver(uint16 chain, address transceiver) external;

    /// @notice Checks if a message has been approved. The message should have at least
    /// the minimum threshold of attestations from distinct endpoints.
    /// @param srcChain The Wormhole chain ID of the sender.
    /// @param srcAddr The universal address of the message.
    /// @param sequence The sequence number of the message.
    /// @param dstAddr The destination address of the message.
    /// @param payloadHash The keccak256 of payload from the integrator.
    /// @return - Boolean indicating if message has been approved.
    function isMessageApproved(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash
    ) external view returns (bool);

    /// @notice Checks if a message has been executed.
    /// @param srcChain The Wormhole chain ID of the sender.
    /// @param srcAddr The universal address of the message.
    /// @param sequence The sequence number of the message.
    /// @param dstAddr The destination address of the message.
    /// @param payloadHash The keccak256 of payload from the integrator.
    /// @return - Boolean indicating if message has been executed.
    function isMessageExecuted(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash
    ) external view returns (bool);

    /// @notice Returns the next message sequence.
    function nextMessageSequence() external view returns (uint64);

    /// @notice Upgrades to a new manager implementation.
    /// @dev This is upgraded via a proxy, and can only be executed
    /// by the `owner`.
    /// @param newImplementation The address of the new implementation.
    function upgrade(
        address newImplementation
    ) external;

    /// @notice Pauses the manager.
    function pause() external;

    /// @notice Returns the mode (locking or burning) of the NttManager.
    /// @return mode A uint8 corresponding to the mode
    function getMode() external view returns (uint8);

    /// @notice Returns the threshold for the specified chain.
    /// it to be considered valid and acted upon.
    /// @param chain The chain for which the threshold is requested.
    function getThreshold(
        uint16 chain
    ) external view returns (uint8);

    /// @notice Returns a boolean indicating if the transceiver has attested to the message.
    /// @param srcChain The Wormhole chain ID of the sender.
    /// @param srcAddr The universal address of the message.
    /// @param sequence The sequence number of the message.
    /// @param dstAddr The destination address of the message.
    /// @param payloadHash The keccak256 of payload from the integrator.
    /// @param index The index of the transceiver
    /// @return - Boolean indicating whether the transceiver at index `index` attested to a message digest
    function transceiverAttestedToMessage(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash,
        uint8 index
    ) external view returns (bool);

    /// @notice Returns the number of attestations for a given message.
    /// @param srcChain The Wormhole chain ID of the sender.
    /// @param srcAddr The universal address of the message.
    /// @param sequence The sequence number of the message.
    /// @param dstAddr The destination address of the message.
    /// @param payloadHash The keccak256 of payload from the integrator.
    /// @return count The number of attestations received for the given message digest
    function messageAttestations(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash
    ) external view returns (uint8 count);

    /// @notice Returns of the address of the token managed by this contract.
    function token() external view returns (address);

    /// @notice Returns the chain ID.
    function chainId() external view returns (uint16);
}
