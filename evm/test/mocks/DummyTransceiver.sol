// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "../../src/Transceiver/Transceiver.sol";
import "../interfaces/ITransceiverReceiver.sol";

contract DummyTransceiver is Transceiver, ITransceiverReceiver {
    uint16 constant SENDING_CHAIN_ID = 1;
    bytes4 constant TEST_TRANSCEIVER_PAYLOAD_PREFIX = 0x99455454;

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
        uint16, /* recipientChain */
        uint256, /* deliveryPayment */
        address, /* caller */
        bytes32, /* recipientNttManagerAddress */
        bytes32, /* refundAddres */
        TransceiverStructs.TransceiverInstruction memory, /* instruction */
        bytes memory /* payload */
    ) internal override {
        // do nothing
    }

    function receiveMessage(
        bytes memory encodedMessage
    ) external {
        TransceiverStructs.TransceiverMessage memory parsedTransceiverMessage;
        TransceiverStructs.NttManagerMessage memory parsedNttManagerMessage;
        (parsedTransceiverMessage, parsedNttManagerMessage) =
            TransceiverStructs.parseTransceiverAndNttManagerMessage(
                TEST_TRANSCEIVER_PAYLOAD_PREFIX, encodedMessage
            );
        _deliverToNttManager(
            SENDING_CHAIN_ID,
            parsedTransceiverMessage.sourceNttManagerAddress,
            parsedTransceiverMessage.recipientNttManagerAddress,
            parsedNttManagerMessage
        );
    }

    function parseMessageFromLogs(
        Vm.Log[] memory logs
    ) public pure returns (uint16 recipientChain, bytes memory payload) {}
}
