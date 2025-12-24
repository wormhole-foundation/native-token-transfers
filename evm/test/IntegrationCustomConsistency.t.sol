// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManager.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IRateLimiter.sol";
import "../src/interfaces/ITransceiver.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/IRateLimiterEvents.sol";
import "../src/interfaces/ICustomConsistencyLevel.sol";
import {Utils} from "./libraries/Utils.sol";
import {DummyToken, DummyTokenMintAndBurn} from "./NttManager.t.sol";
import "../src/interfaces/IWormholeTransceiver.sol";
import {WormholeTransceiver} from "../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import "../src/libraries/TransceiverStructs.sol";
import "../src/libraries/ConfigMakers.sol";
import "./mocks/MockNttManager.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";

contract TestCustomConsistencySepolia is Test, IRateLimiterEvents {
    NttManager nttManagerChain1;
    NttManager nttManagerChain2;

    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    uint16 constant chainId1 = 10002; // Ethereum Sepolia
    uint16 constant chainId2 = 23011; // Linea Sepolia
    uint8 constant CUSTOM_CONSISTENCY_LEVEL = 203;
    uint8 constant BASE_CONSISTENCY_LEVEL = 200;
    uint16 constant ADDTL_BLOCKS = 5;
    uint256 constant GAS_LIMIT = 500000;

    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;
    WormholeSimulator guardian;
    uint256 initialBlockTimestamp;

    WormholeTransceiver wormholeTransceiverChain1;
    WormholeTransceiver wormholeTransceiverChain2;
    address userA = address(0x123);
    address userB = address(0x456);

    // Testnet addresses
    // Ethereum Sepolia Wormhole: https://wormhole.com/docs/products/reference/chain-ids/
    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);
    address customConsistencyLevelAddress = 0x6A4B4A882F5F0a447078b4Fd0b4B571A82371ec2;

    function setUp() public {
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        vm.createSelectFork(url);
        initialBlockTimestamp = vm.getBlockTimestamp();

        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        vm.chainId(chainId1);
        DummyToken t1 = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(t1), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        nttManagerChain1 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        nttManagerChain1.initialize();

        // Deploy WormholeTransceiver with CUSTOM consistency level (203)
        WormholeTransceiver wormholeTransceiverChain1Implementation = new WormholeTransceiver(
            address(nttManagerChain1),
            address(wormhole),
            CUSTOM_CONSISTENCY_LEVEL,
            BASE_CONSISTENCY_LEVEL,
            ADDTL_BLOCKS,
            customConsistencyLevelAddress,
            GAS_LIMIT
        );
        wormholeTransceiverChain1 = WormholeTransceiver(
            address(new ERC1967Proxy(address(wormholeTransceiverChain1Implementation), ""))
        );

        // Record logs to capture ConfigSet event during initialization
        vm.recordLogs();
        wormholeTransceiverChain1.initialize();

        // Check that ConfigSet event was emitted during initialization
        Vm.Log[] memory initLogs = vm.getRecordedLogs();
        bool configSetFoundDuringInit = false;
        for (uint256 i = 0; i < initLogs.length; i++) {
            if (
                initLogs[i].topics[0] == keccak256("ConfigSet(address,bytes32)")
                    && initLogs[i].emitter == customConsistencyLevelAddress
            ) {
                configSetFoundDuringInit = true;
                if (initLogs[i].topics.length > 1) {
                    address emitterAddr = address(uint160(uint256(initLogs[i].topics[1])));
                    bytes32 configData = abi.decode(initLogs[i].data, (bytes32));
                    require(
                        emitterAddr == address(wormholeTransceiverChain1), "Wrong emitter address"
                    );
                    bytes32 expectedConfig = ConfigMakers.makeAdditionalBlocksConfig(
                        BASE_CONSISTENCY_LEVEL, ADDTL_BLOCKS
                    );
                    require(configData == expectedConfig, "Wrong config data");
                }
                break;
            }
        }
        require(configSetFoundDuringInit, "ConfigSet event must be emitted during init");

        nttManagerChain1.setTransceiver(address(wormholeTransceiverChain1));

        nttManagerChain1.setOutboundLimit(type(uint64).max);
        nttManagerChain1.setInboundLimit(type(uint64).max, chainId2);

        // Chain 2 setup - also with custom consistency level
        vm.chainId(chainId2);
        DummyToken t2 = new DummyTokenMintAndBurn();
        NttManager implementationChain2 = new MockNttManagerContract(
            address(t2), IManagerBase.Mode.BURNING, chainId2, 1 days, false
        );

        nttManagerChain2 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementationChain2), "")));
        nttManagerChain2.initialize();

        WormholeTransceiver wormholeTransceiverChain2Implementation = new WormholeTransceiver(
            address(nttManagerChain2),
            address(wormhole),
            CUSTOM_CONSISTENCY_LEVEL,
            BASE_CONSISTENCY_LEVEL,
            ADDTL_BLOCKS,
            customConsistencyLevelAddress,
            GAS_LIMIT
        );
        wormholeTransceiverChain2 = WormholeTransceiver(
            address(new ERC1967Proxy(address(wormholeTransceiverChain2Implementation), ""))
        );
        wormholeTransceiverChain2.initialize();

        nttManagerChain2.setTransceiver(address(wormholeTransceiverChain2));
        nttManagerChain2.setOutboundLimit(type(uint64).max);
        nttManagerChain2.setInboundLimit(type(uint64).max, chainId1);

        // Register peer contracts for the nttManager and transceiver
        nttManagerChain1.setPeer(
            chainId2, bytes32(uint256(uint160(address(nttManagerChain2)))), 9, type(uint64).max
        );
        nttManagerChain2.setPeer(
            chainId1, bytes32(uint256(uint160(address(nttManagerChain1)))), 7, type(uint64).max
        );

        // Set peers for the transceivers
        wormholeTransceiverChain1.setWormholePeer(
            chainId2, bytes32(uint256(uint160(address(wormholeTransceiverChain2))))
        );
        wormholeTransceiverChain2.setWormholePeer(
            chainId1, bytes32(uint256(uint160(address(wormholeTransceiverChain1))))
        );

        // Set thresholds
        nttManagerChain1.setThreshold(1);
        nttManagerChain2.setThreshold(1);
    }

    function test_sepoliaCustomConsistencyTransfer() public {
        vm.chainId(chainId1);

        // Verify CCL configuration was set during initialization
        bytes32 expectedConfig =
            ConfigMakers.makeAdditionalBlocksConfig(BASE_CONSISTENCY_LEVEL, ADDTL_BLOCKS);
        bytes32 actualConfig = ICustomConsistencyLevel(customConsistencyLevelAddress)
            .getConfiguration(address(wormholeTransceiverChain1));
        require(actualConfig == expectedConfig, "CCL configuration not set correctly");

        // Setting up the transfer
        DummyToken token1 = DummyToken(nttManagerChain1.token());
        DummyToken token2 = DummyTokenMintAndBurn(nttManagerChain2.token());

        uint8 decimals = token1.decimals();
        uint256 sendingAmount = 5 * 10 ** decimals;
        token1.mintDummy(address(userA), 5 * 10 ** decimals);
        vm.startPrank(userA);
        token1.approve(address(nttManagerChain1), sendingAmount);

        vm.recordLogs();

        // Send token through standard means (not relayer)
        {
            uint256 nttManagerBalanceBefore = token1.balanceOf(address(nttManagerChain1));
            uint256 userBalanceBefore = token1.balanceOf(address(userA));
            nttManagerChain1.transfer(sendingAmount, chainId2, bytes32(uint256(uint160(userB))));

            // Balance check on funds going in and out working as expected
            uint256 nttManagerBalanceAfter = token1.balanceOf(address(nttManagerChain1));
            uint256 userBalanceAfter = token1.balanceOf(address(userB));
            require(
                nttManagerBalanceBefore + sendingAmount == nttManagerBalanceAfter,
                "Should be locking the tokens"
            );
            require(
                userBalanceBefore - sendingAmount == userBalanceAfter,
                "User should have sent tokens"
            );
        }

        vm.stopPrank();

        // Get the TransferSent event
        Vm.Log[] memory recordedLogs = vm.getRecordedLogs();
        bytes32 sentEventDigest;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (recordedLogs[i].topics[0] == keccak256("TransferSent(bytes32)")) {
                sentEventDigest = recordedLogs[i].topics[1];
                break;
            }
        }
        require(sentEventDigest != bytes32(0), "TransferSent(bytes32) event should be found");

        // Get and sign the log to go to chain2
        Vm.Log[] memory entries = guardian.fetchWormholeMessageFromLog(recordedLogs);
        bytes[] memory encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId1);
        }

        // Chain2 verification and checks
        vm.chainId(chainId2);

        {
            uint256 supplyBefore = token2.totalSupply();
            wormholeTransceiverChain2.receiveMessage(encodedVMs[0]);
            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount + supplyBefore == supplyAfter, "Supplies dont match");
            require(token2.balanceOf(userB) == sendingAmount, "User didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0, "NttManager has unintended funds"
            );
        }
    }

    function test_sepoliaImmutables() public {
        // Test that CCL parameters are set correctly
        assertEq(wormholeTransceiverChain1.consistencyLevel(), CUSTOM_CONSISTENCY_LEVEL);
        assertEq(wormholeTransceiverChain1.customConsistencyLevel(), BASE_CONSISTENCY_LEVEL);
        assertEq(wormholeTransceiverChain1.addtlBlocks(), ADDTL_BLOCKS);
        assertEq(
            wormholeTransceiverChain1.customConsistencyLevelAddress(), customConsistencyLevelAddress
        );
    }

    function test_sepoliaRegularConsistencyNoConfig() public {
        // Deploy a transceiver with regular consistency level (not 203)
        // to verify CCL is NOT configured
        vm.chainId(chainId1);

        DummyToken t1 = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(t1), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        NttManager testManager =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        testManager.initialize();

        // Deploy with consistency level 200 (not 203)
        WormholeTransceiver testTransceiverImplementation = new WormholeTransceiver(
            address(testManager),
            address(wormhole),
            200, // Regular consistency level
            BASE_CONSISTENCY_LEVEL,
            ADDTL_BLOCKS,
            customConsistencyLevelAddress,
            GAS_LIMIT
        );
        WormholeTransceiver testTransceiver = WormholeTransceiver(
            address(new ERC1967Proxy(address(testTransceiverImplementation), ""))
        );

        vm.recordLogs();
        testTransceiver.initialize();

        // Check that NO ConfigSet event was emitted
        Vm.Log[] memory recordedLogs = vm.getRecordedLogs();
        bool configSetFound = false;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (
                recordedLogs[i].topics[0] == keccak256("ConfigSet(address,bytes32)")
                    && recordedLogs[i].emitter == customConsistencyLevelAddress
            ) {
                configSetFound = true;
                break;
            }
        }
        require(!configSetFound, "ConfigSet should NOT be emitted for non-203 consistency level");

        // Verify CCL was NOT configured
        bytes32 config = ICustomConsistencyLevel(customConsistencyLevelAddress)
            .getConfiguration(address(testTransceiver));
        require(config == bytes32(0), "CCL should not be configured for regular consistency");
    }
}
