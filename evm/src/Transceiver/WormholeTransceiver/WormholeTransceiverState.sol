// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/WormholeRelayerSDK.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import "../../libraries/TransceiverHelpers.sol";
import "../../libraries/BooleanFlag.sol";
import "../../libraries/TransceiverStructs.sol";

import "../../interfaces/IWormholeTransceiver.sol";
import "../../interfaces/IWormholeTransceiverState.sol";
import "../../interfaces/ISpecialRelayer.sol";
import "../../interfaces/INttManager.sol";

import "../Transceiver.sol";

abstract contract WormholeTransceiverState is IWormholeTransceiverState, Transceiver {
    using BytesParsing for bytes;
    using BooleanFlagLib for bool;
    using BooleanFlagLib for BooleanFlag;

    // ==================== Immutables ===============================================
    uint8 public immutable consistencyLevel;
    IWormhole public immutable wormhole;
    IWormholeRelayer public immutable wormholeRelayer;
    ISpecialRelayer public immutable specialRelayer;
    /// @dev We don't check this in `_checkImmutables` since it's set at construction
    ///      through `block.chainid`.
    uint256 immutable wormholeTransceiver_evmChainId;
    /// @dev We purposely avoid checking this in `_checkImmutables` to allow tweaking it
    ///      without needing to allow modification of security critical immutables.
    uint256 public immutable gasLimit;

    // ==================== Constants ================================================

    /// @dev Prefix for all TransceiverMessage payloads
    /// @notice Magic string (constant value set by messaging provider) that idenfies the payload as an transceiver-emitted payload.
    ///         Note that this is not a security critical field. It's meant to be used by messaging providers to identify which messages are Transceiver-related.
    bytes4 constant WH_TRANSCEIVER_PAYLOAD_PREFIX = 0x9945FF10;

    /// @dev Prefix for all Wormhole transceiver initialisation payloads
    ///      This is bytes4(keccak256("WormholeTransceiverInit"))
    bytes4 constant WH_TRANSCEIVER_INIT_PREFIX = 0x9c23bd3b;

    /// @dev Prefix for all Wormhole peer registration payloads
    ///      This is bytes4(keccak256("WormholePeerRegistration"))
    bytes4 constant WH_PEER_REGISTRATION_PREFIX = 0x18fc67c2;

    constructor(
        address nttManager,
        address wormholeCoreBridge,
        address wormholeRelayerAddr,
        address specialRelayerAddr,
        uint8 _consistencyLevel,
        uint256 _gasLimit
    ) Transceiver(nttManager) {
        wormhole = IWormhole(wormholeCoreBridge);
        wormholeRelayer = IWormholeRelayer(wormholeRelayerAddr);
        specialRelayer = ISpecialRelayer(specialRelayerAddr);
        wormholeTransceiver_evmChainId = block.chainid;
        consistencyLevel = _consistencyLevel;
        gasLimit = _gasLimit;
    }

    enum RelayingType {
        Standard,
        Special,
        Manual
    }

    function _initialize() internal override {
        super._initialize();
        _initializeTransceiver();
    }

    function _migrate() internal virtual override {
        _setMigratesImmutables(true);
    }

    function _initializeTransceiver() internal {
        TransceiverStructs.TransceiverInit memory init = TransceiverStructs.TransceiverInit({
            transceiverIdentifier: WH_TRANSCEIVER_INIT_PREFIX,
            nttManagerAddress: toWormholeFormat(nttManager),
            nttManagerMode: INttManager(nttManager).getMode(),
            tokenAddress: toWormholeFormat(nttManagerToken),
            tokenDecimals: INttManager(nttManager).tokenDecimals()
        });
        wormhole.publishMessage{value: msg.value}(
            0, TransceiverStructs.encodeTransceiverInit(init), consistencyLevel
        );
    }

    function _checkImmutables() internal view override {
        super._checkImmutables();
        assert(this.wormhole() == wormhole);
        assert(this.wormholeRelayer() == wormholeRelayer);
        assert(this.specialRelayer() == specialRelayer);
        assert(this.consistencyLevel() == consistencyLevel);
    }

    // =============== Storage ===============================================

    bytes32 private constant WORMHOLE_CONSUMED_VAAS_SLOT =
        bytes32(uint256(keccak256("whTransceiver.consumedVAAs")) - 1);

    bytes32 private constant WORMHOLE_PEERS_SLOT =
        bytes32(uint256(keccak256("whTransceiver.peers")) - 1);

    bytes32 private constant WORMHOLE_RELAYING_ENABLED_CHAINS_SLOT =
        bytes32(uint256(keccak256("whTransceiver.relayingEnabledChains")) - 1);

    bytes32 private constant SPECIAL_RELAYING_ENABLED_CHAINS_SLOT =
        bytes32(uint256(keccak256("whTransceiver.specialRelayingEnabledChains")) - 1);

    bytes32 private constant WORMHOLE_EVM_CHAIN_IDS =
        bytes32(uint256(keccak256("whTransceiver.evmChainIds")) - 1);

    // =============== Storage Setters/Getters ========================================

    function _getWormholeConsumedVAAsStorage()
        internal
        pure
        returns (mapping(bytes32 => bool) storage $)
    {
        uint256 slot = uint256(WORMHOLE_CONSUMED_VAAS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getWormholePeersStorage()
        internal
        pure
        returns (mapping(uint16 => bytes32) storage $)
    {
        uint256 slot = uint256(WORMHOLE_PEERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getWormholeRelayingEnabledChainsStorage()
        internal
        pure
        returns (mapping(uint16 => BooleanFlag) storage $)
    {
        uint256 slot = uint256(WORMHOLE_RELAYING_ENABLED_CHAINS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getSpecialRelayingEnabledChainsStorage()
        internal
        pure
        returns (mapping(uint16 => BooleanFlag) storage $)
    {
        uint256 slot = uint256(SPECIAL_RELAYING_ENABLED_CHAINS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getWormholeEvmChainIdsStorage()
        internal
        pure
        returns (mapping(uint16 => BooleanFlag) storage $)
    {
        uint256 slot = uint256(WORMHOLE_EVM_CHAIN_IDS);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // =============== Public Getters ======================================================

    /// @inheritdoc IWormholeTransceiverState
    function isVAAConsumed(
        bytes32 hash
    ) public view returns (bool) {
        return _getWormholeConsumedVAAsStorage()[hash];
    }

    /// @inheritdoc IWormholeTransceiverState
    function getWormholePeer(
        uint16 chainId
    ) public view returns (bytes32) {
        return _getWormholePeersStorage()[chainId];
    }

    /// @inheritdoc IWormholeTransceiverState
    function isWormholeRelayingEnabled(
        uint16 chainId
    ) public view returns (bool) {
        return _getWormholeRelayingEnabledChainsStorage()[chainId].toBool();
    }

    /// @inheritdoc IWormholeTransceiverState
    function isSpecialRelayingEnabled(
        uint16 chainId
    ) public view returns (bool) {
        return _getSpecialRelayingEnabledChainsStorage()[chainId].toBool();
    }

    /// @inheritdoc IWormholeTransceiverState
    function isWormholeEvmChain(
        uint16 chainId
    ) public view returns (bool) {
        return _getWormholeEvmChainIdsStorage()[chainId].toBool();
    }

    // =============== Admin ===============================================================

    /// @inheritdoc IWormholeTransceiverState
    function setWormholePeer(uint16 peerChainId, bytes32 peerContract) external payable onlyOwner {
        if (peerChainId == 0) {
            revert InvalidWormholeChainIdZero();
        }
        if (peerContract == bytes32(0)) {
            revert InvalidWormholePeerZeroAddress();
        }

        bytes32 oldPeerContract = _getWormholePeersStorage()[peerChainId];

        // We don't want to allow updating a peer since this adds complexity in the accountant
        // If the owner makes a mistake with peer registration they should deploy a new Wormhole
        // transceiver and register this new transceiver with the NttManager
        if (oldPeerContract != bytes32(0)) {
            revert PeerAlreadySet(peerChainId, oldPeerContract);
        }

        _getWormholePeersStorage()[peerChainId] = peerContract;

        // Publish a message for this transceiver registration
        TransceiverStructs.TransceiverRegistration memory registration = TransceiverStructs
            .TransceiverRegistration({
            transceiverIdentifier: WH_PEER_REGISTRATION_PREFIX,
            transceiverChainId: peerChainId,
            transceiverAddress: peerContract
        });
        wormhole.publishMessage{value: msg.value}(
            0, TransceiverStructs.encodeTransceiverRegistration(registration), consistencyLevel
        );

        emit SetWormholePeer(peerChainId, peerContract);
    }

    /// @inheritdoc IWormholeTransceiverState
    function setIsWormholeEvmChain(uint16 chainId, bool isEvm) external onlyOwner {
        if (chainId == 0) {
            revert InvalidWormholeChainIdZero();
        }
        _getWormholeEvmChainIdsStorage()[chainId] = isEvm.toWord();

        emit SetIsWormholeEvmChain(chainId, isEvm);
    }

    /// @inheritdoc IWormholeTransceiverState
    function setIsWormholeRelayingEnabled(uint16 chainId, bool isEnabled) external onlyOwner {
        if (chainId == 0) {
            revert InvalidWormholeChainIdZero();
        }
        _getWormholeRelayingEnabledChainsStorage()[chainId] = isEnabled.toWord();

        emit SetIsWormholeRelayingEnabled(chainId, isEnabled);
    }

    /// @inheritdoc IWormholeTransceiverState
    function setIsSpecialRelayingEnabled(uint16 chainId, bool isEnabled) external onlyOwner {
        if (chainId == 0) {
            revert InvalidWormholeChainIdZero();
        }
        _getSpecialRelayingEnabledChainsStorage()[chainId] = isEnabled.toWord();

        emit SetIsSpecialRelayingEnabled(chainId, isEnabled);
    }

    // ============= Internal ===============================================================

    function _checkInvalidRelayingConfig(
        uint16 chainId
    ) internal view returns (bool) {
        return isWormholeRelayingEnabled(chainId) && !isWormholeEvmChain(chainId);
    }

    function _shouldRelayViaStandardRelaying(
        uint16 chainId
    ) internal view returns (bool) {
        return isWormholeRelayingEnabled(chainId) && isWormholeEvmChain(chainId);
    }

    function _setVAAConsumed(
        bytes32 hash
    ) internal {
        _getWormholeConsumedVAAsStorage()[hash] = true;
    }

    // =============== MODIFIERS ===============================================

    modifier onlyRelayer() {
        if (msg.sender != address(wormholeRelayer)) {
            revert CallerNotRelayer(msg.sender);
        }
        _;
    }
}
