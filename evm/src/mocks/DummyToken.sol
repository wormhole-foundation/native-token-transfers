// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Upgrade.sol";

contract DummyToken is ERC20, ERC1967Upgrade {
    constructor() ERC20("DummyToken", "DTKN") {}

    // NOTE: this is purposefully not called mint() to so we can test that in
    // locking mode the NttManager contract doesn't call mint (or burn)
    function mintDummy(
        address to,
        uint256 amount
    ) public {
        _mint(to, amount);
    }

    function mint(
        address,
        uint256
    ) public virtual {
        revert("Locking nttManager should not call 'mint()'");
    }

    function burnFrom(
        address,
        uint256
    ) public virtual {
        revert("No nttManager should call 'burnFrom()'");
    }

    function burn(
        address,
        uint256
    ) public virtual {
        revert("Locking nttManager should not call 'burn()'");
    }

    function upgrade(
        address newImplementation
    ) public {
        _upgradeTo(newImplementation);
    }
}

contract DummyTokenMintAndBurn is DummyToken {
    function mint(
        address to,
        uint256 amount
    ) public override {
        // TODO - add access control here?
        _mint(to, amount);
    }

    function burn(
        uint256 amount
    ) public {
        // TODO - add access control here?
        _burn(msg.sender, amount);
    }
}

contract DummyTokenDifferentDecimals is DummyTokenMintAndBurn {
    uint8 private immutable _decimals;

    constructor(
        uint8 newDecimals
    ) {
        _decimals = newDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

contract DummyTokenBroken is DummyToken {
    function decimals() public pure override returns (uint8) {
        revert("broken decimals");
    }

    function balanceOf(
        address
    ) public pure override returns (uint256) {
        revert("broken balanceOf");
    }
}
