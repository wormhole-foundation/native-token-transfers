// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

// TODO: is there an official interface for this? some tokens have a different burn
// signature from the standard ERC20Burnable
interface IERC20Burnable2 {
    function burn(address from, uint256 amount) external;
}
