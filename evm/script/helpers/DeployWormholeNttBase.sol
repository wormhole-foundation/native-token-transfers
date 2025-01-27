// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";
import {ParseNttConfig} from "./ParseNttConfig.sol";
import "../../src/interfaces/IManagerBase.sol";
import "../../src/interfaces/INttManager.sol";

import {NttManager} from "../../src/NttManager/NttManager.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployWormholeNttBase is ParseNttConfig {
    struct DeploymentParams {
        address token;
        IManagerBase.Mode mode;
        uint16 wormholeChainId;
        uint64 rateLimitDuration;
        bool shouldSkipRatelimiter;
        address wormholeCoreBridge;
        address wormholeRelayerAddr;
        address specialRelayerAddr;
        address endpointAddr;
        address executorAddr;
        uint8 consistencyLevel;
        uint256 gasLimit;
        uint256 outboundLimit;
    }

    // The minimum gas limit to verify a message on mainnet. If you're worried about saving
    // gas on testnet, pick up the phone and start dialing!
    uint256 constant MIN_WORMHOLE_GAS_LIMIT = 150000;

    function deployNttManager(
        DeploymentParams memory params
    ) internal returns (address) {
        // Deploy the Manager Implementation.
        NttManager implementation = new NttManager(
            params.endpointAddr,
            params.executorAddr,
            params.token,
            params.mode,
            params.wormholeChainId,
            params.rateLimitDuration,
            params.shouldSkipRatelimiter
        );

        // NttManager Proxy
        NttManager nttManagerProxy =
            NttManager(address(new ERC1967Proxy(address(implementation), "")));

        nttManagerProxy.initialize();

        console2.log("NttManager:", address(nttManagerProxy));

        return address(nttManagerProxy);
    }

    function configureNttManager(
        address nttManager,
        address transceiver,
        uint256 outboundLimit,
        bool shouldSkipRateLimiter
    ) public {
        IManagerBase(nttManager).setTransceiver(transceiver);
        console2.log("Transceiver address set on NttManager: ", transceiver);

        if (!shouldSkipRateLimiter) {
            INttManager(nttManager).setOutboundLimit(outboundLimit);
            console2.log("Outbound rate limit set on NttManager: ", outboundLimit);
        }

        // TODO: Need to enable sending and receiving and set the threshold for the destination chains.
        // // Hardcoded to one since these scripts handle Wormhole-only deployments.
        // INttManager(nttManager).setThreshold(1);
        // console2.log("Threshold set on NttManager: %d", uint256(1));
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
}
