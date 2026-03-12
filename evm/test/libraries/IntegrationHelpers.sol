// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import {
    WormholeTransceiver
} from "../../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import {DummyToken, DummyTokenMintAndBurn} from "../../src/mocks/DummyToken.sol";
import "../../src/libraries/TrimmedAmount.sol";
import {Utils} from "./../libraries/Utils.sol";
import "../../src/libraries/TransceiverStructs.sol";
import "wormhole-sdk/Utils.sol";
import "../../src/interfaces/IWormholeTransceiver.sol";
import "../../src/NttManager/NttManager.sol";
import {ICoreBridge} from "wormhole-sdk/interfaces/ICoreBridge.sol";
import {
    WormholeOverride,
    AdvancedWormholeOverride
} from "wormhole-sdk/testing/WormholeOverride.sol";
import {VaaLib, Vaa, VaaBody as PublishedMessage} from "wormhole-sdk/libraries/VaaLib.sol";

contract IntegrationHelpers is Test {
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    WormholeTransceiver wormholeTransceiverChain1;
    WormholeTransceiver wormholeTransceiverChain1Other;
    WormholeTransceiver wormholeTransceiverChain2;
    WormholeTransceiver wormholeTransceiverChain2Other;

    function buildTransceiverInstruction(
        bool relayer_off
    ) public view returns (TransceiverStructs.TransceiverInstruction memory) {
        WormholeTransceiver.WormholeTransceiverInstruction memory instruction =
            IWormholeTransceiver.WormholeTransceiverInstruction(relayer_off);

        bytes memory encodedInstructionWormhole;
        // Source fork has id 0 and corresponds to chain 1
        if (vm.activeFork() == 0) {
            encodedInstructionWormhole =
                wormholeTransceiverChain1.encodeWormholeTransceiverInstruction(instruction);
        } else {
            encodedInstructionWormhole =
                wormholeTransceiverChain2.encodeWormholeTransceiverInstruction(instruction);
        }
        return
            TransceiverStructs.TransceiverInstruction({
                index: 0, payload: encodedInstructionWormhole
            });
    }

    function encodeTransceiverInstruction(
        bool relayer_off
    ) public view returns (bytes memory) {
        TransceiverStructs.TransceiverInstruction memory TransceiverInstruction =
            buildTransceiverInstruction(relayer_off);
        TransceiverStructs.TransceiverInstruction[] memory TransceiverInstructions =
            new TransceiverStructs.TransceiverInstruction[](1);
        TransceiverInstructions[0] = TransceiverInstruction;
        return TransceiverStructs.encodeTransceiverInstructions(TransceiverInstructions);
    }

    function _setTransceiverPeers(
        WormholeTransceiver[2] memory transceivers,
        WormholeTransceiver[2] memory transceiverPeers,
        uint16[2] memory chainIds
    ) internal {
        for (uint256 i; i < transceivers.length; i++) {
            transceivers[i].setWormholePeer(
                chainIds[i], toUniversalAddress(address(transceiverPeers[i]))
            );
        }
    }

    function _setManagerPeer(
        NttManager sourceManager,
        NttManager peerManagerAddr,
        uint16 peerChainId,
        uint8 peerDecimals,
        uint64 inboundLimit
    ) internal {
        sourceManager.setPeer(
            peerChainId, toUniversalAddress(address(peerManagerAddr)), peerDecimals, inboundLimit
        );
    }

    function _quotePrices(
        WormholeTransceiver[] memory transceivers,
        uint16 recipientChainId,
        bool shouldSkipRelay
    ) internal view returns (uint256) {
        uint256 quoteSum;
        for (uint256 i; i < transceivers.length; i++) {
            quoteSum = quoteSum
                + transceivers[i].quoteDeliveryPrice(
                    recipientChainId, buildTransceiverInstruction(shouldSkipRelay)
                );
        }

        return quoteSum;
    }

    // Setting up the transfer
    function _prepareTransfer(
        DummyToken token,
        address user,
        address contractAddr,
        uint256 amount
    ) internal {
        vm.startPrank(user);

        token.mintDummy(user, amount);
        token.approve(contractAddr, amount);
    }

    function _computeManagerMessageDigest(
        address from,
        address to,
        TrimmedAmount sendingAmount,
        address tokenAddr,
        uint16 sourceChainId,
        uint16 recipientChainId
    ) internal pure returns (bytes32) {
        TransceiverStructs.NttManagerMessage memory nttManagerMessage;
        nttManagerMessage = TransceiverStructs.NttManagerMessage(
            0,
            toUniversalAddress(from),
            TransceiverStructs.encodeNativeTokenTransfer(
                TransceiverStructs.NativeTokenTransfer({
                    amount: sendingAmount,
                    sourceToken: toUniversalAddress(tokenAddr),
                    to: toUniversalAddress(to),
                    toChain: recipientChainId,
                    additionalPayload: ""
                })
            )
        );

        return TransceiverStructs.nttManagerMessageDigest(sourceChainId, nttManagerMessage);
    }

    function getTotalSupply(
        uint256 forkId,
        DummyToken token
    ) public returns (uint256) {
        vm.selectFork(forkId);
        return token.totalSupply();
    }

    // Send token through standard relayer
    function transferToken(
        address to,
        address refund,
        NttManager sourceManager,
        uint256 sendingAmount,
        uint16 recipientChainId,
        WormholeTransceiver[] memory transceivers,
        bool relayer_off
    ) public {
        uint256 quoteSum = _quotePrices(transceivers, recipientChainId, relayer_off);

        // refund the amount back to the user that sent the transfer
        sourceManager.transfer{value: quoteSum}(
            sendingAmount,
            recipientChainId,
            toUniversalAddress(to),
            toUniversalAddress(refund),
            relayer_off,
            encodeTransceiverInstruction(relayer_off)
        );
    }

    function _getWormholeMessage(
        ICoreBridge coreBridge,
        Vm.Log[] memory logs,
        uint16 emitterChainId
    ) internal view returns (bytes[] memory) {
        PublishedMessage[] memory msgs = WormholeOverride.fetchPublishedMessages(coreBridge, logs);
        bytes[] memory encodedVaas = new bytes[](msgs.length);
        for (uint256 i = 0; i < msgs.length; i++) {
            msgs[i].envelope.emitterChainId = emitterChainId;
            encodedVaas[i] = VaaLib.encode(WormholeOverride.sign(coreBridge, msgs[i]));
        }

        return encodedVaas;
    }
}
