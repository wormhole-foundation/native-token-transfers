// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import "../../libraries/TransceiverHelpers.sol";
import "../../libraries/TransceiverStructs.sol";

import "../../interfaces/IWormholeTransceiver.sol";
import "../../interfaces/IWormholeTransceiverState.sol";
import "../../interfaces/INttManager.sol";

import "../GenericTransceiver.sol";

abstract contract WormholeTransceiverState is IWormholeTransceiverState, GenericTransceiver {
    using BytesParsing for bytes;

    // ==================== Immutables ===============================================
    uint8 public immutable consistencyLevel;
    IWormhole public immutable wormhole;
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

    constructor(
        address nttManager,
        address wormholeCoreBridge,
        uint8 _consistencyLevel,
        uint256 _gasLimit
    ) {
        wormhole = IWormhole(wormholeCoreBridge);
        wormholeTransceiver_evmChainId = block.chainid;
        consistencyLevel = _consistencyLevel;
        gasLimit = _gasLimit;
    }

    enum RelayingType {
        Standard,
        Special,
        Manual
    }

    function _initialize() internal virtual override {
        super._initialize();
    }

    function _checkImmutables() internal view virtual override {
        super._checkImmutables();
        assert(this.wormhole() == wormhole);
        assert(this.consistencyLevel() == consistencyLevel);
    }

    // =============== Storage ===============================================

    bytes32 private constant WORMHOLE_PEERS_SLOT =
        bytes32(uint256(keccak256("whTransceiver.peers")) - 1);

    // =============== Storage Setters/Getters ========================================

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

    // =============== Public Getters ======================================================

    /// @inheritdoc IWormholeTransceiverState
    function getWormholePeer(
        uint16 chainId
    ) public view returns (bytes32) {
        return _getWormholePeersStorage()[chainId];
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

        _onSetWormholePeer(peerChainId, peerContract);

        emit SetWormholePeer(peerChainId, peerContract);
    }

    function _onSetWormholePeer(uint16 peerChainId, bytes32 peerContract) internal virtual {}
}
