// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

// DEPLOY_SCRIPT_VERSION: 2

import {Script, console} from "forge-std/Script.sol";
import {DeployWormholeNttBase} from "./helpers/DeployWormholeNttBase.sol";
import {INttManager} from "../src/interfaces/INttManager.sol";
import {IWormholeTransceiver} from "../src/interfaces/IWormholeTransceiver.sol";
import "../src/interfaces/IManagerBase.sol";
import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {NttManager} from "../src/NttManager/NttManager.sol";
import {NttManagerNoRateLimiting} from "../src/NttManager/NttManagerNoRateLimiting.sol";
import {NttManagerWethUnwrap} from "../src/NttManager/NttManagerWethUnwrap.sol";

interface IWormhole {
    function chainId() external view returns (uint16);
}

contract DeployWormholeNtt is Script, DeployWormholeNttBase {
    function run() public {
        vm.startBroadcast();

        console.log("Deploying Wormhole Ntt...");

        // Read all parameters from environment variables
        address wormhole = vm.envAddress("RELEASE_CORE_BRIDGE_ADDRESS");
        address token = vm.envAddress("RELEASE_TOKEN_ADDRESS");
        uint8 decimals = uint8(vm.envUint("RELEASE_DECIMALS"));
        uint8 modeUint = uint8(vm.envUint("RELEASE_MODE"));
        IManagerBase.Mode mode =
            modeUint == 0 ? IManagerBase.Mode.LOCKING : IManagerBase.Mode.BURNING;
        string memory managerVariant = vm.envOr("MANAGER_VARIANT", string("standard"));

        IWormhole wh = IWormhole(wormhole);

        // sanity check decimals
        (bool success, bytes memory queriedDecimals) =
            token.staticcall(abi.encodeWithSignature("decimals()"));

        if (success) {
            uint8 queriedDecimalsValue = abi.decode(queriedDecimals, (uint8));
            if (queriedDecimalsValue != decimals) {
                console.log("Decimals mismatch: ", queriedDecimalsValue, " != ", decimals);
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

        uint16 chainId = wh.chainId();

        console.log("Chain ID: ", chainId);

        uint256 scale =
            decimals > TRIMMED_DECIMALS ? uint256(10 ** (decimals - TRIMMED_DECIMALS)) : 1;

        DeploymentParams memory params = DeploymentParams({
            token: token,
            mode: mode,
            wormholeChainId: chainId,
            rateLimitDuration: 86400,
            shouldSkipRatelimiter: false,
            wormholeCoreBridge: wormhole,
            consistencyLevel: uint8(vm.envUint("RELEASE_CONSISTENCY_LEVEL")),
            customConsistencyLevel: uint8(vm.envOr("RELEASE_CUSTOM_CONSISTENCY_LEVEL", uint256(0))),
            additionalBlocks: uint16(vm.envOr("RELEASE_ADDITIONAL_BLOCKS", uint256(0))),
            customConsistencyLevelAddress: vm.envOr(
                "RELEASE_CUSTOM_CONSISTENCY_LEVEL_ADDRESS", address(0)
            ),
            outboundLimit: uint256(type(uint64).max) * scale
        });

        // Deploy NttManager.
        address manager = deployNttManager(params, managerVariant);

        // Deploy Wormhole Transceiver.
        address transceiver = deployWormholeTransceiver(params, manager);

        // Configure NttManager.
        configureNttManager(
            manager, transceiver, params.outboundLimit, params.shouldSkipRatelimiter
        );

        vm.stopBroadcast();
    }

    function upgrade(
        address manager
    ) public {
        vm.startBroadcast();

        NttManager nttManager = NttManager(manager);

        console.log("Upgrading manager...");

        // Read manager variant from environment variable (defaults to "standard")
        string memory managerVariant = vm.envOr("MANAGER_VARIANT", string("standard"));

        uint64 rateLimitDuration = nttManager.rateLimitDuration();
        bool shouldSkipRatelimiter = rateLimitDuration == 0;

        // Deploy new implementation using helper function
        address implementation = deployNttManagerImplementation(
            managerVariant,
            nttManager.token(),
            nttManager.mode(),
            nttManager.chainId(),
            rateLimitDuration,
            shouldSkipRatelimiter
        );

        nttManager.upgrade(implementation);

        vm.stopBroadcast();
    }
}
