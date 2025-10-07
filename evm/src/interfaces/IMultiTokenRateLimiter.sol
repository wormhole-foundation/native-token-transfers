// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../libraries/TokenId.sol";

import "./IRateLimiter.sol";
import "../libraries/TransceiverStructs.sol";
import "../libraries/TrimmedAmount.sol";

interface IMultiTokenRateLimiter {
    /// @notice Not enough capacity to send the transfer.
    /// @dev Selector TODO
    /// @param token The token being transferred.
    /// @param currentCapacity The current capacity.
    /// @param amount The amount of the transfer.
    error NotEnoughCapacity(TokenId token, uint256 currentCapacity, uint256 amount);

    /// @notice Parameters for an outbound queued transfer.
    struct OutboundQueuedTransfer {
        bytes32 recipient;
        // --
        bytes32 refundAddress;
        // --
        address sender; // 20 bytes
        TrimmedAmount amount; // 9 bytes
        uint16 recipientChain; // 2 bytes
        // --
        uint64 txTimestamp; // 8 bytes
        address token; // 20 bytes
        // --
        bytes transceiverInstructions;
    }

    /// @notice Parameters for an inbound queued transfer.
    /// @dev
    ///   - txTimestamp: the timestamp of the transfer.
    ///   - sourceChainId: the chain ID where the transfer originated.
    ///   - transferDigest: first 20 byte of the keccak256 hash of the transfer details.
    /// @dev Other transfer details (amount, token, recipient) are passed when completing the transfer.
    struct InboundQueuedTransfer {
        uint64 txTimestamp; // 8 bytes
        uint16 sourceChainId; // 2 bytes
        bytes20 transferDigest; // 20 bytes
    }

    function getCurrentOutboundCapacity(
        TokenId memory tokenId
    ) external view returns (uint256);

    function getOutboundQueuedTransfer(
        uint64 queueSequence
    ) external view returns (OutboundQueuedTransfer memory);

    function getCurrentInboundCapacity(
        TokenId memory tokenId,
        uint16 chainId
    ) external view returns (uint256);

    function getInboundQueuedTransfer(
        bytes32 digest
    ) external view returns (InboundQueuedTransfer memory);
}
