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

    /// @notice Receive a message via the GMP manager.
    /// @dev The GMP manager performs verification and replay protection.
    /// @dev `data` is the payload of the message, which is not necessarily
    ///       unique. `digest` is a unique identifier for the message, which commits
    ///       to metadata not directly included in `data`.
    ///       When an integrator wants to uniquely identify a message, they should
    ///       use `digest` instead of `data`.
    function receiveMessage(
        bytes32 digest,
        uint16 sourceChainId,
        bytes32 sender,
        bytes calldata data
    ) external onlyGmpManager {
        _receiveMessage(digest, sourceChainId, sender, data);
    }

    function _receiveMessage(
        bytes32 digest,
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
