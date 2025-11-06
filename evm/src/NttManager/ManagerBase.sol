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

    /// @dev Address of the token that this NTT Manager is tied to
    address public immutable token;
    /// @dev Contract deployer address
    address immutable deployer;
    /// @dev Mode of the NTT Manager -- this is either LOCKING (Mode = 0) or BURNING (Mode = 1)
    /// In LOCKING mode, tokens are locked/unlocked by the NTT Manager contract when sending/redeeming cross-chain transfers.
    /// In BURNING mode, tokens are burned/minted by the NTT Manager contract when sending/redeeming cross-chain transfers.
    Mode public immutable mode;
    /// @dev Wormhole chain ID that the NTT Manager is deployed on.
    /// This chain ID is formatted Wormhole Chain IDs -- https://docs.wormhole.com/wormhole/reference/constants
    uint16 public immutable chainId;
    /// @dev EVM chain ID that the NTT Manager is deployed on.
    /// This chain ID is formatted based on standardized chain IDs, e.g. Ethereum mainnet is 1, Sepolia is 11155111, etc.
    uint256 immutable evmChainId;

    // =============== Setup =================================================================

    constructor(address _token, Mode _mode, uint16 _chainId) {
        token = _token;
        mode = _mode;
        chainId = _chainId;
        evmChainId = block.chainid;
        // save the deployer (check this on initialization)
        deployer = msg.sender;
    }

    function _migrate() internal virtual override {
        _checkThresholdInvariants();
        _checkTransceiversInvariants();
    }

    // =============== Storage ==============================================================

    bytes32 private constant MESSAGE_ATTESTATIONS_SLOT =
        bytes32(uint256(keccak256("ntt.messageAttestations")) - 1);

    bytes32 private constant MESSAGE_SEQUENCE_SLOT =
        bytes32(uint256(keccak256("ntt.messageSequence")) - 1);

    bytes32 private constant THRESHOLD_SLOT = bytes32(uint256(keccak256("ntt.threshold")) - 1);

    // =============== Storage Getters/Setters ==============================================

    function _getThresholdStorage() private pure returns (_Threshold storage $) {
        uint256 slot = uint256(THRESHOLD_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

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

    /// @inheritdoc IManagerBase
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) public view returns (uint256[] memory, uint256) {
        address[] memory enabledTransceivers = _getEnabledTransceiversStorage();

        TransceiverStructs.TransceiverInstruction[] memory instructions = TransceiverStructs
            .parseTransceiverInstructions(transceiverInstructions, enabledTransceivers.length);

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
        _setTransceiverAttestedToMessage(sourceChainId, nttManagerMessageHash, msg.sender);

        return nttManagerMessageHash;
    }

    function _isMessageExecuted(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory message
    ) internal returns (bytes32, bool) {
        bytes32 digest = TransceiverStructs.nttManagerMessageDigest(sourceChainId, message);

        if (!isMessageApproved(digest)) {
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
        // cache enabled transceivers to avoid multiple storage reads
        address[] memory enabledTransceivers = _getEnabledTransceiversStorage();

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

    /// @inheritdoc IManagerBase
    function getMode() public view returns (uint8) {
        return uint8(mode);
    }

    /// @inheritdoc IManagerBase
    function getThreshold() public view returns (uint8) {
        return _getThresholdStorage().num;
    }

    /// @inheritdoc IManagerBase
    function isMessageApproved(
        bytes32 digest
    ) public view returns (bool) {
        uint8 threshold = getThreshold();
        return messageAttestations(digest) >= threshold && threshold > 0;
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

        _Threshold storage _threshold = _getThresholdStorage();
        // We do not automatically increase the threshold here.
        // Automatically increasing the threshold can result in a scenario
        // where in-flight messages can't be redeemed.
        // For example: Assume there is 1 Transceiver and the threshold is 1.
        // If we were to add a new Transceiver, the threshold would increase to 2.
        // However, all messages that are either in-flight or that are sent on
        // a source chain that does not yet have 2 Transceivers will only have been
        // sent from a single transceiver, so they would never be able to get
        // redeemed.
        // Instead, we leave it up to the owner to manually update the threshold
        // after some period of time, ideally once all chains have the new Transceiver
        // and transfers that were sent via the old configuration are all complete.
        // However if the threshold is 0 (the initial case) we do increment to 1.
        if (_threshold.num == 0) {
            _threshold.num = 1;
        }

        emit TransceiverAdded(transceiver, _getNumTransceiversStorage().enabled, _threshold.num);

        _checkThresholdInvariants();
    }

    /// @inheritdoc IManagerBase
    function removeTransceiver(
        address transceiver
    ) external onlyOwner {
        _removeTransceiver(transceiver);

        _Threshold storage _threshold = _getThresholdStorage();
        uint8 numEnabledTransceivers = _getNumTransceiversStorage().enabled;

        if (numEnabledTransceivers < _threshold.num) {
            _threshold.num = numEnabledTransceivers;
        }

        emit TransceiverRemoved(transceiver, _threshold.num);

        _checkThresholdInvariants();
    }

    /// @inheritdoc IManagerBase
    function setThreshold(
        uint8 threshold
    ) external onlyOwner {
        if (threshold == 0) {
            revert ZeroThreshold();
        }

        _Threshold storage _threshold = _getThresholdStorage();
        uint8 oldThreshold = _threshold.num;

        _threshold.num = threshold;
        _checkThresholdInvariants();

        emit ThresholdChanged(oldThreshold, threshold);
    }

    // =============== Internal ==============================================================

    function _setTransceiverAttestedToMessage(bytes32 digest, uint8 index) internal {
        _getMessageAttestationsStorage()[digest].attestedTransceivers |= uint64(1 << index);
    }

    function _setTransceiverAttestedToMessage(
        uint16 sourceChainId,
        bytes32 digest,
        address transceiver
    ) internal {
        _setTransceiverAttestedToMessage(digest, _getTransceiverInfosStorage()[transceiver].index);

        emit MessageAttestedTo(
            digest, transceiver, _getTransceiverInfosStorage()[transceiver].index
        );
        emit MessageAttestedTo(sourceChainId);
    }

    /// @dev Returns the bitmap of attestations from enabled transceivers for a given message.
    function _getMessageAttestations(
        bytes32 digest
    ) internal view returns (uint64) {
        uint64 enabledTransceiverBitmap = _getEnabledTransceiversBitmap();
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
        currentSequence = _getMessageSequenceStorage().num;
        _getMessageSequenceStorage().num++;
    }

    /// ============== Invariants =============================================

    /// @dev When we add new immutables, this function should be updated
    function _checkImmutables() internal view virtual override {
        assert(this.token() == token);
        assert(this.mode() == mode);
        assert(this.chainId() == chainId);
    }

    function _checkRegisteredTransceiversInvariants() internal view {
        if (_getRegisteredTransceiversStorage().length != _getNumTransceiversStorage().registered) {
            revert RetrievedIncorrectRegisteredTransceivers(
                _getRegisteredTransceiversStorage().length, _getNumTransceiversStorage().registered
            );
        }
    }

    function _checkThresholdInvariants() internal view {
        uint8 threshold = _getThresholdStorage().num;
        _NumTransceivers memory numTransceivers = _getNumTransceiversStorage();

        // invariant: threshold <= enabledTransceivers.length
        if (threshold > numTransceivers.enabled) {
            revert ThresholdTooHigh(threshold, numTransceivers.enabled);
        }

        if (numTransceivers.registered > 0) {
            if (threshold == 0) {
                revert ZeroThreshold();
            }
        }
    }
}
