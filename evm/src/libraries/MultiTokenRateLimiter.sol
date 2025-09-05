// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IMultiTokenRateLimiter.sol";
import "./TokenId.sol";

import "../interfaces/IRateLimiterEvents.sol";
import "./RateLimitLib.sol";
import "./TransceiverHelpers.sol";
import "./TransceiverStructs.sol";
import "./TrimmedAmount.sol";

abstract contract MultiTokenRateLimiter is IMultiTokenRateLimiter, IRateLimiterEvents {
    using TrimmedAmountLib for TrimmedAmount;
    using RateLimitLib for RateLimitLib.RateLimitParams;

    /// @dev The duration (in seconds) it takes for the limits to fully replenish.
    uint64 public immutable rateLimitDuration;

    // Constants for storage slots
    bytes32 private constant OUTBOUND_LIMIT_PARAMS_SLOT =
        bytes32(uint256(keccak256("ntt.multitoken.outboundLimitParams")) - 1);

    // TODO: maybe the queue should only store a commitment to the queue entry?
    // harder to pick up the data (maybe look at logs), but cheaper
    bytes32 private constant OUTBOUND_QUEUE_SLOT =
        bytes32(uint256(keccak256("ntt.multitoken.outboundQueue")) - 1);

    bytes32 private constant INBOUND_LIMIT_PARAMS_SLOT =
        bytes32(uint256(keccak256("ntt.multitoken.inboundLimitParams")) - 1);

    bytes32 private constant INBOUND_QUEUE_SLOT =
        bytes32(uint256(keccak256("ntt.multitoken.inboundQueue")) - 1);

    constructor(uint64 _rateLimitDuration, bool _skipRateLimiting) {
        if (
            _rateLimitDuration == 0 && !_skipRateLimiting
                || _rateLimitDuration != 0 && _skipRateLimiting
        ) {
            revert UndefinedRateLimiting();
        }

        rateLimitDuration = _rateLimitDuration;
    }

    function _getOutboundLimitParamsStorage(
        TokenId memory tokenId
    ) internal pure returns (RateLimitLib.RateLimitParams storage $) {
        // TODO: are these xors safe? they should be, but maybe better to introduce a domain separator?
        bytes32 slot =
            bytes32(uint256(OUTBOUND_LIMIT_PARAMS_SLOT) ^ uint256(keccak256(abi.encode(tokenId))));
        assembly {
            $.slot := slot
        }
    }

    function _getOutboundQueueStorage()
        internal
        pure
        returns (mapping(uint64 => OutboundQueuedTransfer) storage $)
    {
        uint256 slot = uint256(OUTBOUND_QUEUE_SLOT);
        assembly {
            $.slot := slot
        }
    }

    function _getInboundLimitParamsStorage(
        TokenId memory tokenId
    ) internal pure returns (mapping(uint16 => RateLimitLib.RateLimitParams) storage $) {
        bytes32 slot =
            bytes32(uint256(INBOUND_LIMIT_PARAMS_SLOT) ^ uint256(keccak256(abi.encode(tokenId))));
        assembly {
            $.slot := slot
        }
    }

    function _getInboundQueueStorage()
        internal
        pure
        returns (mapping(bytes32 => InboundQueuedTransfer) storage $)
    {
        uint256 slot = uint256(INBOUND_QUEUE_SLOT);
        assembly {
            $.slot := slot
        }
    }

    function _setOutboundLimit(TokenId memory tokenId, TrimmedAmount limit) internal {
        _getOutboundLimitParamsStorage(tokenId).setLimit(limit, rateLimitDuration);
    }

    function getOutboundLimitParams(
        TokenId memory tokenId
    ) public pure returns (RateLimitLib.RateLimitParams memory) {
        return _getOutboundLimitParamsStorage(tokenId);
    }

    function getCurrentOutboundCapacity(
        TokenId memory tokenId
    ) public view override returns (uint256) {
        RateLimitLib.RateLimitParams storage params = _getOutboundLimitParamsStorage(tokenId);
        TrimmedAmount trimmedCapacity = params.getCurrentCapacity(rateLimitDuration);
        uint8 decimals = _tokenDecimals(tokenId);
        return trimmedCapacity.untrim(decimals);
    }

    function getOutboundQueuedTransfer(
        uint64 queueSequence
    ) public view override returns (OutboundQueuedTransfer memory) {
        return _getOutboundQueueStorage()[queueSequence];
    }

    function _setInboundLimit(
        TokenId memory tokenId,
        TrimmedAmount limit,
        uint16 chainId_
    ) internal {
        _getInboundLimitParamsStorage(tokenId)[chainId_].setLimit(limit, rateLimitDuration);
    }

    function getInboundLimitParams(
        TokenId memory tokenId,
        uint16 chainId_
    ) public view returns (RateLimitLib.RateLimitParams memory) {
        return _getInboundLimitParamsStorage(tokenId)[chainId_];
    }

    function getCurrentInboundCapacity(
        TokenId memory tokenId,
        uint16 chainId_
    ) public view override returns (uint256) {
        RateLimitLib.RateLimitParams storage params =
            _getInboundLimitParamsStorage(tokenId)[chainId_];
        TrimmedAmount trimmedCapacity = params.getCurrentCapacity(rateLimitDuration);
        uint8 decimals = _tokenDecimals(tokenId);
        return trimmedCapacity.untrim(decimals);
    }

    function getInboundQueuedTransfer(
        bytes32 digest
    ) public view override returns (InboundQueuedTransfer memory) {
        return _getInboundQueueStorage()[digest];
    }

    function _consumeOutboundAmount(TokenId memory tokenId, TrimmedAmount amount) internal {
        if (rateLimitDuration == 0) return;
        _getOutboundLimitParamsStorage(tokenId).consumeAmount(amount, rateLimitDuration);
    }

    function _backfillOutboundAmount(TokenId memory tokenId, TrimmedAmount amount) internal {
        if (rateLimitDuration == 0) return;
        _getOutboundLimitParamsStorage(tokenId).backfillAmount(amount, rateLimitDuration);
    }

    function _consumeInboundAmount(
        TokenId memory tokenId,
        TrimmedAmount amount,
        uint16 chainId_
    ) internal {
        if (rateLimitDuration == 0) return;
        _getInboundLimitParamsStorage(tokenId)[chainId_].consumeAmount(amount, rateLimitDuration);
    }

    function _backfillInboundAmount(
        TokenId memory tokenId,
        TrimmedAmount amount,
        uint16 chainId_
    ) internal {
        if (rateLimitDuration == 0) return;
        _getInboundLimitParamsStorage(tokenId)[chainId_].backfillAmount(amount, rateLimitDuration);
    }

    function _isOutboundAmountRateLimited(
        TokenId memory tokenId,
        TrimmedAmount amount
    ) internal view returns (bool) {
        if (rateLimitDuration == 0) return false;
        return
            _getOutboundLimitParamsStorage(tokenId).isAmountRateLimited(amount, rateLimitDuration);
    }

    function _isInboundAmountRateLimited(
        TokenId memory tokenId,
        TrimmedAmount amount,
        uint16 chainId_
    ) internal view returns (bool) {
        if (rateLimitDuration == 0) return false;
        return _getInboundLimitParamsStorage(tokenId)[chainId_].isAmountRateLimited(
            amount, rateLimitDuration
        );
    }

    function _enqueueOutboundTransfer(
        uint64 sequence,
        address token,
        TrimmedAmount amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        address senderAddress,
        bytes memory transceiverInstructions
    ) internal {
        _getOutboundQueueStorage()[sequence] = OutboundQueuedTransfer({
            amount: amount,
            recipientChain: recipientChain,
            recipient: recipient,
            refundAddress: refundAddress,
            txTimestamp: uint64(block.timestamp),
            sender: senderAddress,
            token: token,
            transceiverInstructions: transceiverInstructions
        });

        emit OutboundTransferQueued(sequence);
    }

    function _enqueueInboundTransfer(bytes32 digest, uint16 sourceChainId) internal {
        _getInboundQueueStorage()[digest] = InboundQueuedTransfer({
            txTimestamp: uint64(block.timestamp),
            sourceChainId: sourceChainId
        });

        emit InboundTransferQueued(digest);
    }

    function _tokenDecimals(
        TokenId memory tokenId
    ) internal view virtual returns (uint8);
}
