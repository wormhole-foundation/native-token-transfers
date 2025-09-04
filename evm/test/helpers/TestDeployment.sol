// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "../../src/MultiTokenNtt/MultiTokenNtt.sol";
import "../../src/GmpManager/GmpManager.sol";
import {Token} from "../../src/MultiTokenNtt/Token.sol";
import "../mocks/WETH9.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {GenericDummyTransceiver} from "../mocks/DummyTransceiver.sol";

// We simulate a multi-chain environment by keeping all the addresses scoped to
// this contract.
contract TestDeployment is Test {
    uint16 public immutable chainId;
    MultiTokenNtt public immutable ntt;
    GmpManager public immutable gmpManager;

    constructor(
        uint16 _chainId
    ) {
        chainId = _chainId;
        // We pass on the msg.sender so it becomes the admin of the contracts
        // below. We could explicitly transfer ownership, but this is simpler.
        vm.startPrank(msg.sender);

        GmpManager gmpImplementation = new GmpManager(chainId);
        gmpManager = GmpManager(address(new ERC1967Proxy(address(gmpImplementation), "")));
        gmpManager.initialize();

        Token token = new Token();

        MockWETH9 weth = new MockWETH9();

        MultiTokenNtt implementation = new MultiTokenNtt(
            gmpManager,
            1 days, // rateLimitDuration
            false, // skipRateLimiting
            address(token),
            address(weth)
        );
        ntt = MultiTokenNtt(payable(address(new ERC1967Proxy(address(implementation), ""))));
        ntt.initialize();

        vm.stopPrank();
    }

    function addr(
        address a
    ) public view returns (address) {
        return address(uint160(a) ^ uint160(chainId));
    }

    function addTransceiver() public {
        vm.startPrank(msg.sender);
        GenericDummyTransceiver transceiver = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(transceiver));
        vm.stopPrank();
    }
}
