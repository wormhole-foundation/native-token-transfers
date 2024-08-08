// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../libraries/TrimmedAmount.sol";
import "./TransceiverHelpers.sol";
import "openzeppelin-contracts/contracts/utils/math/SafeCast.sol";

library RateLimitLib {
    using TrimmedAmountLib for TrimmedAmount;

    /// @notice The new capacity cannot exceed the limit.
    /// @dev Selector 0x0f85ba52.
    /// @param newCurrentCapacity The new current capacity.
    /// @param newLimit The new limit.
    error CapacityCannotExceedLimit(TrimmedAmount newCurrentCapacity, TrimmedAmount newLimit);

    /// @notice Parameters used in determining rate limits and queuing.
    /// @dev
    ///    - limit: current rate limit value.
    ///    - currentCapacity: the current capacity left.
    ///    - lastTxTimestamp: the timestamp of when the
    ///                       capacity was previously consumption.
    struct RateLimitParams {
        TrimmedAmount limit;
        TrimmedAmount currentCapacity;
        uint64 lastTxTimestamp;
    }

    function setLimit(
        RateLimitParams storage rateLimitParams,
        TrimmedAmount limit,
        uint64 rateLimitDuration
    ) internal {
        TrimmedAmount oldLimit = rateLimitParams.limit;
        if (oldLimit.isNull()) {
            rateLimitParams.currentCapacity = limit;
        } else {
            TrimmedAmount currentCapacity = getCurrentCapacity(rateLimitParams, rateLimitDuration);
            rateLimitParams.currentCapacity =
                calculateNewCurrentCapacity(limit, oldLimit, currentCapacity);
        }
        rateLimitParams.limit = limit;
        rateLimitParams.lastTxTimestamp = uint64(block.timestamp);
    }

    function getCurrentCapacity(
        RateLimitParams storage rateLimitParams,
        uint64 rateLimitDuration
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

    function calculateNewCurrentCapacity(
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

    function consumeAmount(
        RateLimitParams storage rateLimitParams,
        TrimmedAmount amount,
        uint64 rateLimitDuration
    ) internal {
        if (rateLimitDuration == 0) return;
        TrimmedAmount capacity = getCurrentCapacity(rateLimitParams, rateLimitDuration);
        rateLimitParams.lastTxTimestamp = uint64(block.timestamp);
        rateLimitParams.currentCapacity = capacity - amount;
    }

    /// @dev Refills the capacity by the given amount.
    /// This is used to replenish the capacity via backflows.
    function backfillAmount(
        RateLimitParams storage rateLimitParams,
        TrimmedAmount amount,
        uint64 rateLimitDuration
    ) internal {
        if (rateLimitDuration == 0) return;
        TrimmedAmount capacity = getCurrentCapacity(rateLimitParams, rateLimitDuration);
        rateLimitParams.lastTxTimestamp = uint64(block.timestamp);
        rateLimitParams.currentCapacity = capacity.saturatingAdd(amount).min(rateLimitParams.limit);
    }

    function isAmountRateLimited(
        RateLimitParams storage rateLimitParams,
        TrimmedAmount amount,
        uint64 rateLimitDuration
    ) internal view returns (bool) {
        if (rateLimitDuration == 0) return false;
        TrimmedAmount capacity = getCurrentCapacity(rateLimitParams, rateLimitDuration);
        return capacity < amount;
    }
}
