// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "./NttManager.sol";

/// @title NttManagerNoRateLimiting
/// @author Wormhole Project Contributors.
/// @notice The NttManagerNoRateLimiting contract is an implementation of
///         NttManager that eliminates most of the rate limiting code to
///         free up code space.
///
/// @dev    All of the developer notes from `NttManager` apply here.
contract NttManagerNoRateLimiting is NttManager {
    constructor(
        address _endpoint,
        address _executor,
        address _token,
        Mode _mode,
        uint16 _chainId
    ) NttManager(_endpoint, _executor, _token, _mode, _chainId, 0, true) {}

    // ==================== Override RateLimiter functions =========================

    /// @notice Not used, always returns empty RateLimitParams.
    function getOutboundLimitParams() public pure override returns (RateLimitParams memory) {}

    /// @notice Not used, always returns zero.
    function getCurrentOutboundCapacity() public pure override returns (uint256) {
        return 0;
    }

    /// @notice Not used, always reverts with NotImplemented.
    function getOutboundQueuedTransfer(
        uint64 // queueSequence
    ) public pure override returns (OutboundQueuedTransfer memory) {
        revert NotImplemented();
    }

    /// @notice Not used, always returns empty RateLimitParams.
    function getInboundLimitParams(
        uint16 // chainId_
    ) public pure override returns (RateLimitParams memory) {}

    /// @notice Not used, always returns zero.
    function getCurrentInboundCapacity(
        uint16 // chainId_
    ) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Not used, always reverts with NotImplemented.
    function getInboundQueuedTransfer(
        bytes32 // digest
    ) public pure override returns (InboundQueuedTransfer memory) {
        revert NotImplemented();
    }

    /// @notice Ignore RateLimiter setting.
    function _setOutboundLimit(
        TrimmedAmount // limit
    ) internal override {}

    /// @notice Ignore RateLimiter setting.
    function _setInboundLimit(
        TrimmedAmount, // limit
        uint16 // chainId_
    ) internal override {}

    // ==================== Unimplemented INttManager External Interface =================================

    /// @notice Not used, always reverts with NotImplemented.
    function completeOutboundQueuedTransfer(
        uint64 // queueSequence
    ) external payable override whenNotPaused returns (uint64) {
        revert NotImplemented();
    }

    /// @notice Not used, always reverts with NotImplemented.
    function cancelOutboundQueuedTransfer(
        uint64 // queueSequence
    ) external view override whenNotPaused {
        revert NotImplemented();
    }

    /// @notice Not used, always reverts with NotImplemented.
    function completeInboundQueuedTransfer(
        bytes32 // digest
    ) external view override whenNotPaused {
        revert NotImplemented();
    }

    // ==================== Overridden NttManager Implementations =================================

    function _enqueueOrConsumeOutboundRateLimit(
        uint256, // amount
        uint16, // recipientChain
        bytes32, // recipient
        bytes32, // refundAddress
        bool, // shouldQueue
        bytes memory, // executorQuote
        bytes memory, // relayInstructions
        bytes memory, // transceiverInstructions
        TrimmedAmount, // trimmedAmount
        uint64 // sequence
    ) internal pure override returns (bool) {
        return false;
    }

    function _enqueueOrConsumeInboundRateLimit(
        bytes32, // digest
        uint16, // sourceChainId
        TrimmedAmount, // nativeTransferAmount
        address // transferRecipient
    ) internal pure override returns (bool) {
        return false;
    }
}
