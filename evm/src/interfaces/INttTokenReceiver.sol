// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

/// @title INttTokenReceiver
/// @notice Interface for contracts that want to receive NTT tokens with additional payload
/// @dev Contracts implementing this interface can receive tokens with custom data
///      and execute logic based on that data.
interface INttTokenReceiver {
    /// @notice Handle the receipt of NTT tokens with additional payload
    /// @dev This function is called after tokens have been minted/unlocked to the recipient.
    ///
    ///      SECURITY CRITICAL: Implementations MUST verify that msg.sender is the trusted
    ///      MultiTokenNtt contract to prevent unauthorized calls. Example:
    ///      ```solidity
    ///      require(msg.sender == TRUSTED_MULTITOKENNTT_CONTRACT, "Unauthorized caller");
    ///      ```
    /// @dev If this function reverts, the entire token transfer is reverted. Thus, it is
    ///      better for the handler to gracefully handle errors and not revert.
    ///      If the function reverts due to a temporary issue (such as waiting
    ///      for some other event to happen first), the sender can retry the transfer.
    ///
    /// @param token The address of the token that was received
    /// @param from The original sender of the tokens (on the source chain)
    /// @param amount The amount of tokens received (after decimal normalization)
    /// @param payload The additional payload data sent with the transfer
    /// @param sourceChain The Wormhole chain ID of the source chain
    /// @param sourceAddress The address of the sender on the source chain (32-byte format)
    function onNttTokenReceived(
        address token,
        address from,
        uint256 amount,
        bytes calldata payload,
        uint16 sourceChain,
        bytes32 sourceAddress
    ) external;
}

/// @title INttTokenReceiverErrors
/// @notice Error definitions for INttTokenReceiver functionality
interface INttTokenReceiverErrors {
    /// @notice Thrown when the callback to the recipient contract fails
    error NttTokenReceiverCallFailed(address recipient);

    /// @notice Thrown when additional payload is too large to encode
    error PayloadTooLong(uint256 length);
}
