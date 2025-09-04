// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IGmpManager.sol";

abstract contract GmpIntegration {
    IGmpManager public immutable gmpManager;

    error OnlyGmpManagerAllowed();

    constructor(
        IGmpManager _gmpManager
    ) {
        gmpManager = _gmpManager;
    }

    modifier onlyGmpManager() {
        if (msg.sender != address(gmpManager)) revert OnlyGmpManagerAllowed();
        _;
    }

    function receiveMessage(
        uint16 sourceChainId,
        bytes32 sender,
        bytes calldata data
    ) external onlyGmpManager {
        _receiveMessage(sourceChainId, sender, data);
    }

    function _receiveMessage(
        uint16 sourceChainId,
        bytes32 sender,
        bytes calldata data
    ) internal virtual;

    function _sendMessage(
        uint256 msgValue,
        uint16 targetChain,
        bytes32 callee,
        bytes32 refundAddress,
        uint64 reservedSequence,
        bytes memory data,
        bytes memory transceiverInstructions
    ) internal returns (uint64 sequence) {
        return gmpManager.sendMessage{value: msgValue}(
            targetChain, callee, refundAddress, reservedSequence, data, transceiverInstructions
        );
    }
}
