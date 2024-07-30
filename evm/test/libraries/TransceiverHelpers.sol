// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "./NttManagerHelpers.sol";
import "../mocks/DummyTransceiver.sol";
import "../../src/mocks/DummyToken.sol";
import "../../src/NttManager/NttManager.sol";
import "../../src/libraries/TrimmedAmount.sol";

library TransceiverHelpersLib {
    using TrimmedAmountLib for TrimmedAmount;

    // 0x99'E''T''T'
    bytes4 constant TEST_TRANSCEIVER_PAYLOAD_PREFIX = 0x99455454;
    uint16 constant SENDING_CHAIN_ID = 1;

    function setup_transceivers(
        ManagerBase nttManager
    ) internal returns (DummyTransceiver, DummyTransceiver) {
        DummyTransceiver e1 = new DummyTransceiver(address(nttManager));
        DummyTransceiver e2 = new DummyTransceiver(address(nttManager));
        nttManager.setTransceiver(address(e1));
        nttManager.setTransceiver(address(e2));
        nttManager.setThreshold(2);
        return (e1, e2);
    }

    function attestTransceiversHelper(
        address to,
        bytes32 id,
        uint16 toChain,
        NttManager nttManager,
        NttManager recipientNttManager,
        TrimmedAmount amount,
        TrimmedAmount inboundLimit,
        ITransceiverReceiver[] memory transceivers
    )
        internal
        returns (
            TransceiverStructs.NttManagerMessage memory,
            TransceiverStructs.TransceiverMessage memory
        )
    {
        TransceiverStructs.NttManagerMessage memory m =
            buildNttManagerMessage(to, id, toChain, nttManager, amount);
        bytes memory encodedM = TransceiverStructs.encodeNttManagerMessage(m);

        prepTokenReceive(nttManager, recipientNttManager, amount, inboundLimit);

        TransceiverStructs.TransceiverMessage memory em;
        bytes memory encodedEm;
        (em, encodedEm) = TransceiverStructs.buildAndEncodeTransceiverMessage(
            TEST_TRANSCEIVER_PAYLOAD_PREFIX,
            toWormholeFormat(address(nttManager)),
            toWormholeFormat(address(recipientNttManager)),
            encodedM,
            new bytes(0)
        );

        for (uint256 i; i < transceivers.length; i++) {
            ITransceiverReceiver e = transceivers[i];
            e.receiveMessage(encodedEm);
        }

        return (m, em);
    }

    function buildNttManagerMessage(
        address to,
        bytes32 id,
        uint16 toChain,
        NttManager nttManager,
        TrimmedAmount amount
    ) internal view returns (TransceiverStructs.NttManagerMessage memory) {
        DummyToken token = DummyToken(nttManager.token());

        return TransceiverStructs.NttManagerMessage(
            id,
            bytes32(0),
            TransceiverStructs.encodeNativeTokenTransfer(
                TransceiverStructs.NativeTokenTransfer({
                    amount: amount,
                    sourceToken: toWormholeFormat(address(token)),
                    to: toWormholeFormat(to),
                    toChain: toChain,
                    additionalPayload: ""
                })
            )
        );
    }

    function prepTokenReceive(
        NttManager nttManager,
        NttManager recipientNttManager,
        TrimmedAmount amount,
        TrimmedAmount inboundLimit
    ) internal {
        DummyToken token = DummyToken(nttManager.token());
        token.mintDummy(address(recipientNttManager), amount.untrim(token.decimals()));
        NttManagerHelpersLib.setConfigs(
            inboundLimit, nttManager, recipientNttManager, token.decimals()
        );
    }

    function buildTransceiverMessageWithNttManagerPayload(
        bytes32 id,
        bytes32 sender,
        bytes32 sourceNttManager,
        bytes32 recipientNttManager,
        bytes memory payload
    ) internal pure returns (TransceiverStructs.NttManagerMessage memory, bytes memory) {
        TransceiverStructs.NttManagerMessage memory m =
            TransceiverStructs.NttManagerMessage(id, sender, payload);
        bytes memory nttManagerMessage = TransceiverStructs.encodeNttManagerMessage(m);
        bytes memory transceiverMessage;
        (, transceiverMessage) = TransceiverStructs.buildAndEncodeTransceiverMessage(
            TEST_TRANSCEIVER_PAYLOAD_PREFIX,
            sourceNttManager,
            recipientNttManager,
            nttManagerMessage,
            new bytes(0)
        );
        return (m, transceiverMessage);
    }
}
