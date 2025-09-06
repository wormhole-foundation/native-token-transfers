// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/interfaces/IWormholeReceiver.sol";

import "../../libraries/TransceiverHelpers.sol";
import "../../libraries/TransceiverStructs.sol";

import "../../interfaces/IWormholeTransceiver.sol";
import "../../interfaces/INttManager.sol";

import "../GenericTransceiver.sol";
import {Transceiver} from "../NttTransceiver.sol";

import "./WormholeTransceiverState.sol";
import "./GenericWormholeTransceiver.sol";

contract WormholeTransceiver is GenericWormholeTransceiver, Transceiver {
    /// @dev Prefix for all Wormhole transceiver initialisation payloads
    ///      This is bytes4(keccak256("WormholeTransceiverInit"))
    bytes4 constant WH_TRANSCEIVER_INIT_PREFIX = 0x9c23bd3b;

    /// @dev Prefix for all Wormhole peer registration payloads
    ///      This is bytes4(keccak256("WormholePeerRegistration"))
    bytes4 constant WH_PEER_REGISTRATION_PREFIX = 0x18fc67c2;

    constructor(
        address nttManager,
        address wormholeCoreBridge,
        uint8 _consistencyLevel,
        uint256 _gasLimit
    )
        GenericWormholeTransceiver(nttManager, wormholeCoreBridge, _consistencyLevel, _gasLimit)
        Transceiver(nttManager)
    {}

    function _initialize() internal override(GenericTransceiver, WormholeTransceiverState) {
        super._initialize();
        _initializeTransceiver();
    }

    function _checkImmutables() internal view override(Transceiver, WormholeTransceiverState) {
        super._checkImmutables();
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

    function _onSetWormholePeer(uint16 peerChainId, bytes32 peerContract) internal override {
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
    }
}
