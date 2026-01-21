// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManager.sol";
import "../src/NttManager/NttManagerNoRateLimiting.sol";
import "../src/NttManager/NttManagerWethUnwrap.sol";
import "../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/IWormholeTransceiver.sol";
import "../src/interfaces/ICustomConsistencyLevel.sol";
import "../src/libraries/ConfigMakers.sol";
import {Utils} from "./libraries/Utils.sol";
import {DummyToken} from "./NttManager.t.sol";

import "../script/helpers/DeployWormholeNttBase.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import {WormholeSimulator} from "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";

/// @title DeploymentScriptsTest
/// @notice Tests for the deployment scripts to ensure they work correctly with the updated constructor signatures
/// @dev Custom Consistency Level (CCL) is enabled when consistency level is set to 203.
///      When CCL is enabled:
///      - customConsistencyLevel: The finality level where counting starts (200 = instant, 201 = safe, 202 = finalized)
///      - additionalBlocks: Additional blocks to wait beyond the custom consistency level
contract DeploymentScriptsTest is Test, DeployWormholeNttBase {
    using TrimmedAmountLib for uint256;

    uint16 constant TEST_CHAIN_ID = 10002; // Sepolia
    uint8 constant STANDARD_CONSISTENCY_LEVEL = 200; // Standard instant finality
    uint8 constant CCL_CONSISTENCY_LEVEL = 203; // Enables Custom Consistency Level feature
    uint8 constant CUSTOM_CONSISTENCY_LEVEL = 200; // Start counting from instant finality (200)
    uint16 constant ADDTL_BLOCKS = 3; // Wait 3 additional blocks beyond CCL
    uint64 constant RATE_LIMIT_DURATION = 1 days;

    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;

    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);
    WormholeSimulator guardian;

    DummyToken token;
    // Real CCL contract address on Sepolia and Linea
    address constant CCL_CONTRACT_ADDRESS = 0x6A4B4A882F5F0a447078b4Fd0b4B571A82371ec2;

    function setUp() public {
        // Fork Sepolia to get real Wormhole contracts
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        vm.createSelectFork(url);

        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        // Deploy test token
        token = new DummyToken();
    }

    /// @notice Test deploying standard NttManager variant
    function testDeployStandardNttManager() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.LOCKING);

        address manager = deployNttManager(params, "standard");

        // Verify deployment
        assertTrue(manager != address(0), "Manager should be deployed");

        NttManager nttManager = NttManager(manager);
        assertEq(address(nttManager.token()), address(token), "Token address mismatch");
        assertEq(uint8(nttManager.getMode()), uint8(IManagerBase.Mode.LOCKING), "Mode mismatch");
    }

    /// @notice Test deploying NttManagerNoRateLimiting variant
    function testDeployNoRateLimitingNttManager() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.BURNING);
        params.shouldSkipRatelimiter = true;

        address manager = deployNttManager(params, "noRateLimiting");

        // Verify deployment
        assertTrue(manager != address(0), "Manager should be deployed");

        NttManagerNoRateLimiting nttManager = NttManagerNoRateLimiting(manager);
        assertEq(address(nttManager.token()), address(token), "Token address mismatch");
        assertEq(uint8(nttManager.getMode()), uint8(IManagerBase.Mode.BURNING), "Mode mismatch");
    }

    /// @notice Test deploying NttManagerWethUnwrap variant
    function testDeployWethUnwrapNttManager() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.LOCKING);

        address manager = deployNttManager(params, "wethUnwrap");

        // Verify deployment
        assertTrue(manager != address(0), "Manager should be deployed");

        NttManagerWethUnwrap nttManager = NttManagerWethUnwrap(payable(manager));
        assertEq(address(nttManager.token()), address(token), "Token address mismatch");
        assertEq(uint8(nttManager.getMode()), uint8(IManagerBase.Mode.LOCKING), "Mode mismatch");
    }

    /// @notice Test deploying WormholeTransceiver with standard consistency level
    function testDeployWormholeTransceiverStandard() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.LOCKING);

        // Deploy manager first
        address manager = deployNttManager(params, "standard");

        // Deploy transceiver
        address transceiver = deployWormholeTransceiver(params, manager);

        // Verify deployment
        assertTrue(transceiver != address(0), "Transceiver should be deployed");

        WormholeTransceiver wormholeTransceiver = WormholeTransceiver(transceiver);
        assertEq(
            address(wormholeTransceiver.getNttManagerToken()),
            address(token),
            "Token address mismatch"
        );
        assertEq(
            wormholeTransceiver.consistencyLevel(),
            STANDARD_CONSISTENCY_LEVEL,
            "Consistency level mismatch"
        );
    }

    /// @notice Test deploying WormholeTransceiver with custom consistency level
    function testDeployWormholeTransceiverWithCCL() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.LOCKING);
        params.consistencyLevel = CCL_CONSISTENCY_LEVEL; // Enable CCL
        params.customConsistencyLevel = CUSTOM_CONSISTENCY_LEVEL;
        params.additionalBlocks = ADDTL_BLOCKS;
        params.customConsistencyLevelAddress = CCL_CONTRACT_ADDRESS;

        // Deploy manager first
        address manager = deployNttManager(params, "standard");

        // Deploy transceiver with CCL parameters
        address transceiver = deployWormholeTransceiver(params, manager);

        // Verify deployment
        assertTrue(transceiver != address(0), "Transceiver should be deployed");

        WormholeTransceiver wormholeTransceiver = WormholeTransceiver(transceiver);
        assertEq(
            wormholeTransceiver.customConsistencyLevel(),
            CUSTOM_CONSISTENCY_LEVEL,
            "Custom consistency level mismatch"
        );
        assertEq(wormholeTransceiver.additionalBlocks(), ADDTL_BLOCKS, "Additional blocks mismatch");
        assertEq(
            wormholeTransceiver.customConsistencyLevelAddress(),
            CCL_CONTRACT_ADDRESS,
            "CCL address mismatch"
        );

        // Verify that the CCL configuration was set in the CCL contract
        bytes32 expectedConfig =
            ConfigMakers.makeAdditionalBlocksConfig(CUSTOM_CONSISTENCY_LEVEL, ADDTL_BLOCKS);
        bytes32 actualConfig =
            ICustomConsistencyLevel(CCL_CONTRACT_ADDRESS).getConfiguration(transceiver);
        assertEq(actualConfig, expectedConfig, "CCL configuration not set correctly in contract");
    }

    /// @notice Test full deployment and configuration flow
    function testFullDeploymentFlow() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.LOCKING);

        // Deploy manager
        address manager = deployNttManager(params, "standard");

        // Deploy transceiver
        address transceiver = deployWormholeTransceiver(params, manager);

        // Configure manager - this should succeed without reverting
        configureNttManager(
            manager, transceiver, params.outboundLimit, params.shouldSkipRatelimiter
        );

        // Verify basic state
        INttManager nttManager = INttManager(manager);
        assertEq(nttManager.getThreshold(), 1, "Threshold should be 1");

        // Successful configuration means transceiver was set and limits were configured
        assertTrue(manager != address(0), "Manager should be deployed");
        assertTrue(transceiver != address(0), "Transceiver should be deployed");
    }

    /// @notice Test deployment without rate limiting
    function testDeploymentWithoutRateLimiting() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.BURNING);
        params.shouldSkipRatelimiter = true;

        // Deploy manager
        address manager = deployNttManager(params, "noRateLimiting");

        // Deploy transceiver
        address transceiver = deployWormholeTransceiver(params, manager);

        // Configure manager (should skip rate limit setup)
        configureNttManager(manager, transceiver, params.outboundLimit, true);

        // Verify threshold was set
        assertEq(INttManager(manager).getThreshold(), 1, "Threshold should be 1");
    }

    /// @notice Test that transceiver deployment works with zero address for CCL (disabled)
    function testDeploymentWithDisabledCCL() public {
        DeploymentParams memory params = _createTestParams(IManagerBase.Mode.LOCKING);
        params.customConsistencyLevel = 0;
        params.additionalBlocks = 0;
        params.customConsistencyLevelAddress = address(0);

        address manager = deployNttManager(params, "standard");
        address transceiver = deployWormholeTransceiver(params, manager);

        assertTrue(transceiver != address(0), "Transceiver should be deployed");

        WormholeTransceiver wormholeTransceiver = WormholeTransceiver(transceiver);
        assertEq(
            wormholeTransceiver.customConsistencyLevel(), 0, "Custom consistency level should be 0"
        );
        assertEq(wormholeTransceiver.additionalBlocks(), 0, "Additional blocks should be 0");
        assertEq(
            wormholeTransceiver.customConsistencyLevelAddress(),
            address(0),
            "CCL address should be zero"
        );
    }

    // ==================== Helper Functions ====================

    function _createTestParams(
        IManagerBase.Mode mode
    ) internal view returns (DeploymentParams memory) {
        return DeploymentParams({
            token: address(token),
            mode: mode,
            wormholeChainId: TEST_CHAIN_ID,
            rateLimitDuration: RATE_LIMIT_DURATION,
            shouldSkipRatelimiter: false,
            wormholeCoreBridge: address(wormhole),
            consistencyLevel: STANDARD_CONSISTENCY_LEVEL, // Use standard by default
            customConsistencyLevel: 0,
            additionalBlocks: 0,
            customConsistencyLevelAddress: address(0),
            outboundLimit: type(uint64).max
        });
    }
}
