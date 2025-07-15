// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

interface INttToken {
    /// @notice Error when the caller is not the minter.
    /// @dev Selector 0x5fb5729e.
    /// @param caller The caller of the function.
    error CallerNotMinter(address caller);

    /// @notice Error when the minter is the zero address.
    /// @dev Selector 0x04a208c7.
    error InvalidMinterZeroAddress();

    /// @notice Error when insufficient balance to burn the amount.
    /// @dev Selector 0xcf479181.
    /// @param balance The balance of the account.
    /// @param amount The amount to burn.
    error InsufficientBalance(uint256 balance, uint256 amount);

    /// @notice The minter has been changed.
    /// @dev Topic0
    ///      0x0b5e7be615a67a819aff3f47c967d1535cead1b98db60fafdcbf22dcaa8fa5a9.
    /// @param newMinter The new minter.
    event NewMinter(address previousMinter, address newMinter);

    // NOTE: the `mint` method is not present in the standard ERC20 interface.
    //       If using NTT in hub-and-spoke mode, this function is required in the token contract for all spoke chains.
    //       If using NTT in burn-and-mint mode, this function is required in the token contract for all chains.
    function mint(address account, uint256 amount) external;

    // NOTE: the `setMinter` method is not present in the standard ERC20 interface.
    //       This is not a required function for integration with NTT. It is recommended to provide flexibility to change the minter in the future,
    //       or allow for setting multiple token minter addresses.
    //       There are also other legitimate ways to implement minter management, such as using role-based access control or a custom approach,
    //       as opposed to the example of using a single setter that's presented here.
    function setMinter(
        address newMinter
    ) external;

    // NOTE: NttTokens in `burn` mode require the `burn` method to be present.
    //       This method is not present in the standard ERC20 interface, but is
    //       found in the `ERC20Burnable` interface.
    function burn(
        uint256 amount
    ) external;
}
