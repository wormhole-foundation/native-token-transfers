// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IGmpManager.sol";
import "../libraries/GmpStructs.sol";
import "./GmpIntegration.sol";
import {ManagerBase} from "../NttManager/ManagerBase.sol";
import "wormhole-solidity-sdk/Utils.sol";

contract GmpManager is IGmpManager, ManagerBase {
    string public constant GMP_MANAGER_VERSION = "1.0.0";

    constructor(
        uint16 _chainId
    ) ManagerBase(_chainId) {}

    struct GmpPeer {
        bytes32 peerAddress;
    }

    function __GmpManager_init() internal onlyInitializing {
        // check if the owner is the deployer of this contract
        if (msg.sender != deployer) {
            revert UnexpectedDeployer(deployer, msg.sender);
        }
        if (msg.value != 0) {
            revert UnexpectedMsgValue();
        }
        __PausedOwnable_init(msg.sender, msg.sender);
        __ReentrancyGuard_init();
        // NOTE: we bump the message counter to start from 1
        // this is so we can use '0' as a sentinel value for unreserved sequences
        _useMessageSequence();
    }

    function _initialize() internal virtual override {
        super._initialize();
        __GmpManager_init();
        // Note: _checkThresholdInvariants() removed since we don't maintain global thresholds
        _checkTransceiversInvariants();
    }

    // =============== Storage ==============================================================

    bytes32 private constant PEERS_SLOT = bytes32(uint256(keccak256("gmp.peers")) - 1);
    bytes32 private constant RESERVED_SEQUENCES_SLOT =
        bytes32(uint256(keccak256("gmp.reservedSequences")) - 1);

    // =============== Storage Getters/Setters ==============================================

    function _getPeersStorage() internal pure returns (mapping(uint16 => GmpPeer) storage $) {
        uint256 slot = uint256(PEERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getReservedSequencesStorage()
        internal
        pure
        returns (mapping(address => mapping(uint64 => bool)) storage $)
    {
        uint256 slot = uint256(RESERVED_SEQUENCES_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // =============== Public Getters ========================================================

    function getPeer(
        uint16 chainId_
    ) external view returns (GmpPeer memory) {
        return _getPeersStorage()[chainId_];
    }

    function _verifyPeer(uint16 sourceChainId, bytes32 peerAddress) internal view override {
        if (_getPeersStorage()[sourceChainId].peerAddress != peerAddress) {
            revert InvalidPeer(sourceChainId, peerAddress);
        }
    }

    // =============== External Interface =========================================================

    /**
     * @notice Reserve a message sequence number for later use
     * @dev This function allows users to reserve sequence numbers ahead of time,
     *      which can be useful for applications that need deterministic sequence numbers
     *      or want to guarantee a specific ordering of messages.
     *
     * @dev Sequence numbers start at 1 (not 0) to allow 0 to be used as a sentinel value
     *      to indicate "no reserved sequence" in sendMessage calls.
     *
     * @dev Reserved sequences are per-sender, meaning only the address that reserved
     *      a sequence can use it in a subsequent sendMessage call.
     *
     * @dev Reserved sequences are single-use - once consumed in a sendMessage call,
     *      they cannot be reused.
     *
     * @return sequence The reserved sequence number
     */
    function reserveMessageSequence() external override returns (uint64 sequence) {
        sequence = _useMessageSequence();
        _getReservedSequencesStorage()[msg.sender][sequence] = true;
    }

    function _verifyAndConsumeReservedMessageSequence(
        uint64 sequence
    ) internal {
        if (!_getReservedSequencesStorage()[msg.sender][sequence]) {
            revert SequenceNotReservedBySender(sequence, msg.sender);
        }
        _getReservedSequencesStorage()[msg.sender][sequence] = false;
    }

    // this exists just to minimise the number of local variable assignments :(
    struct PreparedTransfer {
        address[] enabledTransceivers;
        TransceiverStructs.TransceiverInstruction[] instructions;
        uint256[] priceQuotes;
        uint256 totalPriceQuote;
    }

    /**
     * @notice Send a cross-chain message to a target contract
     * @dev This function supports both immediate sequence allocation and pre-reserved sequences.
     *
     * ## Sequence Reservation Flow:
     *
     * ### Option 1: Immediate Sequence Allocation
     * - Pass `reservedSequence = 0` to allocate a new sequence immediately
     * - The function will automatically assign the next available sequence number
     * - This is the default behavior for most use cases
     *
     * ### Option 2: Pre-Reserved Sequence Usage
     * - First call `reserveMessageSequence()` to obtain a reserved sequence number
     * - Then pass that sequence number as `reservedSequence` parameter
     * - The function will validate that the sequence was reserved by the caller
     * - Once used, the reserved sequence is consumed and cannot be reused
     *
     * @param targetChain The Wormhole chain ID of the target chain
     * @param callee The address of the contract to call on the target chain (32-byte format)
     * @param refundAddress The address to refund excess fees to on the target chain (32-byte format)
     * @param reservedSequence The pre-reserved sequence to use, or 0 for immediate allocation
     * @param data The calldata to execute on the target chain
     * @param transceiverInstructions Instructions for transceivers (e.g., gas limits, relayer settings)
     *
     * @return actualSequence The sequence number assigned to this message
     *
     */
    function sendMessage(
        uint16 targetChain,
        bytes32 callee,
        bytes32 refundAddress,
        uint64 reservedSequence,
        bytes calldata data,
        bytes calldata transceiverInstructions
    ) external payable override nonReentrant whenNotPaused returns (uint64 actualSequence) {
        return _sendMessage(
            targetChain, callee, refundAddress, reservedSequence, data, transceiverInstructions
        );
    }

    function _sendMessage(
        uint16 targetChain,
        bytes32 callee,
        bytes32 refundAddress,
        uint64 reservedSequence,
        bytes calldata data,
        bytes calldata transceiverInstructions
    ) internal returns (uint64 sequence) {
        if (callee == bytes32(0)) {
            revert InvalidCallee();
        }

        if (refundAddress == bytes32(0)) {
            revert InvalidRefundAddress();
        }

        // Handle sequence allocation/reservation
        if (reservedSequence == 0) {
            // No sequence provided, allocate a new one
            sequence = _useMessageSequence();
        } else {
            _verifyAndConsumeReservedMessageSequence(reservedSequence);
            sequence = reservedSequence;
        }

        bytes memory encodedGmpManagerPayload;

        {
            GmpStructs.GenericMessage memory message = GmpStructs.GenericMessage({
                toChain: targetChain,
                callee: callee,
                sender: toWormholeFormat(msg.sender),
                data: data
            });

            encodedGmpManagerPayload = TransceiverStructs.encodeNttManagerMessage(
                TransceiverStructs.NttManagerMessage(
                    bytes32(uint256(sequence)),
                    toWormholeFormat(msg.sender),
                    GmpStructs.encodeGenericMessage(message)
                )
            );
        }

        PreparedTransfer memory preparedTransfer;
        {
            (
                address[] memory enabledTransceivers,
                TransceiverStructs.TransceiverInstruction[] memory instructions,
                uint256[] memory priceQuotes,
                uint256 totalPriceQuote
            ) = _prepareForTransfer(targetChain, transceiverInstructions);

            preparedTransfer = PreparedTransfer({
                enabledTransceivers: enabledTransceivers,
                instructions: instructions,
                priceQuotes: priceQuotes,
                totalPriceQuote: totalPriceQuote
            });
        }

        bytes32 peerAddress = _getPeersStorage()[targetChain].peerAddress;
        if (peerAddress == bytes32(0)) {
            revert InvalidPeer(targetChain, peerAddress);
        }

        _sendMessageToTransceivers(
            targetChain,
            refundAddress,
            peerAddress,
            preparedTransfer.priceQuotes,
            preparedTransfer.instructions,
            preparedTransfer.enabledTransceivers,
            encodedGmpManagerPayload
        );

        emit MessageSent(
            sequence, msg.sender, targetChain, callee, data, preparedTransfer.totalPriceQuote
        );
    }

    function executeMsg(
        uint16 sourceChainId,
        bytes32 sourceGmpManagerAddress,
        TransceiverStructs.NttManagerMessage memory message
    ) public override nonReentrant whenNotPaused {
        (bytes32 digest, bool alreadyExecuted) =
            _isMessageExecuted(sourceChainId, sourceGmpManagerAddress, message);

        if (alreadyExecuted) {
            return;
        }

        GmpStructs.GenericMessage memory gmp = GmpStructs.parseGenericMessage(message.payload);

        if (gmp.toChain != chainId) {
            revert InvalidTargetChain(gmp.toChain, chainId);
        }

        address callee = fromWormholeFormat(gmp.callee);
        GmpIntegration(callee).receiveMessage(digest, sourceChainId, gmp.sender, gmp.data);

        emit MessageExecuted(
            digest, sourceChainId, fromWormholeFormat(message.sender), callee, gmp.data
        );
    }

    // =============== Admin ==============================================================

    function setPeer(uint16 peerChainId, bytes32 peerAddress) public onlyOwner {
        if (peerChainId == 0) {
            revert InvalidPeerChainIdZero();
        }
        if (peerAddress == bytes32(0)) {
            revert InvalidPeerZeroAddress();
        }
        if (peerChainId == chainId) {
            revert InvalidPeerSameChainId();
        }

        GmpPeer memory oldPeer = _getPeersStorage()[peerChainId];

        _getPeersStorage()[peerChainId].peerAddress = peerAddress;

        _addToKnownChains(peerChainId);

        emit PeerUpdated(peerChainId, oldPeer.peerAddress, peerAddress);
    }
}
