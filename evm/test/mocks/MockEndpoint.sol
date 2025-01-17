// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.19;

import "example-messaging-endpoint/evm/src/Endpoint.sol";
import "example-messaging-endpoint/evm/src/libraries/AdapterInstructions.sol";

contract MockEndpoint is Endpoint {
    constructor(
        uint16 _chainId
    ) Endpoint(_chainId) {}

    function createAdapterInstructions() public pure returns (bytes memory encoded) {
        AdapterInstructions.Instruction[] memory insts = new AdapterInstructions.Instruction[](0);
        encoded = AdapterInstructions.encodeInstructions(insts);
    }
}
