// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IWETH.sol";
import "./NttManager.sol";

/// @title NttManagerWethUnwrap
/// @author Wormhole Project Contributors.
/// @notice The NttManagerWethUnwrap contract is an implementation of
///         NttManager that unwraps WETH when unlocking.
///
/// @dev    All of the developer notes from `NttManager` apply here.
contract NttManagerWethUnwrap is NttManager {
    // address of WETH on this chain
    IWETH public immutable weth;

    constructor(
        address _token,
        Mode _mode,
        uint16 _chainId,
        uint64 _rateLimitDuration,
        bool _skipRateLimiting
    ) NttManager(_token, _mode, _chainId, _rateLimitDuration, _skipRateLimiting) {
        weth = IWETH(token);
    }

    // ==================== Overridden NttManager Implementations =================================

    function _unlockTokens(address recipient, uint256 untrimmedAmount) internal override {
        // withdraw weth and send to the recipient
        weth.withdraw(untrimmedAmount);
        (bool success,) = payable(recipient).call{value: untrimmedAmount}("");
        require(success, "Failed to transfer to recipient");
    }
}
