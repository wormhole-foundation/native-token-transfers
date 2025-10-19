// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/Utils.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

import "../libraries/external/OwnableUpgradeable.sol";
import "../libraries/external/ReentrancyGuardUpgradeable.sol";
import "../libraries/TransceiverStructs.sol";
import "../libraries/TransceiverHelpers.sol";
import "../libraries/PausableOwnable.sol";
import "../libraries/Implementation.sol";

import "../interfaces/ITransceiver.sol";
import "../interfaces/IManagerBase.sol";

import "./TransceiverRegistry.sol";

abstract contract ManagerBase is
    IManagerBase,
    TransceiverRegistry,
    PausableOwnable,
    ReentrancyGuardUpgradeable,
    Implementation
{
    // =============== Immutables ============================================================

    /// @dev Contract deployer address
    address immutable deployer;
    /// @dev Wormhole chain ID that the NTT Manager is deployed on.
    /// This chain ID is formatted Wormhole Chain IDs -- https://docs.wormhole.com/wormhole/reference/constants
    uint16 public immutable chainId;
    /// @dev EVM chain ID that the NTT Manager is deployed on.
    /// This chain ID is formatted based on standardized chain IDs, e.g. Ethereum mainnet is 1, Sepolia is 11155111, etc.
    uint256 immutable evmChainId;

    // =============== Setup =================================================================

    constructor(
        uint16 _chainId
    ) {
        chainId = _chainId;
        evmChainId = block.chainid;
        // save the deployer (check this on initialization)
        deployer = msg.sender;
    }

    function _migrate() internal virtual override {
        // Note: _checkThresholdInvariants() removed since we don't maintain global thresholds
        _checkTransceiversInvariants();
    }

    // =============== Storage ==============================================================

    bytes32 private constant MESSAGE_ATTESTATIONS_SLOT =
        bytes32(uint256(keccak256("ntt.messageAttestations")) - 1);

    bytes32 private constant MESSAGE_SEQUENCE_SLOT =
        bytes32(uint256(keccak256("ntt.messageSequence")) - 1);

    // Note: THRESHOLD_SLOT removed - we now use per-chain thresholds only
    // TODO: come up with a backwards compatible way so this contract can be
    // merged upstream (probably some simple abstract class hierarchy)

    // =============== Storage Getters/Setters ==============================================

    // Note: _getThresholdStorage() removed - we now use per-chain thresholds only

    function _getMessageAttestationsStorage()
        internal
        pure
        returns (mapping(bytes32 => AttestationInfo) storage $)
    {
        uint256 slot = uint256(MESSAGE_ATTESTATIONS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getMessageSequenceStorage() internal pure returns (_Sequence storage $) {
        uint256 slot = uint256(MESSAGE_SEQUENCE_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // =============== External Logic =============================================================

    function attestationReceived(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory payload
    ) external onlyTransceiver whenNotPaused {
        _verifyPeer(sourceChainId, sourceNttManagerAddress);

        // Compute manager message digest and record transceiver attestation.
        bytes32 nttManagerMessageHash = _recordTransceiverAttestation(sourceChainId, payload);

        if (isMessageApprovedForChain(sourceChainId, nttManagerMessageHash)) {
            this.executeMsg(sourceChainId, sourceNttManagerAddress, payload);
        }
    }

    /// @inheritdoc IManagerBase
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) public view returns (uint256[] memory, uint256) {
        uint256 numRegisteredTransceivers = _getRegisteredTransceiversStorage().length;
        address[] memory enabledTransceivers = getSendTransceiversForChain(recipientChain);

        TransceiverStructs.TransceiverInstruction[] memory instructions = TransceiverStructs
            .parseTransceiverInstructions(transceiverInstructions, numRegisteredTransceivers);

        return _quoteDeliveryPrice(recipientChain, instructions, enabledTransceivers);
    }

    // =============== Internal Logic ===========================================================

    function _quoteDeliveryPrice(
        uint16 recipientChain,
        TransceiverStructs.TransceiverInstruction[] memory transceiverInstructions,
        address[] memory enabledTransceivers
    ) internal view returns (uint256[] memory, uint256) {
        uint256 numEnabledTransceivers = enabledTransceivers.length;
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();

        uint256[] memory priceQuotes = new uint256[](numEnabledTransceivers);
        uint256 totalPriceQuote = 0;
        for (uint256 i = 0; i < numEnabledTransceivers; i++) {
            address transceiverAddr = enabledTransceivers[i];
            uint8 registeredTransceiverIndex = transceiverInfos[transceiverAddr].index;
            uint256 transceiverPriceQuote = ITransceiver(transceiverAddr).quoteDeliveryPrice(
                recipientChain, transceiverInstructions[registeredTransceiverIndex]
            );
            priceQuotes[i] = transceiverPriceQuote;
            totalPriceQuote += transceiverPriceQuote;
        }
        return (priceQuotes, totalPriceQuote);
    }

    function _recordTransceiverAttestation(
        uint16 sourceChainId,
        TransceiverStructs.NttManagerMessage memory payload
    ) internal returns (bytes32) {
        bytes32 nttManagerMessageHash =
            TransceiverStructs.nttManagerMessageDigest(sourceChainId, payload);

        // set the attested flag for this transceiver.
        // NOTE: Attestation is idempotent (bitwise or 1), but we revert
        // anyway to ensure that the client does not continue to initiate calls
        // to receive the same message through the same transceiver.
        if (
            transceiverAttestedToMessage(
                nttManagerMessageHash, _getTransceiverInfosStorage()[msg.sender].index
            )
        ) {
            revert TransceiverAlreadyAttestedToMessage(nttManagerMessageHash);
        }
        _setTransceiverAttestedToMessage(nttManagerMessageHash, msg.sender);

        return nttManagerMessageHash;
    }

    function _isMessageExecuted(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory message
    ) internal returns (bytes32, bool) {
        bytes32 digest = TransceiverStructs.nttManagerMessageDigest(sourceChainId, message);

        if (!isMessageApprovedForChain(sourceChainId, digest)) {
            revert MessageNotApproved(digest);
        }

        bool msgAlreadyExecuted = _replayProtect(digest);
        if (msgAlreadyExecuted) {
            // end execution early to mitigate the possibility of race conditions from transceivers
            // attempting to deliver the same message when (threshold < number of transceiver messages)
            // notify client (off-chain process) so they don't attempt redundant msg delivery
            emit MessageAlreadyExecuted(sourceNttManagerAddress, digest);
            return (bytes32(0), msgAlreadyExecuted);
        }

        return (digest, msgAlreadyExecuted);
    }

    function _sendMessageToTransceivers(
        uint16 recipientChain,
        bytes32 refundAddress,
        bytes32 peerAddress,
        uint256[] memory priceQuotes,
        TransceiverStructs.TransceiverInstruction[] memory transceiverInstructions,
        address[] memory enabledTransceivers,
        bytes memory nttManagerMessage
    ) internal {
        uint256 numEnabledTransceivers = enabledTransceivers.length;
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();

        if (peerAddress == bytes32(0)) {
            revert PeerNotRegistered(recipientChain);
        }

        // push onto the stack again to avoid stack too deep error
        bytes32 refundRecipient = refundAddress;

        // call into transceiver contracts to send the message
        for (uint256 i = 0; i < numEnabledTransceivers; i++) {
            address transceiverAddr = enabledTransceivers[i];

            // send it to the recipient nttManager based on the chain
            ITransceiver(transceiverAddr).sendMessage{value: priceQuotes[i]}(
                recipientChain,
                transceiverInstructions[transceiverInfos[transceiverAddr].index],
                nttManagerMessage,
                peerAddress,
                refundRecipient
            );
        }
    }

    function _prepareForTransfer(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    )
        internal
        returns (
            address[] memory,
            TransceiverStructs.TransceiverInstruction[] memory,
            uint256[] memory,
            uint256
        )
    {
        address[] memory enabledTransceivers = getSendTransceiversForChain(recipientChain);

        TransceiverStructs.TransceiverInstruction[] memory instructions;

        {
            uint256 numRegisteredTransceivers = _getRegisteredTransceiversStorage().length;
            uint256 numEnabledTransceivers = enabledTransceivers.length;

            if (numEnabledTransceivers == 0) {
                revert NoEnabledTransceivers();
            }

            instructions = TransceiverStructs.parseTransceiverInstructions(
                transceiverInstructions, numRegisteredTransceivers
            );
        }

        (uint256[] memory priceQuotes, uint256 totalPriceQuote) =
            _quoteDeliveryPrice(recipientChain, instructions, enabledTransceivers);
        {
            // check up front that msg.value will cover the delivery price
            if (msg.value < totalPriceQuote) {
                revert DeliveryPaymentTooLow(totalPriceQuote, msg.value);
            }

            // refund user extra excess value from msg.value
            uint256 excessValue = msg.value - totalPriceQuote;
            if (excessValue > 0) {
                _refundToSender(excessValue);
            }
        }

        return (enabledTransceivers, instructions, priceQuotes, totalPriceQuote);
    }

    function _refundToSender(
        uint256 refundAmount
    ) internal {
        // refund the price quote back to sender
        (bool refundSuccessful,) = payable(msg.sender).call{value: refundAmount}("");

        // check success
        if (!refundSuccessful) {
            revert RefundFailed(refundAmount);
        }
    }

    // =============== Public Getters ========================================================

    /// @notice Check if a message has enough attestations for a specific source chain
    function isMessageApprovedForChain(
        uint16 sourceChain,
        bytes32 digest
    ) public view returns (bool) {
        uint8 threshold = _getThresholdForChain(sourceChain);
        uint8 attestations = messageAttestationsForChain(sourceChain, digest);
        return attestations >= threshold && threshold > 0;
    }

    /// @inheritdoc IManagerBase
    function getThreshold(
        uint16 sourceChain
    ) external view returns (uint8) {
        return _getThresholdForChain(sourceChain);
    }

    /// @inheritdoc IManagerBase
    function nextMessageSequence() external view returns (uint64) {
        return _getMessageSequenceStorage().num;
    }

    /// @inheritdoc IManagerBase
    function isMessageExecuted(
        bytes32 digest
    ) public view returns (bool) {
        return _getMessageAttestationsStorage()[digest].executed;
    }

    /// @inheritdoc IManagerBase
    function transceiverAttestedToMessage(bytes32 digest, uint8 index) public view returns (bool) {
        return
            _getMessageAttestationsStorage()[digest].attestedTransceivers & uint64(1 << index) > 0;
    }

    /// @inheritdoc IManagerBase
    function messageAttestations(
        bytes32 digest
    ) public view returns (uint8 count) {
        return countSetBits(_getMessageAttestations(digest));
    }

    /// @notice Get the number of attestations for a message from a specific source chain
    function messageAttestationsForChain(
        uint16 sourceChain,
        bytes32 digest
    ) public view returns (uint8 count) {
        return countSetBits(_getMessageAttestationsForChain(sourceChain, digest));
    }

    // =============== Admin ==============================================================

    /// @inheritdoc IManagerBase
    function upgrade(
        address newImplementation
    ) external onlyOwner {
        _upgrade(newImplementation);
    }

    /// @inheritdoc IManagerBase
    function pause() public onlyOwnerOrPauser {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    /// @notice Transfer ownership of the Manager contract and all Transceiver contracts to a new owner.
    function transferOwnership(
        address newOwner
    ) public override onlyOwner {
        super.transferOwnership(newOwner);
        // loop through all the registered transceivers and set the new owner of each transceiver to the newOwner
        address[] storage _registeredTransceivers = _getRegisteredTransceiversStorage();
        _checkRegisteredTransceiversInvariants();

        for (uint256 i = 0; i < _registeredTransceivers.length; i++) {
            ITransceiver(_registeredTransceivers[i]).transferTransceiverOwnership(newOwner);
        }
    }

    /// @inheritdoc IManagerBase
    function setTransceiver(
        address transceiver
    ) external onlyOwner {
        _setTransceiver(transceiver);

        // Note: Global threshold is no longer maintained since we use per-chain thresholds.
        // Per-chain thresholds must be configured separately using setThreshold(uint16, uint8).

        emit TransceiverAdded(transceiver, _getNumTransceiversStorage().enabled, 0);

        // Note: _checkThresholdInvariants() removed since we don't maintain global thresholds
    }

    /// @inheritdoc IManagerBase
    function removeTransceiver(
        address transceiver
    ) external onlyOwner {
        uint8 numEnabledTransceivers = _getNumTransceiversStorage().enabled;

        // Prevent removing the last transceiver - you need at least one for the system to work
        if (numEnabledTransceivers <= 1) {
            revert ZeroThreshold(); // Reusing this error since it's about threshold requirements
        }

        // remove from all per-chain configurations first
        _removeTransceiverFromAllChains(transceiver);

        // then remove globally
        _removeTransceiver(transceiver);

        // Note: Global threshold is no longer maintained since we use per-chain thresholds.
        // Per-chain thresholds are automatically adjusted in _removeReceiveTransceiverForChain().

        emit TransceiverRemoved(transceiver, 0);
    }

    /// @notice Add a transceiver for sending to a specific chain
    /// @param targetChain The chain ID to send to
    /// @param transceiver The transceiver to enable for sending to this chain
    function setSendTransceiverForChain(
        uint16 targetChain,
        address transceiver
    ) external onlyOwner {
        _setSendTransceiverForChain(targetChain, transceiver);
        emit SendTransceiverUpdatedForChain(targetChain, transceiver, true);
    }

    /// @notice Remove a transceiver for sending to a specific chain
    /// @param targetChain The chain ID
    /// @param transceiver The transceiver to disable for sending to this chain
    function removeSendTransceiverForChain(
        uint16 targetChain,
        address transceiver
    ) external onlyOwner {
        _removeSendTransceiverForChain(targetChain, transceiver);
        emit SendTransceiverUpdatedForChain(targetChain, transceiver, false);
    }

    /// @notice Add a transceiver for receiving from a specific chain
    /// @param sourceChain The chain ID to receive from
    /// @param transceiver The transceiver to enable for receiving from this chain
    function setReceiveTransceiverForChain(
        uint16 sourceChain,
        address transceiver
    ) external onlyOwner {
        _setReceiveTransceiverForChain(sourceChain, transceiver);
        emit ReceiveTransceiverUpdatedForChain(sourceChain, transceiver, true);
    }

    /// @notice Remove a transceiver for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @param transceiver The transceiver to disable for receiving from this chain
    function removeReceiveTransceiverForChain(
        uint16 sourceChain,
        address transceiver
    ) external onlyOwner {
        _removeReceiveTransceiverForChain(sourceChain, transceiver);
        emit ReceiveTransceiverUpdatedForChain(sourceChain, transceiver, false);
    }

    /// @notice Set the threshold for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @param threshold The threshold for receiving from this chain
    function setThreshold(uint16 sourceChain, uint8 threshold) external onlyOwner {
        _setThresholdForChain(sourceChain, threshold);
        emit ThresholdUpdatedForChain(sourceChain, threshold);
    }

    /// @notice Register a known chain for migration purposes
    /// @dev This function is used to populate the known chains list for existing deployments
    ///      that were created before the chain registry was introduced. It verifies the peer
    ///      relationship before adding the chain to ensure only valid chains are registered.
    ///      This function can be called by anyone since it only adds valid peer chains.
    /// @param peerChainId The chain ID to register
    /// @param peerAddress The peer address on that chain (used for verification)
    function registerKnownChain(uint16 peerChainId, bytes32 peerAddress) external {
        if (peerAddress == bytes32(0)) {
            revert InvalidPeerZeroAddress();
        }

        // Verify this is a valid peer relationship
        _verifyPeer(peerChainId, peerAddress);

        // If verification passes, add to known chains
        _addToKnownChains(peerChainId);
    }

    // =============== Internal ==============================================================

    function _verifyPeer(uint16 sourceChainId, bytes32 peerAddress) internal virtual;

    function _setTransceiverAttestedToMessage(bytes32 digest, uint8 index) internal {
        _getMessageAttestationsStorage()[digest].attestedTransceivers |= uint64(1 << index);
    }

    function _setTransceiverAttestedToMessage(bytes32 digest, address transceiver) internal {
        _setTransceiverAttestedToMessage(digest, _getTransceiverInfosStorage()[transceiver].index);

        emit MessageAttestedTo(
            digest, transceiver, _getTransceiverInfosStorage()[transceiver].index
        );
    }

    /// @dev Returns the bitmap of attestations from enabled transceivers for a given message.
    function _getMessageAttestations(
        bytes32 digest
    ) internal view returns (uint64) {
        uint64 enabledTransceiverBitmap = _getEnabledTransceiversBitmap();
        return
            _getMessageAttestationsStorage()[digest].attestedTransceivers & enabledTransceiverBitmap;
    }

    /// @dev Returns the bitmap of attestations from enabled transceivers for a given message and source chain.
    function _getMessageAttestationsForChain(
        uint16 sourceChain,
        bytes32 digest
    ) internal view returns (uint64) {
        uint64 enabledTransceiverBitmap = _getReceiveTransceiversBitmapForChain(sourceChain);
        return
            _getMessageAttestationsStorage()[digest].attestedTransceivers & enabledTransceiverBitmap;
    }

    function _getEnabledTransceiverAttestedToMessage(
        bytes32 digest,
        uint8 index
    ) internal view returns (bool) {
        return _getMessageAttestations(digest) & uint64(1 << index) != 0;
    }

    // @dev Mark a message as executed.
    // This function will retuns `true` if the message has already been executed.
    function _replayProtect(
        bytes32 digest
    ) internal returns (bool) {
        // check if this message has already been executed
        if (isMessageExecuted(digest)) {
            return true;
        }

        // mark this message as executed
        _getMessageAttestationsStorage()[digest].executed = true;

        return false;
    }

    function _useMessageSequence() internal returns (uint64 currentSequence) {
        currentSequence = _getMessageSequenceStorage().num++;
    }

    /// ============== Invariants =============================================

    /// @dev When we add new immutables, this function should be updated
    function _checkImmutables() internal view virtual override {
        super._checkImmutables();
        assert(this.chainId() == chainId);
    }

    function _checkRegisteredTransceiversInvariants() internal view {
        if (_getRegisteredTransceiversStorage().length != _getNumTransceiversStorage().registered) {
            revert RetrievedIncorrectRegisteredTransceivers(
                _getRegisteredTransceiversStorage().length, _getNumTransceiversStorage().registered
            );
        }
    }

    // Note: _checkThresholdInvariants() function removed since we don't maintain global thresholds
    // Per-chain threshold validation is handled in _setThresholdForChain()
}
