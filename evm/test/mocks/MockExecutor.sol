// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.19;

import "example-messaging-executor/evm/src/Executor.sol";

contract MockExecutor is Executor {
    constructor(
        uint16 _chainId
    ) Executor(_chainId) {}

    function chainId() public view returns (uint16) {
        return ourChain;
    }

    // NOTE: This was copied from the tests in the executor repo.
    function encodeSignedQuoteHeader(
        Executor.SignedQuoteHeader memory signedQuote
    ) public pure returns (bytes memory) {
        return abi.encodePacked(
            signedQuote.prefix,
            signedQuote.quoterAddress,
            signedQuote.payeeAddress,
            signedQuote.srcChain,
            signedQuote.dstChain,
            signedQuote.expiryTime
        );
    }

    function createSignedQuote(
        uint16 dstChain
    ) public view returns (bytes memory) {
        return createSignedQuote(dstChain, 60);
    }

    function createSignedQuote(
        uint16 dstChain,
        uint64 quoteLife
    ) public view returns (bytes memory) {
        Executor.SignedQuoteHeader memory signedQuote = IExecutor.SignedQuoteHeader({
            prefix: "EQ01",
            quoterAddress: address(0),
            payeeAddress: bytes32(0),
            srcChain: ourChain,
            dstChain: dstChain,
            expiryTime: uint64(block.timestamp + quoteLife)
        });
        return encodeSignedQuoteHeader(signedQuote);
    }

    function createRelayInstructions() public pure returns (bytes memory) {
        return new bytes(0);
    }

    function msgValue() public pure returns (uint256) {
        return 0;
    }
}
