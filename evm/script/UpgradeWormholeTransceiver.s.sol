// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import "../src/interfaces/IWormholeTransceiver.sol";
import "../src/interfaces/ITransceiver.sol";
import "../src/interfaces/INttManager.sol";

import {WormholeTransceiver} from
    "../src/Transceiver/WormholeTransceiver/NttWormholeTransceiver.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ParseNttConfig} from "./helpers/ParseNttConfig.sol";

contract UpgradeWormholeTransceiver is ParseNttConfig {
    struct DeploymentParams {
        uint16 wormholeChainId;
        address wormholeCoreBridge;
        address wormholeRelayerAddr;
        address specialRelayerAddr;
        uint8 consistencyLevel;
        uint256 gasLimit;
        uint256 outboundLimit;
    }

    // The minimum gas limit to verify a message on mainnet. If you're worried about saving
    // gas on testnet, pick up the phone and start dialing!
    uint256 constant MIN_WORMHOLE_GAS_LIMIT = 150000;

    function upgradeWormholeTransceiver(
        IWormholeTransceiver wormholeTransceiverProxy,
        DeploymentParams memory params,
        address nttManager
    ) internal {
        // Deploy the Wormhole Transceiver.
        WormholeTransceiver implementation = new WormholeTransceiver(
            nttManager, params.wormholeCoreBridge, params.consistencyLevel, params.gasLimit
        );

        console2.log("WormholeTransceiver Implementation deployed at: ", address(implementation));

        // Upgrade the proxy.
        ITransceiver(address(wormholeTransceiverProxy)).upgrade(address(implementation));
    }

    function _readEnvVariables() internal view returns (DeploymentParams memory params) {
        // Chain ID.
        params.wormholeChainId = uint16(vm.envUint("RELEASE_WORMHOLE_CHAIN_ID"));
        require(params.wormholeChainId != 0, "Invalid chain ID");

        // Wormhole Core Bridge address.
        params.wormholeCoreBridge = vm.envAddress("RELEASE_CORE_BRIDGE_ADDRESS");
        require(params.wormholeCoreBridge != address(0), "Invalid wormhole core bridge address");

        // Wormhole relayer, special relayer, consistency level.
        params.wormholeRelayerAddr = vm.envAddress("RELEASE_WORMHOLE_RELAYER_ADDRESS");
        params.specialRelayerAddr = vm.envAddress("RELEASE_SPECIAL_RELAYER_ADDRESS");
        params.consistencyLevel = uint8(vm.envUint("RELEASE_CONSISTENCY_LEVEL"));

        params.gasLimit = vm.envUint("RELEASE_GAS_LIMIT");
        require(params.gasLimit >= MIN_WORMHOLE_GAS_LIMIT, "Invalid gas limit");

        // Outbound rate limiter limit.
        params.outboundLimit = vm.envUint("RELEASE_OUTBOUND_LIMIT");
    }

    function run() public {
        vm.startBroadcast();

        // Sanity check deployment parameters.
        DeploymentParams memory params = _readEnvVariables();
        (, INttManager nttManager, IWormholeTransceiver wormholeTransceiver) =
            _parseAndValidateConfigFile(params.wormholeChainId);

        // Upgrade WormholeTransceiver.
        upgradeWormholeTransceiver(wormholeTransceiver, params, address(nttManager));

        vm.stopBroadcast();
    }
}
