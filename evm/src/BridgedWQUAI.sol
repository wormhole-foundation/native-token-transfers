// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.19;

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/access/Ownable.sol";
import "./interfaces/INttToken.sol";

/**
 * @title BridgedWQUAI
 * @dev ERC20 token representing WQUAI on destination chains (like Sepolia)
 * Implements INttToken interface for NTT Manager compatibility
 */
contract BridgedWQUAI is ERC20, Ownable, INttToken {
    address public minter;

    modifier onlyMinter() {
        if (msg.sender != minter) {
            revert CallerNotMinter(msg.sender);
        }
        _;
    }

    constructor() ERC20("Bridged WQUAI", "WQUAI") {}
    
    /**
     * @dev Mint tokens (only minter can call this - will be NTT Manager)
     * @param account Address to mint tokens to
     * @param amount Amount to mint
     */
    function mint(address account, uint256 amount) external onlyMinter {
        _mint(account, amount);
    }
    
    /**
     * @dev Set the minter address (only owner can call this initially)
     * @param newMinter The new minter address (will be NTT Manager)
     */
    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) {
            revert InvalidMinterZeroAddress();
        }
        address previousMinter = minter;
        minter = newMinter;
        emit NewMinter(previousMinter, newMinter);
    }
    
    /**
     * @dev Burn tokens from caller (when sending to source chain)
     * @param amount Amount to burn
     */
    function burn(uint256 amount) external {
        uint256 balance = balanceOf(msg.sender);
        if (balance < amount) {
            revert InsufficientBalance(balance, amount);
        }
        _burn(msg.sender, amount);
    }
    
    /**
     * @dev Returns the number of decimals (18 to match WQUAI on Quai)
     */
    function decimals() public pure override returns (uint8) {
        return 18;
    }
}