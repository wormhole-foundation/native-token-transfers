// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import "example-messaging-endpoint/evm/src/interfaces/IAdapter.sol";

import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IOwnableUpgradeable.sol";

import {ParseNttConfig} from "./helpers/ParseNttConfig.sol";

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
                    targetConfig.gasLimit,
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
        (ChainConfig[] memory config, INttManager nttManager,) =
            _parseAndValidateConfigFile(params.wormholeChainId);

        configureNttManager(nttManager, config, params);

        vm.stopBroadcast();
    }
}
