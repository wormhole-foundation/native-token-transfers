// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console2} from "forge-std/Script.sol";
import {WormholeTransceiver} from "../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployWormholeTransceiver is Script {
    function run(
        address nttManager,
        address wormholeCoreBridge,
        address wormholeRelayerAddr,
        address specialRelayerAddr,
        uint8 consistencyLevel,
        uint256 gasLimit
    ) public {
        vm.startBroadcast();

        WormholeTransceiver implementation = new WormholeTransceiver(
            nttManager,
            wormholeCoreBridge,
            wormholeRelayerAddr,
            specialRelayerAddr,
            consistencyLevel,
            gasLimit
        );

        WormholeTransceiver transceiver = 
            WormholeTransceiver(address(implementation));

        console2.log("WormholeTransceiver address:", address(transceiver));

        vm.stopBroadcast();
    }
}
