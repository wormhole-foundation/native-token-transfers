// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";
import {ParseNttConfig} from "./ParseNttConfig.sol";
import "../../src/interfaces/IManagerBase.sol";
import "../../src/interfaces/INttManager.sol";
import "../../src/interfaces/IWormholeTransceiver.sol";

import {NttManager} from "../../src/NttManager/NttManager.sol";
import {NttManagerNoRateLimiting} from "../../src/NttManager/NttManagerNoRateLimiting.sol";
import {NttManagerWethUnwrap} from "../../src/NttManager/NttManagerWethUnwrap.sol";
import {
    WormholeTransceiver
} from "../../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract DeployWormholeNttBase is ParseNttConfig {
    /// @notice Parameters for deploying NTT contracts
    /// @dev Custom Consistency Level (CCL) is enabled when consistencyLevel=203.
    ///      CCL parameters: customConsistencyLevel (200/201/202), additionalBlocks, customConsistencyLevelAddress
    ///      Example: consistencyLevel=203, customConsistencyLevel=200, additionalBlocks=3
    ///               → Wait 3 blocks after instant finality
    struct DeploymentParams {
        address token;
        IManagerBase.Mode mode;
        uint16 wormholeChainId;
        uint64 rateLimitDuration;
        bool shouldSkipRatelimiter;
        address wormholeCoreBridge;
        uint8 consistencyLevel; // Set to 203 to enable CCL
        uint8 customConsistencyLevel; // CCL only: finality level to start counting (200/201/202)
        uint16 additionalBlocks; // CCL only: additional blocks to wait
        address customConsistencyLevelAddress; // CCL only: CCL contract address
        uint256 outboundLimit;
    }

    function deployNttManagerImplementation(
        string memory variantStr,
        address token,
        IManagerBase.Mode mode,
        uint16 wormholeChainId,
        uint64 rateLimitDuration,
        bool shouldSkipRatelimiter
    ) internal returns (address implementation) {
        // Deploy the appropriate Manager Implementation based on variant
        if (keccak256(bytes(variantStr)) == keccak256(bytes("noRateLimiting"))) {
            console2.log("Deploying NttManagerNoRateLimiting variant");
            NttManagerNoRateLimiting impl =
                new NttManagerNoRateLimiting(token, mode, wormholeChainId);
            implementation = address(impl);
        } else if (keccak256(bytes(variantStr)) == keccak256(bytes("wethUnwrap"))) {
            console2.log("Deploying NttManagerWethUnwrap variant");
            NttManagerWethUnwrap impl = new NttManagerWethUnwrap(
                token, mode, wormholeChainId, rateLimitDuration, shouldSkipRatelimiter
            );
            implementation = address(impl);
        } else {
            // Default to standard NttManager
            console2.log("Deploying standard NttManager variant");
            NttManager impl = new NttManager(
                token, mode, wormholeChainId, rateLimitDuration, shouldSkipRatelimiter
            );
            implementation = address(impl);
        }
    }

    function deployNttManager(
        DeploymentParams memory params,
        string memory variantStr
    ) internal returns (address) {
        address implementation = deployNttManagerImplementation(
            variantStr,
            params.token,
            params.mode,
            params.wormholeChainId,
            params.rateLimitDuration,
            params.shouldSkipRatelimiter
        );

        // NttManager Proxy
        NttManager nttManagerProxy = NttManager(address(new ERC1967Proxy(implementation, "")));

        nttManagerProxy.initialize();

        console2.log("NttManager:", address(nttManagerProxy));

        return address(nttManagerProxy);
    }

    function deployWormholeTransceiver(
        DeploymentParams memory params,
        address nttManager
    ) public returns (address) {
        // Deploy the Wormhole Transceiver.
        WormholeTransceiver implementation = new WormholeTransceiver(
            nttManager,
            params.wormholeCoreBridge,
            params.consistencyLevel,
            params.customConsistencyLevel,
            params.additionalBlocks,
            params.customConsistencyLevelAddress
        );

        WormholeTransceiver transceiverProxy =
            WormholeTransceiver(address(new ERC1967Proxy(address(implementation), "")));

        IWormhole wh = IWormhole(params.wormholeCoreBridge);
        uint256 messageFee = wh.messageFee();
        // wh transceiver sends a WH_TRANSCEIVER_INIT_PREFIX message
        transceiverProxy.initialize{value: messageFee}();

        console2.log("WormholeTransceiver:", address(transceiverProxy));

        return address(transceiverProxy);
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

        // Hardcoded to one since these scripts handle Wormhole-only deployments.
        INttManager(nttManager).setThreshold(1);
        console2.log("Threshold set on NttManager: %d", uint256(1));
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

        // Consistency level and custom consistency level parameters.
        params.consistencyLevel = uint8(vm.envUint("RELEASE_CONSISTENCY_LEVEL"));
        params.customConsistencyLevel =
            uint8(vm.envOr("RELEASE_CUSTOM_CONSISTENCY_LEVEL", uint256(0)));
        params.additionalBlocks = uint16(vm.envOr("RELEASE_ADDITIONAL_BLOCKS", uint256(0)));
        params.customConsistencyLevelAddress =
            vm.envOr("RELEASE_CUSTOM_CONSISTENCY_LEVEL_ADDRESS", address(0));

        // Outbound rate limiter limit.
        params.outboundLimit = vm.envUint("RELEASE_OUTBOUND_LIMIT");
    }
}
