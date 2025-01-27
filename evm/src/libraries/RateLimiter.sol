// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IRateLimiter.sol";
import "../interfaces/IRateLimiterEvents.sol";
import "./TransceiverHelpers.sol";
import "./TransceiverStructs.sol";
import "../libraries/TrimmedAmount.sol";
import "openzeppelin-contracts/contracts/utils/math/SafeCast.sol";

abstract contract RateLimiter is IRateLimiter, IRateLimiterEvents {
    using TrimmedAmountLib for TrimmedAmount;

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

    function _getOutboundLimitParamsStorage() internal pure returns (RateLimitParams storage $) {
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
        returns (mapping(uint16 => RateLimitParams) storage $)
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
            (_rateLimitDuration == 0 && !_skipRateLimiting)
                || (_rateLimitDuration != 0 && _skipRateLimiting)
        ) {
            revert UndefinedRateLimiting();
        }

        rateLimitDuration = _rateLimitDuration;
    }

    function _setLimit(TrimmedAmount limit, RateLimitParams storage rateLimitParams) internal {
        TrimmedAmount oldLimit = rateLimitParams.limit;
        if (oldLimit.isNull()) {
            rateLimitParams.currentCapacity = limit;
        } else {
            TrimmedAmount currentCapacity = _getCurrentCapacity(rateLimitParams);
            rateLimitParams.currentCapacity =
                _calculateNewCurrentCapacity(limit, oldLimit, currentCapacity);
        }
        rateLimitParams.limit = limit;

        rateLimitParams.lastTxTimestamp = uint64(block.timestamp);
    }

    function _setOutboundLimit(
        TrimmedAmount limit
    ) internal virtual {
        RateLimitParams storage rateLimitParams = _getOutboundLimitParamsStorage();
        TrimmedAmount oldLimit = rateLimitParams.limit;
        uint8 decimals = tokenDecimals();
        _setLimit(limit, rateLimitParams);
        emit OutboundTransferLimitUpdated(oldLimit.untrim(decimals), limit.untrim(decimals));
    }

    function getOutboundLimitParams() public pure virtual returns (RateLimitParams memory) {
        return _getOutboundLimitParamsStorage();
    }

    function getCurrentOutboundCapacity() public view virtual returns (uint256) {
        TrimmedAmount trimmedCapacity = _getCurrentCapacity(getOutboundLimitParams());
        uint8 decimals = tokenDecimals();
        return trimmedCapacity.untrim(decimals);
    }

    function getOutboundQueuedTransfer(
        uint64 queueSequence
    ) public view virtual returns (OutboundQueuedTransfer memory) {
        return _getOutboundQueueStorage()[queueSequence];
    }

    function _setInboundLimit(TrimmedAmount limit, uint16 chainId_) internal virtual {
        RateLimitParams storage rateLimitParams = _getInboundLimitParamsStorage()[chainId_];
        TrimmedAmount oldLimit = rateLimitParams.limit;
        uint8 decimals = tokenDecimals();
        _setLimit(limit, rateLimitParams);
        emit InboundTransferLimitUpdated(
            chainId_, oldLimit.untrim(decimals), limit.untrim(decimals)
        );
    }

    function getInboundLimitParams(
        uint16 chainId_
    ) public view virtual returns (RateLimitParams memory) {
        return _getInboundLimitParamsStorage()[chainId_];
    }

    function getCurrentInboundCapacity(
        uint16 chainId_
    ) public view virtual returns (uint256) {
        TrimmedAmount trimmedCapacity = _getCurrentCapacity(getInboundLimitParams(chainId_));
        uint8 decimals = tokenDecimals();
        return trimmedCapacity.untrim(decimals);
    }

    function getInboundQueuedTransfer(
        bytes32 digest
    ) public view virtual returns (InboundQueuedTransfer memory) {
        return _getInboundQueueStorage()[digest];
    }

    /**
     * @dev Gets the current capacity for a parameterized rate limits struct
     */
    function _getCurrentCapacity(
        RateLimitParams memory rateLimitParams
    ) internal view returns (TrimmedAmount capacity) {
        // If the rate limit duration is 0 then the rate limiter is skipped
        if (rateLimitDuration == 0) {
            return
                packTrimmedAmount(type(uint64).max, rateLimitParams.currentCapacity.getDecimals());
        }

        // The capacity and rate limit are expressed as trimmed amounts, i.e.
        // 64-bit unsigned integers. The following operations upcast the 64-bit
        // unsigned integers to 256-bit unsigned integers to avoid overflow.
        // Specifically, the calculatedCapacity can overflow the u64 max.
        // For example, if the limit is uint64.max, then the multiplication in calculatedCapacity
        // will overflow when timePassed is greater than rateLimitDuration.
        // Operating on uint256 avoids this issue. The overflow is cancelled out by the min operation,
        // whose second argument is a uint64, so the result can safely be downcast to a uint64.
        unchecked {
            uint256 timePassed = block.timestamp - rateLimitParams.lastTxTimestamp;
            // Multiply (limit * timePassed), then divide by the duration.
            // Dividing first has terrible numerical stability --
            // when rateLimitDuration is close to the limit, there is significant rounding error.
            // We are safe to multiply first, since these numbers are u64 TrimmedAmount types
            // and we're performing arithmetic on u256 words.
            uint256 calculatedCapacity = rateLimitParams.currentCapacity.getAmount()
                + (rateLimitParams.limit.getAmount() * timePassed) / rateLimitDuration;

            uint256 result = min(calculatedCapacity, rateLimitParams.limit.getAmount());
            return packTrimmedAmount(
                SafeCast.toUint64(result), rateLimitParams.currentCapacity.getDecimals()
            );
        }
    }

    /**
     * @dev Updates the current capacity
     *
     * @param newLimit The new limit
     * @param oldLimit The old limit
     * @param currentCapacity The current capacity
     */
    function _calculateNewCurrentCapacity(
        TrimmedAmount newLimit,
        TrimmedAmount oldLimit,
        TrimmedAmount currentCapacity
    ) internal pure returns (TrimmedAmount newCurrentCapacity) {
        TrimmedAmount difference;

        if (oldLimit > newLimit) {
            difference = oldLimit - newLimit;
            newCurrentCapacity = currentCapacity > difference
                ? currentCapacity - difference
                : packTrimmedAmount(0, currentCapacity.getDecimals());
        } else {
            difference = newLimit - oldLimit;
            newCurrentCapacity = currentCapacity + difference;
        }

        if (newCurrentCapacity > newLimit) {
            revert CapacityCannotExceedLimit(newCurrentCapacity, newLimit);
        }
    }

    function _consumeOutboundAmount(
        TrimmedAmount amount
    ) internal {
        if (rateLimitDuration == 0) return;
        _consumeRateLimitAmount(
            amount, _getCurrentCapacity(getOutboundLimitParams()), _getOutboundLimitParamsStorage()
        );
    }

    function _backfillOutboundAmount(
        TrimmedAmount amount
    ) internal {
        if (rateLimitDuration == 0) return;
        _backfillRateLimitAmount(
            amount, _getCurrentCapacity(getOutboundLimitParams()), _getOutboundLimitParamsStorage()
        );
    }

    function _consumeInboundAmount(TrimmedAmount amount, uint16 chainId_) internal {
        if (rateLimitDuration == 0) return;
        _consumeRateLimitAmount(
            amount,
            _getCurrentCapacity(getInboundLimitParams(chainId_)),
            _getInboundLimitParamsStorage()[chainId_]
        );
    }

    function _backfillInboundAmount(TrimmedAmount amount, uint16 chainId_) internal {
        if (rateLimitDuration == 0) return;
        _backfillRateLimitAmount(
            amount,
            _getCurrentCapacity(getInboundLimitParams(chainId_)),
            _getInboundLimitParamsStorage()[chainId_]
        );
    }

    function _consumeRateLimitAmount(
        TrimmedAmount amount,
        TrimmedAmount capacity,
        RateLimitParams storage rateLimitParams
    ) internal {
        rateLimitParams.lastTxTimestamp = uint64(block.timestamp);
        rateLimitParams.currentCapacity = capacity - amount;
    }

    /// @dev Refills the capacity by the given amount.
    /// This is used to replenish the capacity via backflows.
    function _backfillRateLimitAmount(
        TrimmedAmount amount,
        TrimmedAmount capacity,
        RateLimitParams storage rateLimitParams
    ) internal {
        rateLimitParams.lastTxTimestamp = uint64(block.timestamp);
        rateLimitParams.currentCapacity = capacity.saturatingAdd(amount).min(rateLimitParams.limit);
    }

    function _isOutboundAmountRateLimited(
        TrimmedAmount amount
    ) internal view returns (bool) {
        return rateLimitDuration != 0
            ? _isAmountRateLimited(_getCurrentCapacity(getOutboundLimitParams()), amount)
            : false;
    }

    function _isInboundAmountRateLimited(
        TrimmedAmount amount,
        uint16 chainId_
    ) internal view returns (bool) {
        return rateLimitDuration != 0
            ? _isAmountRateLimited(_getCurrentCapacity(getInboundLimitParams(chainId_)), amount)
            : false;
    }

    function _isAmountRateLimited(
        TrimmedAmount capacity,
        TrimmedAmount amount
    ) internal pure returns (bool) {
        return capacity < amount;
    }

    function _enqueueOutboundTransfer(
        uint64 sequence,
        TrimmedAmount amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        address senderAddress,
        bytes memory executorQuote,
        bytes memory relayInstructions,
        bytes memory transceiverInstructions
    ) internal {
        _getOutboundQueueStorage()[sequence] = OutboundQueuedTransfer({
            amount: amount,
            recipientChain: recipientChain,
            recipient: recipient,
            refundAddress: refundAddress,
            txTimestamp: uint64(block.timestamp),
            sender: senderAddress,
            executorQuote: executorQuote,
            relayInstructions: relayInstructions,
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
