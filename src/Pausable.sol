// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.8 <0.9.0;

/**
 * @dev Contact Module that allows children to implement logic to pause and unpause the contract.
 * This is based on the OpenZeppelin Pausable contract but makes use of deterministic storage slots
 * and the EVM native word size to optimize gas costs.
 *
 * The `whenPaused` and `whenNotPaused` modifiers are used to
 * execute code based on the current state of the contract.
 *
 */
import {Initializable} from "./libraries/external/Initializable.sol";

// TODO: pauser should NOT be zero
// Check this in a test
// follow OpenZeppelin's OwnableUpgradeable contract
abstract contract Pausable is Initializable {
    // /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    // struct PauserStorage {
    //     address _pauser;
    // }

    /// NOTE: use uint256 to save on gas because it is the native word size of the EVM
    /// it is cheaper than using a bool because modifying a boolean value requires an extra SLOAD
    uint256 private constant NOT_PAUSED = 1;
    uint256 private constant PAUSED = 2;

    /**
     * @dev Contract is not paused, functionality is unblocked
     */
    error RequireContractIsNotPaused();
    /**
     * @dev Contract state is paused, blocking
     */
    error RequireContractIsPaused();
    // @dev Storage slot with the pause flag, this is managed by the `Pause` struct

    struct PauseStorage {
        uint256 _pauseFlag;
    }

    // @dev Emitted when the contract is paused
    event Paused(bool paused);
    event NotPaused(bool notPaused);

    bytes32 public constant PAUSE_SLOT = bytes32(uint256(keccak256("Pause.pauseFlag")) - 1);

    function _getPauseStorage() private pure returns (PauseStorage storage $) {
        uint256 slot = uint256(PAUSE_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _setPauseStorage(uint256 pauseFlag) internal {
        _getPauseStorage()._pauseFlag = pauseFlag;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     * Calling a function when this flag is set to `PAUSED` will cause the transaction to revert.
     */
    modifier whenNotPaused() {
        if (_isPaused()) {
            revert RequireContractIsNotPaused();
        }
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     * Calling a function when this flag is set to `PAUSED` will cause the transaction to revert.
     */
    modifier whenPaused() {
        if (!_isPaused()) {
            revert RequireContractIsPaused();
        }
        _;
    }

    function __Paused_init() internal onlyInitializing {
        __Paused_init_unchained();
    }

    function __Paused_init_unchained() internal onlyInitializing {
        PauseStorage storage $ = _getPauseStorage();
        $._pauseFlag = NOT_PAUSED;
    }

    /**
     * @dev pauses the function and emits the `Paused` event
     */
    function _pause() internal virtual whenNotPaused {
        // this can only be set to PAUSED when the state is NOTPAUSED
        _setPauseStorage(PAUSED);
        emit Paused(true);
    }

    /**
     * @dev unpauses the function
     */
    function _unpause() internal virtual whenPaused {
        // this can only be set to NOTPAUSED when the state is PAUSED
        _setPauseStorage(NOT_PAUSED);
        emit NotPaused(false);
    }

    /**
     * @dev Returns true if the method is paused, and false otherwise.
     */
    function _isPaused() public view returns (bool) {
        PauseStorage storage $ = _getPauseStorage();
        return $._pauseFlag == PAUSED;
    }
}