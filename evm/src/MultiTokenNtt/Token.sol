// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "../interfaces/INttToken.sol";

import
    "openzeppelin-contracts-upgradeable/contracts/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import
    "openzeppelin-contracts-upgradeable/contracts/token/ERC20/extensions/draft-ERC20PermitUpgradeable.sol";

contract Token is ERC20BurnableUpgradeable, ERC20PermitUpgradeable, INttToken {
    address public minter;
    uint8 _decimals;

    function initialize(
        string memory name,
        string memory symbol,
        uint8 __decimals
    ) public initializer {
        __ERC20_init(name, symbol);
        __ERC20Permit_init(name);
        _decimals = __decimals;
        minter = msg.sender;
    }

    function burn(
        uint256 amount
    ) public override(ERC20BurnableUpgradeable, INttToken) {
        ERC20BurnableUpgradeable.burn(amount);
    }

    function mint(address account, uint256 amount) public override(INttToken) onlyMinter {
        _mint(account, amount);
    }

    function setMinter(
        address newMinter
    ) public override(INttToken) onlyMinter {
        if (newMinter == address(0)) revert InvalidMinterZeroAddress();
        emit NewMinter(minter, newMinter);
        minter = newMinter;
    }

    function decimals() public view override(ERC20Upgradeable) returns (uint8) {
        return _decimals;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert CallerNotMinter(msg.sender);
        _;
    }
}
