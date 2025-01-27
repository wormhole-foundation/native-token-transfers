// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/Utils.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

import "example-messaging-endpoint/evm/src/interfaces/IAdapterRegistry.sol";
import "example-messaging-endpoint/evm/src/interfaces/IEndpointAdmin.sol";
import "example-messaging-endpoint/evm/src/interfaces/IEndpointIntegrator.sol";
import "example-messaging-executor/evm/src/interfaces/IExecutor.sol";

import "../libraries/external/OwnableUpgradeable.sol";
import "../libraries/external/ReentrancyGuardUpgradeable.sol";
import "../libraries/TransceiverStructs.sol";
import "../libraries/TransceiverHelpers.sol";
import "../libraries/PausableOwnable.sol";
import "../libraries/Implementation.sol";

import "../interfaces/IManagerBase.sol";

abstract contract ManagerBase is
    IManagerBase,
    PausableOwnable,
    ReentrancyGuardUpgradeable,
    Implementation
{
    // =============== Immutables ============================================================

    /// @dev Address of the token that this NTT Manager is tied to
    address public immutable token;
    /// @dev Contract deployer address
    address immutable deployer;
    /// @dev Mode of the NTT Manager -- this is either LOCKING (Mode = 0) or BURNING (Mode = 1)
    /// In LOCKING mode, tokens are locked/unlocked by the NTT Manager contract when sending/redeeming cross-chain transfers.
    /// In BURNING mode, tokens are burned/minted by the NTT Manager contract when sending/redeeming cross-chain transfers.
    Mode public immutable mode;
    /// @dev Wormhole chain ID that the NTT Manager is deployed on.
    /// This chain ID is formatted Wormhole Chain IDs -- https://docs.wormhole.com/wormhole/reference/constants
    uint16 public immutable chainId;
    /// @dev EVM chain ID that the NTT Manager is deployed on.
    /// This chain ID is formatted based on standardized chain IDs, e.g. Ethereum mainnet is 1, Sepolia is 11155111, etc.
    uint256 immutable evmChainId;

    // The modular messaging endpoint used for sending and receiving attestations.
    IEndpointIntegrator public immutable endpoint;

    // The executor used for publishing message payloads.
    IExecutor public immutable executor;

    // =============== Setup =================================================================

    constructor(address _endpoint, address _executor, address _token, Mode _mode, uint16 _chainId) {
        endpoint = IEndpointIntegrator(_endpoint);
        executor = IExecutor(_executor);
        token = _token;
        mode = _mode;
        chainId = _chainId;
        evmChainId = block.chainid;
        // save the deployer (check this on initialization)
        deployer = msg.sender;
    }

    function _migrate() internal virtual override {
        _checkThresholdInvariants();
    }

    // =============== Storage ==============================================================

    bytes32 private constant MESSAGE_SEQUENCE_SLOT =
        bytes32(uint256(keccak256("ntt.messageSequence")) - 1);

    bytes32 private constant THRESHOLD_SLOT = bytes32(uint256(keccak256("ntt.threshold")) - 1);

    // =============== Storage Getters/Setters ==============================================

    function _getThresholdStorage()
        private
        pure
        returns (mapping(uint16 => _Threshold) storage $)
    {
        uint256 slot = uint256(THRESHOLD_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getMessageSequenceStorage() internal pure returns (_Sequence storage $) {
        uint256 slot = uint256(MESSAGE_SEQUENCE_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // =============== External Logic =============================================================

    /// @inheritdoc IManagerBase
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) public view returns (uint256) {
        return endpoint.quoteDeliveryPrice(recipientChain, transceiverInstructions);
    }

    // =============== Internal Logic ===========================================================

    function _refundToSender(
        uint256 refundAmount
    ) internal {
        // refund the price quote back to sender
        (bool refundSuccessful,) = payable(msg.sender).call{value: refundAmount}("");

        // check success
        if (!refundSuccessful) {
            revert RefundFailed(refundAmount);
        }
    }

    // =============== Public Getters ========================================================

    /// @inheritdoc IManagerBase
    function getMode() public view returns (uint8) {
        return uint8(mode);
    }

    /// @inheritdoc IManagerBase
    function getThreshold(
        uint16 chain
    ) public view returns (uint8) {
        return _getThresholdStorage()[chain].num;
    }

    /// @inheritdoc IManagerBase
    function isMessageApproved(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash
    ) public view returns (bool) {
        uint8 numAttested = messageAttestations(srcChain, srcAddr, sequence, dstAddr, payloadHash);
        uint8 threshold = getThreshold(srcChain);
        return (numAttested >= threshold);
    }

    /// @inheritdoc IManagerBase
    function nextMessageSequence() external view returns (uint64) {
        return _getMessageSequenceStorage().num;
    }

    /// @inheritdoc IManagerBase
    function isMessageExecuted(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash
    ) public view returns (bool) {
        (,,, bool executed) =
            endpoint.getMessageStatus(srcChain, srcAddr, sequence, dstAddr, payloadHash);

        return executed;
    }

    /// @inheritdoc IManagerBase
    function transceiverAttestedToMessage(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash,
        uint8 index
    ) public view returns (bool) {
        (, uint128 attested,,) =
            endpoint.getMessageStatus(srcChain, srcAddr, sequence, dstAddr, payloadHash);

        return attested & uint64(1 << index) > 0;
    }

    /// @inheritdoc IManagerBase
    function messageAttestations(
        uint16 srcChain,
        UniversalAddress srcAddr,
        uint64 sequence,
        UniversalAddress dstAddr,
        bytes32 payloadHash
    ) public view returns (uint8 count) {
        (,, count,) = endpoint.getMessageStatus(srcChain, srcAddr, sequence, dstAddr, payloadHash);
    }

    // =============== Admin ==============================================================

    /// @inheritdoc IManagerBase
    function upgrade(
        address newImplementation
    ) external onlyOwner {
        _upgrade(newImplementation);
    }

    /// @inheritdoc IManagerBase
    function pause() public onlyOwnerOrPauser {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    /// @notice Transfer ownership of the Manager contract and all Transceiver contracts to a new owner.
    function transferOwnership(
        address newOwner
    ) public override onlyOwner {
        // It's intentional (at this time) that we are not transferring the endpoint admin.
        // The endpoint functions are all called by the NttManager, which means the admin
        // must remain the NttManager.
        super.transferOwnership(newOwner);
    }

    /// @inheritdoc IManagerBase
    function setTransceiver(
        address transceiver
    ) external onlyOwner {
        uint8 index = IEndpointAdmin(address(endpoint)).addAdapter(address(this), transceiver);
        emit TransceiverAdded(transceiver, index);
    }

    /// @inheritdoc IManagerBase
    function enableSendTransceiver(uint16 chain, address transceiver) external {
        IEndpointAdmin(address(endpoint)).enableSendAdapter(address(this), chain, transceiver);
    }

    /// @inheritdoc IManagerBase
    function enableRecvTransceiver(uint16 chain, address transceiver) external {
        IEndpointAdmin(address(endpoint)).enableRecvAdapter(address(this), chain, transceiver);

        _Threshold storage _threshold = _getThresholdStorage()[chain];
        // We do not automatically increase the threshold here.
        // Automatically increasing the threshold can result in a scenario
        // where in-flight messages can't be redeemed.
        // For example: Assume there is 1 Transceiver and the threshold is 1.
        // If we were to add a new Transceiver, the threshold would increase to 2.
        // However, all messages that are either in-flight or that are sent on
        // a source chain that does not yet have 2 Transceivers will only have been
        // sent from a single transceiver, so they would never be able to get
        // redeemed.
        // Instead, we leave it up to the owner to manually update the threshold
        // after some period of time, ideally once all chains have the new Transceiver
        // and transfers that were sent via the old configuration are all complete.
        // However if the threshold is 0 (the initial case) we do increment to 1.
        if (_threshold.num == 0) {
            _threshold.num = 1;
        }

        _checkThresholdInvariantsForChain(chain);
    }

    /// @inheritdoc IManagerBase
    function disableSendTransceiver(uint16 chain, address transceiver) external {
        IEndpointAdmin(address(endpoint)).disableSendAdapter(address(this), chain, transceiver);
    }

    /// @inheritdoc IManagerBase
    function disableRecvTransceiver(uint16 chain, address transceiver) external {
        IEndpointAdmin(address(endpoint)).disableRecvAdapter(address(this), chain, transceiver);

        _Threshold storage _threshold = _getThresholdStorage()[chain];
        uint8 numEnabled = IAdapterRegistry(address(endpoint)).getNumEnabledRecvAdaptersForChain(
            address(this), chain
        );

        // TODO: Should we do this or just let _checkThresholdInvariantsForChain revert and make them reduce the threshold before disabling the chain?
        if (_threshold.num > numEnabled) {
            uint8 oldThreshold = _threshold.num;
            _threshold.num = numEnabled;
            emit ThresholdChanged(chainId, oldThreshold, numEnabled);
        }

        _checkThresholdInvariantsForChain(chain);
    }

    /// @inheritdoc IManagerBase
    function setThreshold(uint16 chain, uint8 threshold) external onlyOwner {
        if (threshold == 0) {
            revert ZeroThreshold();
        }

        _Threshold storage _threshold = _getThresholdStorage()[chain];
        uint8 oldThreshold = _threshold.num;

        _threshold.num = threshold;
        _checkThresholdInvariantsForChain(chain);
        emit ThresholdChanged(chainId, oldThreshold, threshold);
    }

    // =============== Internal ==============================================================

    function _useMessageSequence() internal returns (uint64 currentSequence) {
        currentSequence = _getMessageSequenceStorage().num;
        _getMessageSequenceStorage().num++;
    }

    /// ============== Invariants =============================================

    /// @dev When we add new immutables, this function should be updated
    function _checkImmutables() internal view virtual override {
        assert(this.token() == token);
        assert(this.mode() == mode);
        assert(this.chainId() == chainId);
        assert(this.endpoint() == endpoint);
        assert(this.executor() == executor);
    }

    function _checkThresholdInvariants() internal view {
        uint16[] memory chains =
            IAdapterRegistry(address(endpoint)).getChainsEnabledForRecv(address(this));
        uint256 len = chains.length;
        for (uint256 idx = 0; (idx < len);) {
            _checkThresholdInvariantsForChain(chains[idx]);
            unchecked {
                ++idx;
            }
        }
    }

    /// @dev This can be called directly when we are only manipulating a single chain. Otherwise use _checkThresholdInvariants.
    function _checkThresholdInvariantsForChain(
        uint16 chain
    ) internal view {
        uint8 threshold = _getThresholdStorage()[chain].num;
        uint8 numEnabled = IAdapterRegistry(address(endpoint)).getNumEnabledRecvAdaptersForChain(
            address(this), chain
        );

        // invariant: threshold <= enabledTransceivers.length
        if (threshold > numEnabled) {
            revert ThresholdTooHigh(threshold, numEnabled);
        }

        if (numEnabled > 0) {
            if (threshold == 0) {
                revert ZeroThreshold();
            }
        }
    }
}
