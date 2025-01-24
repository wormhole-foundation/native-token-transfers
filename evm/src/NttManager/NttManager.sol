// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "wormhole-solidity-sdk/Utils.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

import "../libraries/RateLimiter.sol";

import "../interfaces/INttManager.sol";
import "../interfaces/INttToken.sol";
import "../interfaces/ITransceiver.sol";

import {ManagerBase} from "./ManagerBase.sol";

/// @title NttManager
/// @author Wormhole Project Contributors.
/// @notice The NttManager contract is responsible for managing the token
///         and associated transceivers.
///
/// @dev Each NttManager contract is associated with a single token but
///      can be responsible for multiple transceivers.
///
/// @dev When transferring tokens, the NttManager contract will either
///      lock the tokens or burn them, depending on the mode.
///
/// @dev To initiate a transfer, the user calls the transfer function with:
///  - the amount
///  - the recipient chain
///  - the recipient address
///  - the refund address: the address to which refunds are issued for any unused gas
///    for attestations on a given transfer. If the gas limit is configured
///    to be too high, users will be refunded the difference.
///  - (optional) a flag to indicate whether the transfer should be queued
///    if the rate limit is exceeded
contract NttManager is INttManager, RateLimiter, ManagerBase {
    using BytesParsing for bytes;
    using SafeERC20 for IERC20;
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    string public constant NTT_MANAGER_VERSION = "1.1.0";

    // =============== Setup =================================================================

    constructor(
        address _token,
        Mode _mode,
        uint16 _chainId,
        uint64 _rateLimitDuration,
        bool _skipRateLimiting
    ) RateLimiter(_rateLimitDuration, _skipRateLimiting) ManagerBase(_token, _mode, _chainId) {}

    function __NttManager_init() internal onlyInitializing {
        // check if the owner is the deployer of this contract
        if (msg.sender != deployer) {
            revert UnexpectedDeployer(deployer, msg.sender);
        }
        if (msg.value != 0) {
            revert UnexpectedMsgValue();
        }
        __PausedOwnable_init(msg.sender, msg.sender);
        __ReentrancyGuard_init();
        _setOutboundLimit(TrimmedAmountLib.max(tokenDecimals()));
    }

    function _initialize() internal virtual override {
        __NttManager_init();
        _checkThresholdInvariants();
        _checkTransceiversInvariants();
    }

    // =============== Storage ==============================================================

    bytes32 private constant PEERS_SLOT = bytes32(uint256(keccak256("ntt.peers")) - 1);

    // =============== Storage Getters/Setters ==============================================

    function _getPeersStorage()
        internal
        pure
        returns (mapping(uint16 => NttManagerPeer) storage $)
    {
        uint256 slot = uint256(PEERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // =============== Public Getters ========================================================

    /// @inheritdoc INttManager
    function getPeer(
        uint16 chainId_
    ) external view returns (NttManagerPeer memory) {
        return _getPeersStorage()[chainId_];
    }

    // =============== Admin ==============================================================

    /// @inheritdoc INttManager
    function setPeer(
        uint16 peerChainId,
        bytes32 peerContract,
        uint8 decimals,
        uint256 inboundLimit
    ) public onlyOwner {
        if (peerChainId == 0) {
            revert InvalidPeerChainIdZero();
        }
        if (peerContract == bytes32(0)) {
            revert InvalidPeerZeroAddress();
        }
        if (decimals == 0) {
            revert InvalidPeerDecimals();
        }
        if (peerChainId == chainId) {
            revert InvalidPeerSameChainId();
        }

        NttManagerPeer memory oldPeer = _getPeersStorage()[peerChainId];

        _getPeersStorage()[peerChainId].peerAddress = peerContract;
        _getPeersStorage()[peerChainId].tokenDecimals = decimals;

        uint8 toDecimals = tokenDecimals();
        _setInboundLimit(inboundLimit.trim(toDecimals, toDecimals), peerChainId);

        emit PeerUpdated(
            peerChainId, oldPeer.peerAddress, oldPeer.tokenDecimals, peerContract, decimals
        );
    }

    /// @inheritdoc INttManager
    function setOutboundLimit(
        uint256 limit
    ) external onlyOwner {
        uint8 toDecimals = tokenDecimals();
        _setOutboundLimit(limit.trim(toDecimals, toDecimals));
    }

    /// @inheritdoc INttManager
    function setInboundLimit(uint256 limit, uint16 chainId_) external onlyOwner {
        uint8 toDecimals = tokenDecimals();
        _setInboundLimit(limit.trim(toDecimals, toDecimals), chainId_);
    }

    /// ============== Invariants =============================================

    /// @dev When we add new immutables, this function should be updated
    function _checkImmutables() internal view override {
        super._checkImmutables();
        assert(this.rateLimitDuration() == rateLimitDuration);
    }

    // ==================== External Interface ===============================================

    /// @inheritdoc INttManager
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    ) external payable nonReentrant whenNotPaused returns (uint64) {
        return
            _transferEntryPoint(amount, recipientChain, recipient, recipient, false, new bytes(1));
    }

    /// @inheritdoc INttManager
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        bool shouldQueue,
        bytes memory transceiverInstructions
    ) external payable nonReentrant whenNotPaused returns (uint64) {
        return _transferEntryPoint(
            amount, recipientChain, recipient, refundAddress, shouldQueue, transceiverInstructions
        );
    }

    /// @inheritdoc INttManager
    function attestationReceived(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory payload
    ) external onlyTransceiver whenNotPaused {
        _verifyPeer(sourceChainId, sourceNttManagerAddress);

        // Compute manager message digest and record transceiver attestation.
        bytes32 nttManagerMessageHash = _recordTransceiverAttestation(sourceChainId, payload);

        if (isMessageApproved(nttManagerMessageHash)) {
            executeMsg(sourceChainId, sourceNttManagerAddress, payload);
        }
    }

    /// @inheritdoc INttManager
    function executeMsg(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory message
    ) public whenNotPaused {
        (bytes32 digest, bool alreadyExecuted) =
            _isMessageExecuted(sourceChainId, sourceNttManagerAddress, message);

        if (alreadyExecuted) {
            return;
        }

        _handleMsg(sourceChainId, sourceNttManagerAddress, message, digest);
    }

    /// @dev Override this function to handle custom NttManager payloads.
    /// This can also be used to customize transfer logic by using your own
    /// _handleTransfer implementation.
    function _handleMsg(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory message,
        bytes32 digest
    ) internal virtual {
        _handleTransfer(sourceChainId, sourceNttManagerAddress, message, digest);
    }

    function _handleTransfer(
        uint16 sourceChainId,
        bytes32 sourceNttManagerAddress,
        TransceiverStructs.NttManagerMessage memory message,
        bytes32 digest
    ) internal {
        TransceiverStructs.NativeTokenTransfer memory nativeTokenTransfer =
            TransceiverStructs.parseNativeTokenTransfer(message.payload);

        // verify that the destination chain is valid
        if (nativeTokenTransfer.toChain != chainId) {
            revert InvalidTargetChain(nativeTokenTransfer.toChain, chainId);
        }
        uint8 toDecimals = tokenDecimals();
        TrimmedAmount nativeTransferAmount =
            (nativeTokenTransfer.amount.untrim(toDecimals)).trim(toDecimals, toDecimals);

        address transferRecipient = fromWormholeFormat(nativeTokenTransfer.to);

        bool enqueued = _enqueueOrConsumeInboundRateLimit(
            digest, sourceChainId, nativeTransferAmount, transferRecipient
        );

        if (enqueued) {
            return;
        }

        _handleAdditionalPayload(
            sourceChainId, sourceNttManagerAddress, message.id, message.sender, nativeTokenTransfer
        );

        _mintOrUnlockToRecipient(digest, transferRecipient, nativeTransferAmount, false);
    }

    /// @dev Override this function to process an additional payload on the NativeTokenTransfer
    /// For integrator flexibility, this function is *not* marked pure or view
    /// @param - The Wormhole chain id of the sender
    /// @param - The address of the sender's NTT Manager contract.
    /// @param - The message id from the NttManagerMessage.
    /// @param - The original message sender address from the NttManagerMessage.
    /// @param - The parsed NativeTokenTransfer, which includes the additionalPayload field
    function _handleAdditionalPayload(
        uint16, // sourceChainId
        bytes32, // sourceNttManagerAddress
        bytes32, // id
        bytes32, // sender
        TransceiverStructs.NativeTokenTransfer memory // nativeTokenTransfer
    ) internal virtual {}

    function _enqueueOrConsumeInboundRateLimit(
        bytes32 digest,
        uint16 sourceChainId,
        TrimmedAmount nativeTransferAmount,
        address transferRecipient
    ) internal virtual returns (bool) {
        // Check inbound rate limits
        bool isRateLimited = _isInboundAmountRateLimited(nativeTransferAmount, sourceChainId);
        if (isRateLimited) {
            // queue up the transfer
            _enqueueInboundTransfer(digest, nativeTransferAmount, transferRecipient);

            // end execution early
            return true;
        }

        // consume the amount for the inbound rate limit
        _consumeInboundAmount(nativeTransferAmount, sourceChainId);
        // When receiving a transfer, we refill the outbound rate limit
        // by the same amount (we call this "backflow")
        _backfillOutboundAmount(nativeTransferAmount);
        return false;
    }

    /// @inheritdoc INttManager
    function completeInboundQueuedTransfer(
        bytes32 digest
    ) external virtual nonReentrant whenNotPaused {
        // find the message in the queue
        InboundQueuedTransfer memory queuedTransfer = RateLimiter.getInboundQueuedTransfer(digest);
        if (queuedTransfer.txTimestamp == 0) {
            revert InboundQueuedTransferNotFound(digest);
        }

        // check that > RATE_LIMIT_DURATION has elapsed
        if (block.timestamp - queuedTransfer.txTimestamp < rateLimitDuration) {
            revert InboundQueuedTransferStillQueued(digest, queuedTransfer.txTimestamp);
        }

        // remove transfer from the queue
        delete _getInboundQueueStorage()[digest];

        // run it through the mint/unlock logic
        _mintOrUnlockToRecipient(digest, queuedTransfer.recipient, queuedTransfer.amount, false);
    }

    /// @inheritdoc INttManager
    function completeOutboundQueuedTransfer(
        uint64 messageSequence
    ) external payable virtual nonReentrant whenNotPaused returns (uint64) {
        // find the message in the queue
        OutboundQueuedTransfer memory queuedTransfer = _getOutboundQueueStorage()[messageSequence];
        if (queuedTransfer.txTimestamp == 0) {
            revert OutboundQueuedTransferNotFound(messageSequence);
        }

        // check that > RATE_LIMIT_DURATION has elapsed
        if (block.timestamp - queuedTransfer.txTimestamp < rateLimitDuration) {
            revert OutboundQueuedTransferStillQueued(messageSequence, queuedTransfer.txTimestamp);
        }

        // remove transfer from the queue
        delete _getOutboundQueueStorage()[messageSequence];

        // run it through the transfer logic and skip the rate limit
        return _transfer(
            messageSequence,
            queuedTransfer.amount,
            queuedTransfer.recipientChain,
            queuedTransfer.recipient,
            queuedTransfer.refundAddress,
            queuedTransfer.sender,
            queuedTransfer.transceiverInstructions
        );
    }

    /// @inheritdoc INttManager
    function cancelOutboundQueuedTransfer(
        uint64 messageSequence
    ) external virtual nonReentrant whenNotPaused {
        // find the message in the queue
        OutboundQueuedTransfer memory queuedTransfer = _getOutboundQueueStorage()[messageSequence];
        if (queuedTransfer.txTimestamp == 0) {
            revert OutboundQueuedTransferNotFound(messageSequence);
        }

        // check msg.sender initiated the transfer
        if (queuedTransfer.sender != msg.sender) {
            revert CancellerNotSender(msg.sender, queuedTransfer.sender);
        }

        // remove transfer from the queue
        delete _getOutboundQueueStorage()[messageSequence];

        // return the queued funds to the sender
        _mintOrUnlockToRecipient(
            bytes32(uint256(messageSequence)), msg.sender, queuedTransfer.amount, true
        );
    }

    // ==================== Internal Business Logic =========================================

    function _transferEntryPoint(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        bool shouldQueue,
        bytes memory transceiverInstructions
    ) internal virtual returns (uint64) {
        if (amount == 0) {
            revert ZeroAmount();
        }

        if (recipient == bytes32(0)) {
            revert InvalidRecipient();
        }

        if (refundAddress == bytes32(0)) {
            revert InvalidRefundAddress();
        }

        {
            // Lock/burn tokens before checking rate limits
            // use transferFrom to pull tokens from the user and lock them
            // query own token balance before transfer
            uint256 balanceBefore = _getTokenBalanceOf(token, address(this));

            // transfer tokens
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

            // query own token balance after transfer
            uint256 balanceAfter = _getTokenBalanceOf(token, address(this));

            // correct amount for potential transfer fees
            amount = balanceAfter - balanceBefore;
            if (mode == Mode.BURNING) {
                {
                    // NOTE: We don't account for burn fees in this code path.
                    // We verify that the user's change in balance is equal to the amount that's burned.
                    // Accounting for burn fees can be non-trivial, since there
                    // is no standard way to account for the fee if the fee amount
                    // is taken out of the burn amount.
                    // For example, if there's a fee of 1 which is taken out of the
                    // amount, then burning 20 tokens would result in a transfer of only 19 tokens.
                    // However, the difference in the user's balance would only show 20.
                    // Since there is no standard way to query for burn fee amounts with burnable tokens,
                    // and NTT would be used on a per-token basis, implementing this functionality
                    // is left to integrating projects who may need to account for burn fees on their tokens.
                    ERC20Burnable(token).burn(amount);

                    // tokens held by the contract after the operation should be the same as before
                    uint256 balanceAfterBurn = _getTokenBalanceOf(token, address(this));
                    if (balanceBefore != balanceAfterBurn) {
                        revert BurnAmountDifferentThanBalanceDiff(balanceBefore, balanceAfterBurn);
                    }
                }
            }
        }

        // trim amount after burning to ensure transfer amount matches (amount - fee)
        TrimmedAmount trimmedAmount = _trimTransferAmount(amount, recipientChain);

        // get the sequence for this transfer
        uint64 sequence = _useMessageSequence();

        bool enqueued = _enqueueOrConsumeOutboundRateLimit(
            amount,
            recipientChain,
            recipient,
            refundAddress,
            shouldQueue,
            transceiverInstructions,
            trimmedAmount,
            sequence
        );

        if (enqueued) {
            return sequence;
        }

        return _transfer(
            sequence,
            trimmedAmount,
            recipientChain,
            recipient,
            refundAddress,
            msg.sender,
            transceiverInstructions
        );
    }

    function _enqueueOrConsumeOutboundRateLimit(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        bool shouldQueue,
        bytes memory transceiverInstructions,
        TrimmedAmount trimmedAmount,
        uint64 sequence
    ) internal virtual returns (bool enqueued) {
        TrimmedAmount internalAmount = trimmedAmount.shift(tokenDecimals());

        // now check rate limits
        bool isAmountRateLimited = _isOutboundAmountRateLimited(internalAmount);
        if (!shouldQueue && isAmountRateLimited) {
            revert NotEnoughCapacity(getCurrentOutboundCapacity(), amount);
        }
        if (shouldQueue && isAmountRateLimited) {
            // verify chain has not forked
            checkFork(evmChainId);

            // emit an event to notify the user that the transfer is rate limited
            emit OutboundTransferRateLimited(
                msg.sender, sequence, amount, getCurrentOutboundCapacity()
            );

            // queue up and return
            _enqueueOutboundTransfer(
                sequence,
                trimmedAmount,
                recipientChain,
                recipient,
                refundAddress,
                msg.sender,
                transceiverInstructions
            );

            // refund price quote back to sender
            _refundToSender(msg.value);

            // return that the transfer has been enqued
            return true;
        }

        // otherwise, consume the outbound amount
        _consumeOutboundAmount(internalAmount);
        // When sending a transfer, we refill the inbound rate limit for
        // that chain by the same amount (we call this "backflow")
        _backfillInboundAmount(internalAmount, recipientChain);
        return false;
    }

    function _transfer(
        uint64 sequence,
        TrimmedAmount amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        address sender,
        bytes memory transceiverInstructions
    ) internal returns (uint64 msgSequence) {
        // verify chain has not forked
        checkFork(evmChainId);

        (
            address[] memory enabledTransceivers,
            TransceiverStructs.TransceiverInstruction[] memory instructions,
            uint256[] memory priceQuotes,
            uint256 totalPriceQuote
        ) = _prepareForTransfer(recipientChain, transceiverInstructions);

        // push it on the stack again to avoid a stack too deep error
        uint64 seq = sequence;

        TransceiverStructs.NativeTokenTransfer memory ntt = _prepareNativeTokenTransfer(
            amount, recipient, recipientChain, seq, sender, refundAddress
        );

        // construct the NttManagerMessage payload
        bytes memory encodedNttManagerPayload = TransceiverStructs.encodeNttManagerMessage(
            TransceiverStructs.NttManagerMessage(
                bytes32(uint256(seq)),
                toWormholeFormat(sender),
                TransceiverStructs.encodeNativeTokenTransfer(ntt)
            )
        );

        // push onto the stack again to avoid stack too deep error
        uint16 destinationChain = recipientChain;

        // send the message
        _sendMessageToTransceivers(
            recipientChain,
            refundAddress,
            _getPeersStorage()[destinationChain].peerAddress,
            priceQuotes,
            instructions,
            enabledTransceivers,
            encodedNttManagerPayload
        );

        // push it on the stack again to avoid a stack too deep error
        TrimmedAmount amt = amount;

        emit TransferSent(
            recipient,
            refundAddress,
            amt.untrim(tokenDecimals()),
            totalPriceQuote,
            destinationChain,
            seq
        );

        emit TransferSent(
            TransceiverStructs._nttManagerMessageDigest(chainId, encodedNttManagerPayload)
        );

        // return the sequence number
        return seq;
    }

    /// @dev Override this function to provide an additional payload on the NativeTokenTransfer
    /// For integrator flexibility, this function is *not* marked pure or view
    /// @param amount TrimmedAmount of the transfer
    /// @param recipient The recipient address
    /// @param recipientChain The Wormhole chain ID for the destination
    /// @param - The sequence number for the manager message (unused, provided for overriding integrators)
    /// @param - The sender of the funds (unused, provided for overriding integrators). If releasing
    /// @param - The address on the destination chain to which the refund of unused gas will be paid
    /// queued transfers, when rate limiting is used, then this value could be different from msg.sender.
    /// @return - The TransceiverStructs.NativeTokenTransfer struct
    function _prepareNativeTokenTransfer(
        TrimmedAmount amount,
        bytes32 recipient,
        uint16 recipientChain,
        uint64, // sequence
        address, // sender
        bytes32 // refundAddress
    ) internal virtual returns (TransceiverStructs.NativeTokenTransfer memory) {
        return TransceiverStructs.NativeTokenTransfer(
            amount, toWormholeFormat(token), recipient, recipientChain, ""
        );
    }

    function _mintOrUnlockToRecipient(
        bytes32 digest,
        address recipient,
        TrimmedAmount amount,
        bool cancelled
    ) internal {
        // verify chain has not forked
        checkFork(evmChainId);

        // calculate proper amount of tokens to unlock/mint to recipient
        // untrim the amount
        uint256 untrimmedAmount = amount.untrim(tokenDecimals());

        if (cancelled) {
            emit OutboundTransferCancelled(uint256(digest), recipient, untrimmedAmount);
        } else {
            emit TransferRedeemed(digest);
        }

        if (mode == Mode.LOCKING) {
            // unlock tokens to the specified recipient
            IERC20(token).safeTransfer(recipient, untrimmedAmount);
        } else if (mode == Mode.BURNING) {
            // mint tokens to the specified recipient
            INttToken(token).mint(recipient, untrimmedAmount);
        } else {
            revert InvalidMode(uint8(mode));
        }
    }

    function tokenDecimals() public view override(INttManager, RateLimiter) returns (uint8) {
        (bool success, bytes memory queriedDecimals) =
            token.staticcall(abi.encodeWithSignature("decimals()"));

        if (!success) {
            revert StaticcallFailed();
        }

        return abi.decode(queriedDecimals, (uint8));
    }

    // ==================== Internal Helpers ===============================================

    /// @dev Verify that the peer address saved for `sourceChainId` matches the `peerAddress`.
    function _verifyPeer(uint16 sourceChainId, bytes32 peerAddress) internal view {
        if (_getPeersStorage()[sourceChainId].peerAddress != peerAddress) {
            revert InvalidPeer(sourceChainId, peerAddress);
        }
    }

    function _trimTransferAmount(
        uint256 amount,
        uint16 toChain
    ) internal view returns (TrimmedAmount) {
        uint8 toDecimals = _getPeersStorage()[toChain].tokenDecimals;

        if (toDecimals == 0) {
            revert InvalidPeerDecimals();
        }

        TrimmedAmount trimmedAmount;
        {
            uint8 fromDecimals = tokenDecimals();
            trimmedAmount = amount.trim(fromDecimals, toDecimals);
            // don't deposit dust that can not be bridged due to the decimal shift
            uint256 newAmount = trimmedAmount.untrim(fromDecimals);
            if (amount != newAmount) {
                revert TransferAmountHasDust(amount, amount - newAmount);
            }
        }

        return trimmedAmount;
    }

    function _getTokenBalanceOf(
        address tokenAddr,
        address accountAddr
    ) internal view returns (uint256) {
        (bool success, bytes memory queriedBalance) =
            tokenAddr.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, accountAddr));

        if (!success) {
            revert StaticcallFailed();
        }

        return abi.decode(queriedBalance, (uint256));
    }
}
