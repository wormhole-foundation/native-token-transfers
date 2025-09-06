// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/Utils.sol";

import "../libraries/TransceiverStructs.sol";
import "../libraries/PausableOwnable.sol";
import "../libraries/external/ReentrancyGuardUpgradeable.sol";
import "../libraries/Implementation.sol";

import {GenericTransceiver} from "./GenericTransceiver.sol";

import "../interfaces/INttManager.sol";
import "../interfaces/ITransceiver.sol";

abstract contract Transceiver is GenericTransceiver {
    address public immutable nttManagerToken;

    constructor(
        address _nttManager
    ) {
        nttManagerToken = INttManager(_nttManager).token();
    }

    function _checkImmutables() internal view virtual override {
        super._checkImmutables();
        assert(this.nttManagerToken() == nttManagerToken);
    }

    function getNttManagerToken() public view virtual returns (address) {
        return nttManagerToken;
    }
}
