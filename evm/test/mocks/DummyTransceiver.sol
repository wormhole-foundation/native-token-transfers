// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "../../src/Transceiver/Transceiver.sol";
import "../interfaces/ITransceiverReceiver.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

contract DummyTransceiver is Transceiver, ITransceiverReceiver, Test {
    uint16 constant SENDING_CHAIN_ID = 1;
    bytes4 public constant TEST_TRANSCEIVER_PAYLOAD_PREFIX = 0x99455454;

    bytes[] public messages;

    using BytesParsing for bytes;

    constructor(
        address nttManager
    ) Transceiver(nttManager) {}

    function getTransceiverType() external pure override returns (string memory) {
        return "dummy";
    }

    function _quoteDeliveryPrice(
        uint16, /* recipientChain */
        TransceiverStructs.TransceiverInstruction memory /* transceiverInstruction */
    ) internal pure override returns (uint256) {
        return 0;
    }

    function _sendMessage(
        uint16 /* recipientChain */,
        uint256, /* deliveryPayment */
        address caller,
        bytes32 recipientNttManagerAddress,
        bytes32, /* refundAddres, */
        TransceiverStructs.TransceiverInstruction memory instruction,
        bytes memory payload
    ) internal override {
        TransceiverStructs.TransceiverMessage memory transceiverMessage = TransceiverStructs
            .TransceiverMessage({
            sourceNttManagerAddress: toWormholeFormat(caller),
            recipientNttManagerAddress: recipientNttManagerAddress,
            nttManagerPayload: payload,
            transceiverPayload: TransceiverStructs.encodeTransceiverInstruction(instruction)
        });
        messages.push(TransceiverStructs.encodeTransceiverMessage(TEST_TRANSCEIVER_PAYLOAD_PREFIX, transceiverMessage));
    }

    function receiveMessage(
        bytes memory encodedMessage
    ) external {
        TransceiverStructs.TransceiverMessage memory parsedTransceiverMessage;
        TransceiverStructs.NttManagerMessage memory parsedNttManagerMessage;
        (parsedTransceiverMessage, parsedNttManagerMessage) = TransceiverStructs
            .parseTransceiverAndNttManagerMessage(TEST_TRANSCEIVER_PAYLOAD_PREFIX, encodedMessage);
        _deliverToNttManager(
            SENDING_CHAIN_ID,
            parsedTransceiverMessage.sourceNttManagerAddress,
            parsedTransceiverMessage.recipientNttManagerAddress,
            parsedNttManagerMessage
        );
    }
}
