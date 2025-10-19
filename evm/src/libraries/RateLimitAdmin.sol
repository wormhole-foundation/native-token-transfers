// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "./TokenId.sol";
import "./RateLimitLib.sol";
import "./TrimmedAmount.sol";

/// @title RateLimitAdmin
/// @notice External library for admin-only rate limiting operations
/// @dev This library is deployed separately to reduce main contract size.
///      Admin functions are called infrequently, so the DELEGATECALL overhead is acceptable.
library RateLimitAdmin {
    using TrimmedAmountLib for TrimmedAmount;
    using RateLimitLib for RateLimitLib.RateLimitParams;

    function setLimit(
        RateLimitLib.RateLimitParams storage self,
        TrimmedAmount limit,
        uint64 rateLimitDuration
    ) public {
        self.setLimit(limit, rateLimitDuration);
    }
}
