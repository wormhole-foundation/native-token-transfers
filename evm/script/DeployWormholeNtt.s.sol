// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console} from "forge-std/Script.sol";
import {DeployWormholeNttBase} from "./helpers/DeployWormholeNttBase.sol";
import {INttManager} from "../src/interfaces/INttManager.sol";
import "../src/interfaces/IManagerBase.sol";
import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {NttManager} from "../src/NttManager/NttManager.sol";

interface IWormhole {
    function chainId() external view returns (uint16);
}

contract DeployWormholeNtt is Script, DeployWormholeNttBase {
    function run(
        address endpoint,
        address executor,
        address wormhole,
        address transceiver,
        address token,
        address wormholeRelayer,
        address specialRelayer,
        uint8 decimals,
        IManagerBase.Mode mode
    ) public {
        vm.startBroadcast();

        console.log("Deploying Wormhole Ntt...");
        IWormhole wh = IWormhole(wormhole);

        // sanity check decimals
        {
            (bool success, bytes memory queriedDecimals) =
                token.staticcall(abi.encodeWithSignature("decimals()"));

            if (success) {
                uint8 queriedDec = abi.decode(queriedDecimals, (uint8));
                if (queriedDec != decimals) {
                    console.log("Decimals mismatch: ", queriedDec, " != ", decimals);
                    vm.stopBroadcast();
                    return;
                }
            } else {
                // NOTE: this might not be a critical error. It could just mean that
                // the token contract was compiled against a different EVM version than what the forge script is running on.
                // In this case, it's the responsibility of the caller to ensure that the provided decimals are correct
                // and that the token contract is valid.
                // The best way to ensure that is by calling this script with the queried token decimals (which is what the NTT CLI does).
                console.log(
                    "Failed to query token decimals. Proceeding with provided decimals.", decimals
                );
                // the NTT manager initialiser calls the token contract to get the
                // decimals as well. We're just going to mock that call to return the provided decimals.
                // This is a bit of a hack, but in the worst case (i.e. if the token contract is actually broken), the
                // NTT manager initialiser will fail anyway.
                vm.mockCall(
                    token, abi.encodeWithSelector(ERC20.decimals.selector), abi.encode(decimals)
                );
            }
        }

        DeploymentParams memory params;
        {
            uint16 chainId = wh.chainId();

            console.log("Chain ID: ", chainId);

            uint256 scale =
                decimals > TRIMMED_DECIMALS ? uint256(10 ** (decimals - TRIMMED_DECIMALS)) : 1;

            params = DeploymentParams({
                endpointAddr: endpoint,
                executorAddr: executor,
                token: token,
                mode: mode,
                wormholeChainId: chainId,
                rateLimitDuration: 86400,
                shouldSkipRatelimiter: false,
                wormholeCoreBridge: wormhole,
                wormholeRelayerAddr: wormholeRelayer,
                specialRelayerAddr: specialRelayer,
                consistencyLevel: 202,
                gasLimit: 500000,
                // the trimming will trim this number to uint64.max
                outboundLimit: uint256(type(uint64).max) * scale
            });
        }

        // Deploy NttManager.
        {
            address manager = deployNttManager(params);

            // Configure NttManager.
            configureNttManager(
                manager, transceiver, params.outboundLimit, params.shouldSkipRatelimiter
            );
        }

        vm.stopBroadcast();
    }

    function upgrade(
        address manager
    ) public {
        vm.startBroadcast();

        NttManager nttManager = NttManager(manager);

        console.log("Upgrading manager...");

        uint64 rateLimitDuration = nttManager.rateLimitDuration();
        bool shouldSkipRatelimiter = rateLimitDuration == 0;

        NttManager implementation = new NttManager(
            address(nttManager.endpoint()),
            address(nttManager.executor()),
            nttManager.token(),
            nttManager.mode(),
            nttManager.chainId(),
            nttManager.rateLimitDuration(),
            shouldSkipRatelimiter
        );

        nttManager.upgrade(address(implementation));

        vm.stopBroadcast();
    }
}
