// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../libraries/TransceiverStructs.sol";

interface IManagerBase {
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

    /// @notice Emmitted when the threshold required transceivers is changed.
    /// @dev Topic0
    ///      0x2a855b929b9a53c6fb5b5ed248b27e502b709c088e036a5aa17620c8fc5085a9.
    /// @param oldThreshold The old threshold.
    /// @param threshold The new threshold.
    event ThresholdChanged(uint8 oldThreshold, uint8 threshold);

    /// @notice Emitted when an transceiver is removed from the nttManager.
    /// @dev Topic0
    ///      0xf05962b5774c658e85ed80c91a75af9d66d2af2253dda480f90bce78aff5eda5.
    /// @param transceiver The address of the transceiver.
    /// @param transceiversNum The current number of transceivers.
    /// @param threshold The current threshold of transceivers.
    event TransceiverAdded(address transceiver, uint256 transceiversNum, uint8 threshold);

    /// @notice Emitted when an transceiver is removed from the nttManager.
    /// @dev Topic0
    ///     0x697a3853515b88013ad432f29f53d406debc9509ed6d9313dcfe115250fcd18f.
    /// @param transceiver The address of the transceiver.
    /// @param threshold The current threshold of transceivers.
    event TransceiverRemoved(address transceiver, uint8 threshold);

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

    /// @notice Emitted when a message has already been executed to
    ///         notify client of against retries.
    /// @dev Topic0
    ///      0x4069dff8c9df7e38d2867c0910bd96fd61787695e5380281148c04932d02bef2.
    /// @param sourceNttManager The address of the source nttManager.
    /// @param msgHash The keccak-256 hash of the message.
    event MessageAlreadyExecuted(bytes32 indexed sourceNttManager, bytes32 indexed msgHash);

    /// @notice There are no transceivers enabled with the Manager
    /// @dev Selector 0x69cf632a
    error NoEnabledTransceivers();

    /// @notice Error when the manager doesn't have a peer registered for the destination chain
    /// @dev Selector 0x3af256bc.
    /// @param chainId The target Wormhole chain id
    error PeerNotRegistered(uint16 chainId);

    /// @notice Called by a Transceiver contract to deliver a verified attestation.
    /// @dev This function enforces attestation threshold and replay logic for messages. Once all
    ///      validations are complete, this function calls `executeMsg` to execute the command specified
    ///      by the message.
    /// @param sourceChainId The Wormhole chain id of the sender.
    /// @param sourceNttManagerAddress The address of the sender's NTT Manager contract.
    /// @param payload The VAA payload.
    function attestationReceived(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory payload
    ) external;

    /// @notice Called after a message has been sufficiently verified to execute
    ///         the command in the message.
    /// @dev This function is exposed as a fallback for when an `Transceiver` is deregistered
    ///      when a message is in flight.
    /// @param sourceChainId The Wormhole chain id of the sender.
    /// @param sourceNttManagerAddress The address of the sender's nttManager contract.
    /// @param message The message to execute.
    function executeMsg(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory message
    ) external;

    /// @notice Fetch the delivery price for a given recipient chain transfer.
    /// @param recipientChain The Wormhole chain ID of the transfer destination.
    /// @param transceiverInstructions The transceiver specific instructions for quoting and sending
    /// @return - The delivery prices associated with each enabled endpoint and the total price.
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) external view returns (uint256[] memory, uint256);

    /// @notice Sets the threshold for the number of attestations required for a message
    /// to be considered valid.
    /// @param threshold The new threshold (number of attestations).
    /// @dev This method can only be executed by the `owner`.
    function setThreshold(
        uint8 threshold
    ) external;

    /// @notice Sets the transceiver for the given chain.
    /// @param transceiver The address of the transceiver.
    /// @dev This method can only be executed by the `owner`.
    function setTransceiver(
        address transceiver
    ) external;

    /// @notice Removes the transceiver for the given chain.
    /// @param transceiver The address of the transceiver.
    /// @dev This method can only be executed by the `owner`.
    function removeTransceiver(
        address transceiver
    ) external;

    /// @notice Checks if a message has been approved. The message should have at least
    /// the minimum threshold of attestations from distinct endpoints.
    /// @param digest The digest of the message.
    /// @return - Boolean indicating if message has been approved.
    function isMessageApproved(
        bytes32 digest
    ) external view returns (bool);

    /// @notice Checks if a message has been executed.
    /// @param digest The digest of the message.
    /// @return - Boolean indicating if message has been executed.
    function isMessageExecuted(
        bytes32 digest
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

    /// @notice Returns the number of Transceivers that must attest to a msgId for
    /// it to be considered valid and acted upon.
    function getThreshold() external view returns (uint8);

    /// @notice Returns a boolean indicating if the transceiver has attested to the message.
    /// @param digest The digest of the message.
    /// @param index The index of the transceiver
    /// @return - Boolean indicating whether the transceiver at index `index` attested to a message digest
    function transceiverAttestedToMessage(
        bytes32 digest,
        uint8 index
    ) external view returns (bool);

    /// @notice Returns the number of attestations for a given message.
    /// @param digest The digest of the message.
    /// @return count The number of attestations received for the given message digest
    function messageAttestations(
        bytes32 digest
    ) external view returns (uint8 count);

    /// @notice Returns the chain ID.
    function chainId() external view returns (uint16);
}
