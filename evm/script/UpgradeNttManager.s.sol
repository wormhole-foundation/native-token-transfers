// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IManagerBase.sol";

import {NttManager} from "../src/NttManager/NttManager.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ParseNttConfig} from "./helpers/ParseNttConfig.sol";

contract UpgradeNttManager is ParseNttConfig {
    struct DeploymentParams {
        address endpoint;
        address executor;
        address token;
        INttManager.Mode mode;
        uint16 wormholeChainId;
        uint64 rateLimitDuration;
        bool shouldSkipRatelimiter;
    }

    function upgradeNttManager(
        INttManager nttManagerProxy,
        DeploymentParams memory params
    ) internal {
        // Deploy the Manager Implementation.
        NttManager implementation = new NttManager(
            params.endpoint,
            params.executor,
            params.token,
            params.mode,
            params.wormholeChainId,
            params.rateLimitDuration,
            params.shouldSkipRatelimiter
        );

        console2.log("NttManager Implementation deployed at: ", address(implementation));

        // Upgrade the proxy.
        nttManagerProxy.upgrade(address(implementation));
    }

    function _readEnvVariables() internal view returns (DeploymentParams memory params) {
        // Token address.
        params.token = vm.envAddress("RELEASE_TOKEN_ADDRESS");
        require(params.token != address(0), "Invalid token address");

        // Mode.
        uint8 mode = uint8(vm.envUint("RELEASE_MODE"));
        if (mode == 0) {
            params.mode = IManagerBase.Mode.LOCKING;
        } else if (mode == 1) {
            params.mode = IManagerBase.Mode.BURNING;
        } else {
            revert("Invalid mode");
        }

        // Chain ID.
        params.wormholeChainId = uint16(vm.envUint("RELEASE_WORMHOLE_CHAIN_ID"));
        require(params.wormholeChainId != 0, "Invalid chain ID");

        // Rate limit duration.
        params.rateLimitDuration = uint64(vm.envUint("RELEASE_RATE_LIMIT_DURATION"));
        params.shouldSkipRatelimiter = vm.envBool("RELEASE_SKIP_RATE_LIMIT");
    }

    function run() public {
        vm.startBroadcast();

        // Sanity check deployment parameters.
        DeploymentParams memory params = _readEnvVariables();
        (, INttManager nttManager,) = _parseAndValidateConfigFile(params.wormholeChainId);

        // Deploy NttManager.
        upgradeNttManager(nttManager, params);

        vm.stopBroadcast();
    }
}
