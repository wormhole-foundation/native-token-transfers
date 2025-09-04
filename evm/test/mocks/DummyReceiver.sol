// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../../src/GmpManager/GmpIntegration.sol";
import "../../src/interfaces/IGmpManager.sol";

contract DummyReceiver is GmpIntegration {
    uint256 public received;

    constructor(
        IGmpManager _gmpManager
    ) GmpIntegration(_gmpManager) {}

    function _receiveMessage(
        uint16, /* sourceChainId */
        bytes32, /* sender */
        bytes calldata data
    ) internal override {
        uint256 value = abi.decode(data, (uint256));
        received = value;
    }
}
