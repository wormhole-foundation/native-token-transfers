// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";

import "example-messaging-endpoint/evm/src/interfaces/IEndpointAdapter.sol";
import "example-messaging-endpoint/evm/src/interfaces/IAdapter.sol";

contract DummyTransceiver is IAdapter {
    uint16 public immutable chainId;
    address public immutable endpoint;
    bytes4 constant TEST_TRANSCEIVER_PAYLOAD_PREFIX = 0x99455454;

    constructor(uint16 _chainId, address _endpoint) {
        chainId = _chainId;
        endpoint = _endpoint;
    }

    function getAdapterType() external pure returns (string memory) {
        return "dummy";
    }

    function quoteDeliveryPrice(
        uint16, /* recipientChain */
        bytes calldata /* adapterInstructions */
    ) external view returns (uint256) {
        return fee;
    }

    struct Message {
        uint16 srcChain;
        UniversalAddress srcAddr;
        uint64 sequence;
        uint16 dstChain;
        UniversalAddress dstAddr;
        bytes32 payloadHash;
        address refundAddr;
    }

    Message[] public messages;
    uint256 public fee;

    function getMessages() external view returns (Message[] memory) {
        return messages;
    }

    function reset() external {
        delete messages;
    }

    function setMessageFee(
        uint256 newFee
    ) public {
        fee = newFee;
    }

    function sendMessage(
        UniversalAddress srcAddr,
        uint64 sequence,
        uint16 dstChain,
        UniversalAddress dstAddr,
        bytes32 payloadHash,
        address refundAddr,
        bytes calldata // adapterInstructions
    ) external payable {
        Message memory m = Message({
            srcChain: chainId,
            srcAddr: srcAddr,
            sequence: sequence,
            dstChain: dstChain,
            dstAddr: dstAddr,
            payloadHash: payloadHash,
            refundAddr: refundAddr
        });
        messages.push(m);
    }

    function receiveMessage(
        Message memory m
    ) external {
        IEndpointAdapter(endpoint).attestMessage(
            m.srcChain, m.srcAddr, m.sequence, m.dstChain, m.dstAddr, m.payloadHash
        );
    }
}
