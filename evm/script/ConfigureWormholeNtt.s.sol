// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IWormholeTransceiver.sol";
import "../src/interfaces/IOwnableUpgradeable.sol";

import {ParseNttConfig} from "./helpers/ParseNttConfig.sol";
import {WormholeTransceiver} from "../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import {WormholeTransceiverState} from
    "../src/Transceiver/WormholeTransceiver/WormholeTransceiverState.sol";

contract ConfigureWormholeNtt is ParseNttConfig {
    using stdJson for string;

    struct ConfigParams {
        uint16 wormholeChainId;
    }

    function _readEnvVariables() internal view returns (ConfigParams memory params) {
        // Chain ID.
        params.wormholeChainId = uint16(vm.envUint("RELEASE_WORMHOLE_CHAIN_ID"));
        require(params.wormholeChainId != 0, "Invalid chain ID");
    }

    function configureWormholeTransceiver(
        IWormholeTransceiver wormholeTransceiver,
        ChainConfig[] memory config,
        ConfigParams memory params
    ) internal {
        for (uint256 i = 0; i < config.length; i++) {
            ChainConfig memory targetConfig = config[i];
            if (targetConfig.chainId == params.wormholeChainId) {
                continue;
            } else {
                // Set relayer.
                if (targetConfig.isWormholeRelayingEnabled) {
                    wormholeTransceiver.setIsWormholeRelayingEnabled(targetConfig.chainId, true);
                    console2.log("Wormhole relaying enabled for chain", targetConfig.chainId);
                } else if (targetConfig.isSpecialRelayingEnabled) {
                    wormholeTransceiver.setIsSpecialRelayingEnabled(targetConfig.chainId, true);
                    console2.log("Special relaying enabled for chain", targetConfig.chainId);
                }
                uint256 messageFee =
                    WormholeTransceiverState(address(wormholeTransceiver)).wormhole().messageFee();
                // Set peer.
                wormholeTransceiver.setWormholePeer{value: messageFee}(
                    targetConfig.chainId, targetConfig.wormholeTransceiver
                );
                console2.log("Wormhole peer set for chain", targetConfig.chainId);

                // Set EVM chain.
                if (targetConfig.isEvmChain) {
                    wormholeTransceiver.setIsWormholeEvmChain(targetConfig.chainId, true);
                    console2.log("EVM chain set for chain", targetConfig.chainId);
                } else {
                    console2.log("This is not an EVM chain, doing nothing");
                }
            }
        }
    }

    function configureNttManager(
        INttManager nttManager,
        ChainConfig[] memory config,
        ConfigParams memory params
    ) internal {
        for (uint256 i = 0; i < config.length; i++) {
            ChainConfig memory targetConfig = config[i];
            if (targetConfig.chainId == params.wormholeChainId) {
                continue;
            } else {
                // Set peer.
                nttManager.setPeer(
                    targetConfig.chainId,
                    targetConfig.nttManager,
                    targetConfig.decimals,
                    targetConfig.inboundLimit
                );
                console2.log("Peer set for chain", targetConfig.chainId);
            }
        }
    }

    function run() public {
        vm.startBroadcast();

        // Sanity check deployment parameters.
        ConfigParams memory params = _readEnvVariables();
        (
            ChainConfig[] memory config,
            INttManager nttManager,
            IWormholeTransceiver wormholeTransceiver
        ) = _parseAndValidateConfigFile(params.wormholeChainId);

        configureWormholeTransceiver(wormholeTransceiver, config, params);
        configureNttManager(nttManager, config, params);

        vm.stopBroadcast();
    }
}
