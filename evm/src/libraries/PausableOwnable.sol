// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "./PausableUpgradeable.sol";
import "./external/OwnableUpgradeable.sol";

abstract contract PausableOwnable is PausableUpgradeable, OwnableUpgradeable {
    /*
     * @dev Modifier to allow only the Pauser and the Owner to access pausing functionality
     */
    modifier onlyOwnerOrPauser() {
        _checkOwnerOrPauser(owner());
        _;
    }

    /*
     * @dev Modifier to allow only the Pauser to access some functionality
     */
    function _checkOwnerOrPauser(
        address owner
    ) internal view {
        if (pauser() != msg.sender && owner != msg.sender) {
            revert InvalidPauser(msg.sender);
        }
    }

    function __PausedOwnable_init(address initialPauser, address owner) internal onlyInitializing {
        __Context_init();
        __Paused_init(initialPauser);
        __Ownable_init(owner);
    }

    /**
     * @dev Transfers the ability to pause to a new account (`newPauser`).
     */
    function transferPauserCapability(
        address newPauser
    ) public virtual onlyOwnerOrPauser {
        PauserStorage storage $ = _getPauserStorage();
        address oldPauser = $._pauser;
        $._pauser = newPauser;
        emit PauserTransferred(oldPauser, newPauser);
    }
}
