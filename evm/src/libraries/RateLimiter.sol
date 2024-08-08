// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IRateLimiter.sol";
import "../interfaces/IRateLimiterEvents.sol";
import "./TransceiverHelpers.sol";
import "./TransceiverStructs.sol";
import "../libraries/TrimmedAmount.sol";
import "./RateLimitLib.sol";

abstract contract RateLimiter is IRateLimiter, IRateLimiterEvents {
    using TrimmedAmountLib for TrimmedAmount;
    using RateLimitLib for RateLimitLib.RateLimitParams;

    /// @dev The duration (in seconds) it takes for the limits to fully replenish.
    uint64 public immutable rateLimitDuration;

    /// =============== STORAGE ===============================================

    bytes32 private constant OUTBOUND_LIMIT_PARAMS_SLOT =
        bytes32(uint256(keccak256("ntt.outboundLimitParams")) - 1);

    bytes32 private constant OUTBOUND_QUEUE_SLOT =
        bytes32(uint256(keccak256("ntt.outboundQueue")) - 1);

    bytes32 private constant INBOUND_LIMIT_PARAMS_SLOT =
        bytes32(uint256(keccak256("ntt.inboundLimitParams")) - 1);

    bytes32 private constant INBOUND_QUEUE_SLOT =
        bytes32(uint256(keccak256("ntt.inboundQueue")) - 1);

    function _getOutboundLimitParamsStorage()
        internal
        pure
        returns (RateLimitLib.RateLimitParams storage $)
    {
        uint256 slot = uint256(OUTBOUND_LIMIT_PARAMS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getOutboundQueueStorage()
        internal
        pure
        returns (mapping(uint64 => OutboundQueuedTransfer) storage $)
    {
        uint256 slot = uint256(OUTBOUND_QUEUE_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getInboundLimitParamsStorage()
        internal
        pure
        returns (mapping(uint16 => RateLimitLib.RateLimitParams) storage $)
    {
        uint256 slot = uint256(INBOUND_LIMIT_PARAMS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getInboundQueueStorage()
        internal
        pure
        returns (mapping(bytes32 => InboundQueuedTransfer) storage $)
    {
        uint256 slot = uint256(INBOUND_QUEUE_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    constructor(uint64 _rateLimitDuration, bool _skipRateLimiting) {
        if (
            _rateLimitDuration == 0 && !_skipRateLimiting
                || _rateLimitDuration != 0 && _skipRateLimiting
        ) {
            revert UndefinedRateLimiting();
        }

        rateLimitDuration = _rateLimitDuration;
    }

    function _setOutboundLimit(
        TrimmedAmount limit
    ) internal virtual {
        RateLimitLib.RateLimitParams storage rateLimitParams = _getOutboundLimitParamsStorage();
        TrimmedAmount oldLimit = rateLimitParams.limit;
        uint8 decimals = tokenDecimals();
        _getOutboundLimitParamsStorage().setLimit(limit, rateLimitDuration);
        emit OutboundTransferLimitUpdated(oldLimit.untrim(decimals), limit.untrim(decimals));
    }

    function getOutboundLimitParams()
        public
        pure
        virtual
        returns (RateLimitLib.RateLimitParams memory)
    {
        return _getOutboundLimitParamsStorage();
    }

    function getCurrentOutboundCapacity() public view virtual returns (uint256) {
        TrimmedAmount trimmedCapacity =
            _getOutboundLimitParamsStorage().getCurrentCapacity(rateLimitDuration);
        uint8 decimals = tokenDecimals();
        return trimmedCapacity.untrim(decimals);
    }

    function getOutboundQueuedTransfer(
        uint64 queueSequence
    ) public view virtual returns (OutboundQueuedTransfer memory) {
        return _getOutboundQueueStorage()[queueSequence];
    }

    function _setInboundLimit(TrimmedAmount limit, uint16 chainId_) internal virtual {
        RateLimitLib.RateLimitParams storage rateLimitParams =
            _getInboundLimitParamsStorage()[chainId_];
        TrimmedAmount oldLimit = rateLimitParams.limit;
        uint8 decimals = tokenDecimals();
        _getInboundLimitParamsStorage()[chainId_].setLimit(limit, rateLimitDuration);
        emit InboundTransferLimitUpdated(
            chainId_, oldLimit.untrim(decimals), limit.untrim(decimals)
        );
    }

    function getInboundLimitParams(
        uint16 chainId_
    ) public view virtual returns (RateLimitLib.RateLimitParams memory) {
        return _getInboundLimitParamsStorage()[chainId_];
    }

    function getCurrentInboundCapacity(
        uint16 chainId_
    ) public view virtual returns (uint256) {
        TrimmedAmount trimmedCapacity =
            _getInboundLimitParamsStorage()[chainId_].getCurrentCapacity(rateLimitDuration);
        uint8 decimals = tokenDecimals();
        return trimmedCapacity.untrim(decimals);
    }

    function getInboundQueuedTransfer(
        bytes32 digest
    ) public view virtual returns (InboundQueuedTransfer memory) {
        return _getInboundQueueStorage()[digest];
    }

    function _consumeOutboundAmount(
        TrimmedAmount amount
    ) internal {
        if (rateLimitDuration == 0) return;
        _getOutboundLimitParamsStorage().consumeAmount(amount, rateLimitDuration);
    }

    function _backfillOutboundAmount(
        TrimmedAmount amount
    ) internal {
        if (rateLimitDuration == 0) return;
        _getOutboundLimitParamsStorage().backfillAmount(amount, rateLimitDuration);
    }

    function _consumeInboundAmount(TrimmedAmount amount, uint16 chainId_) internal {
        if (rateLimitDuration == 0) return;
        _getInboundLimitParamsStorage()[chainId_].consumeAmount(amount, rateLimitDuration);
    }

    function _backfillInboundAmount(TrimmedAmount amount, uint16 chainId_) internal {
        if (rateLimitDuration == 0) return;
        _getInboundLimitParamsStorage()[chainId_].backfillAmount(amount, rateLimitDuration);
    }

    function _isOutboundAmountRateLimited(
        TrimmedAmount amount
    ) internal view returns (bool) {
        return rateLimitDuration != 0
            ? _getOutboundLimitParamsStorage().isAmountRateLimited(amount, rateLimitDuration)
            : false;
    }

    function _isInboundAmountRateLimited(
        TrimmedAmount amount,
        uint16 chainId_
    ) internal view returns (bool) {
        return rateLimitDuration != 0
            ? _getInboundLimitParamsStorage()[chainId_].isAmountRateLimited(amount, rateLimitDuration)
            : false;
    }

    function _enqueueOutboundTransfer(
        uint64 sequence,
        TrimmedAmount amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        address senderAddress,
        bytes memory transceiverInstructions
    ) internal {
        _getOutboundQueueStorage()[sequence] = OutboundQueuedTransfer({
            amount: amount,
            recipientChain: recipientChain,
            recipient: recipient,
            refundAddress: refundAddress,
            txTimestamp: uint64(block.timestamp),
            sender: senderAddress,
            transceiverInstructions: transceiverInstructions
        });

        emit OutboundTransferQueued(sequence);
    }

    function _enqueueInboundTransfer(
        bytes32 digest,
        TrimmedAmount amount,
        address recipient
    ) internal {
        _getInboundQueueStorage()[digest] = InboundQueuedTransfer({
            amount: amount,
            recipient: recipient,
            txTimestamp: uint64(block.timestamp)
        });

        emit InboundTransferQueued(digest);
    }

    function tokenDecimals() public view virtual returns (uint8);
}
