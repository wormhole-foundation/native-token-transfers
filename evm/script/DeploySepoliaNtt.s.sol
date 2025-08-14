// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console} from "forge-std/Script.sol";
import {DeployWormholeNttBase} from "./helpers/DeployWormholeNttBase.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/BridgedWQUAI.sol";

/**
 * @title DeploySepoliaNtt
 * @dev Deploys BridgedWQUAI token and NTT contracts on Sepolia
 * This creates the destination chain setup for Quai -> Sepolia bridging
 */
contract DeploySepoliaNtt is Script, DeployWormholeNttBase {
    function run() public {
        vm.startBroadcast();

        console.log("Deploying Sepolia NTT with BridgedWQUAI...");
        
        // Deploy BridgedWQUAI token first
        console.log("Deploying BridgedWQUAI token...");
        BridgedWQUAI token = new BridgedWQUAI();
        console.log("BridgedWQUAI deployed at:", address(token));

        // Get Wormhole core address from environment
        address wormholeCore = vm.envAddress("RELEASE_CORE_BRIDGE_ADDRESS");
        require(wormholeCore != address(0), "Invalid Wormhole core address");
        
        // Get relayer addresses (use zero addresses for manual relaying)
        address wormholeRelayer = vm.envOr("RELEASE_WORMHOLE_RELAYER_ADDRESS", address(0));
        address specialRelayer = vm.envOr("RELEASE_SPECIAL_RELAYER_ADDRESS", address(0));
        
        console.log("Wormhole Core:", wormholeCore);
        console.log("Wormhole Relayer:", wormholeRelayer);
        console.log("Special Relayer:", specialRelayer);

        // Set up deployment parameters for Sepolia (destination chain)
        DeploymentParams memory params = DeploymentParams({
            token: address(token),
            mode: IManagerBase.Mode.BURNING, // BURNING mode for destination chain
            wormholeChainId: 10002, // Sepolia Wormhole chain ID
            rateLimitDuration: uint64(vm.envOr("RELEASE_RATE_LIMIT_DURATION", uint256(86400))), // 24 hours
            shouldSkipRatelimiter: vm.envOr("RELEASE_SKIP_RATE_LIMIT", true),
            wormholeCoreBridge: wormholeCore,
            wormholeRelayerAddr: wormholeRelayer,
            specialRelayerAddr: specialRelayer,
            consistencyLevel: uint8(vm.envOr("RELEASE_CONSISTENCY_LEVEL", uint256(202))),
            gasLimit: vm.envOr("RELEASE_GAS_LIMIT", uint256(500000)),
            outboundLimit: vm.envOr("RELEASE_OUTBOUND_LIMIT", uint256(1000000000000000000000)) // 1000 WQUAI with 18 decimals
        });

        console.log("Deployment parameters:");
        console.log("  Mode: BURNING (destination chain)");
        console.log("  Wormhole Chain ID: 10002 (Sepolia)");
        console.log("  Rate Limit Duration:", params.rateLimitDuration);
        console.log("  Skip Rate Limit:", params.shouldSkipRatelimiter);
        console.log("  Outbound Limit:", params.outboundLimit);

        // Deploy NTT Manager
        address nttManager = deployNttManager(params);

        // Deploy Wormhole Transceiver
        address wormholeTransceiver = deployWormholeTransceiver(params, nttManager);

        // Configure NTT Manager
        configureNttManager(
            nttManager, 
            wormholeTransceiver, 
            params.outboundLimit, 
            params.shouldSkipRatelimiter
        );

        // Set NTT Manager as the minter (critical step!)
        console.log("Setting NTT Manager as BridgedWQUAI minter...");
        token.setMinter(nttManager);
        console.log("Token minter set to NTT Manager:", nttManager);

        console.log("\n=== Sepolia NTT Deployment Complete ===");
        console.log("BridgedWQUAI Token:", address(token));
        console.log("NTT Manager:", nttManager);
        console.log("Wormhole Transceiver:", wormholeTransceiver);
        console.log("Mode: BURNING (destination chain)");
        console.log("Wormhole Chain ID: 10002 (Sepolia)");
        console.log("========================================");

        vm.stopBroadcast();
    }
}