// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "wormhole-solidity-sdk/libraries/BytesParsing.sol";
import "./NttManagerHelpers.sol";
import "../mocks/DummyTransceiver.sol";
import "../../src/mocks/DummyToken.sol";
import "../../src/NttManager/NttManager.sol";
import "../../src/libraries/TrimmedAmount.sol";

library TransceiverHelpersLib {
    using BytesParsing for bytes;
    using TrimmedAmountLib for TrimmedAmount;

    // 0x99'E''T''T'
    bytes4 constant TEST_TRANSCEIVER_PAYLOAD_PREFIX = 0x99455454;

    function setup_transceivers(
        NttManager nttManager,
        uint16 peerChainId
    ) internal returns (DummyTransceiver, DummyTransceiver) {
        DummyTransceiver e1 =
            new DummyTransceiver(nttManager.chainId(), address(nttManager.endpoint()));
        DummyTransceiver e2 =
            new DummyTransceiver(nttManager.chainId(), address(nttManager.endpoint()));
        nttManager.setTransceiver(address(e1));
        nttManager.enableSendTransceiver(peerChainId, address(e1));
        nttManager.enableRecvTransceiver(peerChainId, address(e1));
        nttManager.setTransceiver(address(e2));
        nttManager.enableSendTransceiver(peerChainId, address(e2));
        nttManager.enableRecvTransceiver(peerChainId, address(e2));
        nttManager.setThreshold(peerChainId, 2);
        return (e1, e2);
    }

    function addTransceiver(
        NttManager nttManager,
        DummyTransceiver e1,
        uint16 peerChainId
    ) internal returns (DummyTransceiver, DummyTransceiver) {
        DummyTransceiver e2 =
            new DummyTransceiver(nttManager.chainId(), address(nttManager.endpoint()));
        nttManager.setTransceiver(address(e2));
        nttManager.enableSendTransceiver(peerChainId, address(e2));
        nttManager.enableRecvTransceiver(peerChainId, address(e2));
        nttManager.setThreshold(peerChainId, 2);
        return (e1, e2);
    }

    function transferAndAttest(
        address to,
        bytes32 id,
        NttManager nttManager,
        NttManager recipientNttManager,
        TrimmedAmount amount,
        TrimmedAmount inboundLimit,
        DummyTransceiver[] memory transceivers
    )
        internal
        returns (
            TransceiverStructs.NttManagerMessage memory m,
            bytes memory encodedM,
            DummyTransceiver.Message memory rmsg
        )
    {
        m = buildNttManagerMessage(to, id, recipientNttManager.chainId(), nttManager, amount);
        encodedM = TransceiverStructs.encodeNttManagerMessage(m);
        prepTokenReceive(nttManager, recipientNttManager, amount, inboundLimit);
        rmsg = attestMsg(nttManager, recipientNttManager, 0, transceivers, encodedM);
    }

    function transferAttestAndReceive(
        address to,
        bytes32 id,
        NttManager nttManager,
        NttManager recipientNttManager,
        TrimmedAmount amount,
        TrimmedAmount inboundLimit,
        DummyTransceiver[] memory transceivers
    )
        internal
        returns (
            TransceiverStructs.NttManagerMessage memory m,
            DummyTransceiver.Message memory rmsg
        )
    {
        m = buildNttManagerMessage(to, id, recipientNttManager.chainId(), nttManager, amount);
        bytes memory encodedM = TransceiverStructs.encodeNttManagerMessage(m);
        prepTokenReceive(nttManager, recipientNttManager, amount, inboundLimit);
        rmsg = attestAndReceiveMsg(nttManager, recipientNttManager, 0, transceivers, encodedM);
    }

    function attestMsg(
        NttManager srcNttManager,
        NttManager dstNttManager,
        uint64 sequence,
        DummyTransceiver[] memory transceivers,
        bytes memory encodedM
    ) internal returns (DummyTransceiver.Message memory rmsg) {
        rmsg = DummyTransceiver.Message({
            srcChain: srcNttManager.chainId(),
            srcAddr: UniversalAddressLibrary.fromAddress(address(srcNttManager)),
            sequence: sequence,
            dstChain: dstNttManager.chainId(),
            dstAddr: UniversalAddressLibrary.fromAddress(address(dstNttManager)),
            payloadHash: keccak256(encodedM),
            refundAddr: address(0)
        });

        // Attest the message on all the transceivers.
        uint8 numTrans = uint8(transceivers.length);
        for (uint8 i; i < numTrans; i++) {
            transceivers[i].receiveMessage(rmsg);
        }
    }

    function attestAndReceiveMsg(
        NttManager srcNttManager,
        NttManager dstNttManager,
        uint64 sequence,
        DummyTransceiver[] memory transceivers,
        bytes memory encodedM
    ) internal returns (DummyTransceiver.Message memory rmsg) {
        rmsg = attestMsg(srcNttManager, dstNttManager, sequence, transceivers, encodedM);

        // Execute the message.
        dstNttManager.executeMsg(
            srcNttManager.chainId(),
            UniversalAddressLibrary.fromAddress(address(srcNttManager)),
            0,
            encodedM
        );
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

    error TransferSentEventNotFoundInLogs(uint64 nttSeqNo);
    error ExecutorEventNotFoundInLogs(uint64 nttSeqNo, bytes32 payloadHash);

    function getExecutionSent(
        Vm.Log[] memory events,
        address nttManager,
        uint64 nttSeqNo
    ) public pure returns (bytes memory payload) {
        // To find the payload bytes from the logs we need to do the following steps:
        // 1. Look for the TransferSent event for our NttManager and sequence number.
        // 2. Immediately following that should be the RequestForExecution event.
        // 3. Extract the payload of that, which is an MMRequest. Parse that to get the NTT payload.
        for (uint256 idx = 0; idx < events.length; ++idx) {
            if (
                events[idx].topics[0]
                    == bytes32(0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982)
                    && events[idx].emitter == nttManager
            ) {
                (,,, uint64 sequence) =
                    abi.decode(events[idx].data, (uint256, uint256, uint16, uint64));

                if (sequence == nttSeqNo) {
                    // The next event in the log should be from the executor
                    if (
                        (idx + 1 < events.length)
                            && (
                                events[idx + 1].topics[0]
                                    == bytes32(
                                        0xd870d87e4a7c33d0943b0a3d2822b174e239cc55c169af14cc56467a4489e3b5
                                    )
                            )
                    ) {
                        bytes memory execPayload;
                        (,,,,, execPayload,) = abi.decode(
                            events[idx + 1].data,
                            (uint256, uint16, bytes32, address, bytes, bytes, bytes)
                        );
                        return decodeMMRequest(execPayload);
                    }
                }
            }
        }
        revert TransferSentEventNotFoundInLogs(nttSeqNo);
    }

    /// @dev This decodes an ExecutorMessages.makeMMRequest and returns the enclosed payload.
    function decodeMMRequest(
        bytes memory execPayload
    ) internal pure returns (bytes memory payload) {
        uint256 offset = 0;
        uint32 payloadLen;

        (, offset) = execPayload.asBytes4(offset); // msgType
        (, offset) = execPayload.asUint16(offset); // srcChain
        (, offset) = execPayload.asBytes32(offset); // srcAddr
        (, offset) = execPayload.asUint64(offset); // seqNo
        (payloadLen, offset) = execPayload.asUint32(offset);
        (payload, offset) = execPayload.sliceUnchecked(offset, payloadLen);
    }
}
