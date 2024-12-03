// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManager.sol";
import "../src/Transceiver/Transceiver.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IRateLimiter.sol";
import "../src/interfaces/ITransceiver.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/IRateLimiterEvents.sol";
import {Utils} from "./libraries/Utils.sol";
import {DummyToken, DummyTokenMintAndBurn} from "./NttManager.t.sol";
import "../src/interfaces/IWormholeTransceiver.sol";
import {WormholeTransceiver} from "../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import "../src/libraries/TransceiverStructs.sol";
import "./mocks/MockNttManager.sol";
import "./mocks/MockTransceivers.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";
//import "wormhole-solidity-sdk/testing/WormholeRelayerTest.sol";

contract TestEndToEndBase is Test, IRateLimiterEvents {
    NttManager nttManagerChain1;
    NttManager nttManagerChain2;

    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    uint16 constant chainId1 = 7;
    uint16 constant chainId2 = 100;
    uint8 constant FAST_CONSISTENCY_LEVEL = 200;
    uint256 constant GAS_LIMIT = 500000;

    uint16 constant SENDING_CHAIN_ID = 1;
    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;
    WormholeSimulator guardian;
    uint256 initialBlockTimestamp;

    WormholeTransceiver wormholeTransceiverChain1;
    WormholeTransceiver wormholeTransceiverChain2;
    address userA = address(0x123);
    address userB = address(0x456);
    address userC = address(0x789);
    address userD = address(0xABC);

    address relayer = address(0x28D8F1Be96f97C1387e94A53e00eCcFb4E75175a);
    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);

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

        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain1 = MockWormholeTransceiverContract(
            address(new ERC1967Proxy(address(wormholeTransceiverChain1Implementation), ""))
        );

        // Only the deployer should be able to initialize
        vm.prank(userA);
        vm.expectRevert(
            abi.encodeWithSelector(ITransceiver.UnexpectedDeployer.selector, address(this), userA)
        );
        wormholeTransceiverChain1.initialize();

        // Actually initialize properly now
        wormholeTransceiverChain1.initialize();

        nttManagerChain1.setTransceiver(address(wormholeTransceiverChain1));
        nttManagerChain1.setOutboundLimit(type(uint64).max);
        nttManagerChain1.setInboundLimit(type(uint64).max, chainId2);

        // Chain 2 setup
        vm.chainId(chainId2);
        DummyToken t2 = new DummyTokenMintAndBurn();
        NttManager implementationChain2 = new MockNttManagerContract(
            address(t2), IManagerBase.Mode.BURNING, chainId2, 1 days, false
        );

        nttManagerChain2 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementationChain2), "")));
        nttManagerChain2.initialize();

        WormholeTransceiver wormholeTransceiverChain2Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain2),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain2 = MockWormholeTransceiverContract(
            address(new ERC1967Proxy(address(wormholeTransceiverChain2Implementation), ""))
        );
        wormholeTransceiverChain2.initialize();

        nttManagerChain2.setTransceiver(address(wormholeTransceiverChain2));
        nttManagerChain2.setOutboundLimit(type(uint64).max);
        nttManagerChain2.setInboundLimit(type(uint64).max, chainId1);

        // Register peer contracts for the nttManager and transceiver. Transceivers and nttManager each have the concept of peers here.
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

        require(nttManagerChain1.getThreshold() != 0, "Threshold is zero with active transceivers");

        // Actually set it
        nttManagerChain1.setThreshold(1);
        nttManagerChain2.setThreshold(1);
    }

    function test_chainToChainBase() public {
        vm.chainId(chainId1);

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

        // Get the TransferSent(bytes32) event digest to ensure it matches up with the TransferRedeemed(uint16,bytes32) event digest later
        Vm.Log[] memory recordedLogs = vm.getRecordedLogs();
        bytes32 sentEventDigest;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (recordedLogs[i].topics[0] == keccak256("TransferSent(bytes32)")) {
                sentEventDigest = recordedLogs[i].topics[1];
                break;
            }
        }
        require(sentEventDigest != bytes32(0), "TransferSent(bytes32) event should be found");

        // Get and sign the log to go down the other pipe. Thank you to whoever wrote this code in the past!
        Vm.Log[] memory entries = guardian.fetchWormholeMessageFromLog(recordedLogs);
        bytes[] memory encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId1);
        }

        // Chain2 verification and checks
        vm.chainId(chainId2);

        // Wrong chain receiving the signed VAA
        vm.expectRevert(abi.encodeWithSelector(InvalidFork.selector, chainId1, chainId2));
        wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);
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

        // Get the TransferRedeemed(uint16,bytes32) event digest to ensure it matches up with the TransferSent(bytes32) event digest earlier
        recordedLogs = vm.getRecordedLogs();
        bytes32 recvEventDigest;
        bytes32 recvSourceChain;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (recordedLogs[i].topics[0] == keccak256("TransferRedeemed(uint16,bytes32)")) {
                recvSourceChain = recordedLogs[i].topics[1];
                recvEventDigest = recordedLogs[i].topics[2];
                break;
            }
        }
        require(
            recvSourceChain == bytes32(uint256(chainId1)),
            "Incorrect TransferRedeemed(uint16,bytes32) event sourceChain"
        );
        require(
            sentEventDigest == recvEventDigest,
            "TransferRedeemed(uint16,bytes32) event digest should match TransferSent(bytes32) event digest"
        );

        // Can't resubmit the same message twice
        (IWormhole.VM memory wormholeVM,,) = wormhole.parseAndVerifyVM(encodedVMs[0]);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeTransceiver.TransferAlreadyCompleted.selector, wormholeVM.hash
            )
        );
        wormholeTransceiverChain2.receiveMessage(encodedVMs[0]);

        // Go back the other way from a THIRD user
        vm.prank(userB);
        token2.transfer(userC, sendingAmount);

        vm.startPrank(userC);
        token2.approve(address(nttManagerChain2), sendingAmount);
        vm.recordLogs();

        // Supply checks on the transfer
        {
            uint256 supplyBefore = token2.totalSupply();
            nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userD),
                toWormholeFormat(userC),
                false,
                encodeTransceiverInstruction(true)
            );

            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount - supplyBefore == supplyAfter, "Supplies don't match");
            require(token2.balanceOf(userB) == 0, "OG user receive tokens");
            require(token2.balanceOf(userC) == 0, "Sending user didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManager didn't receive unintended funds"
            );
        }

        // Get and sign the log to go down the other pipe. Thank you to whoever wrote this code in the past!
        entries = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId2);
        }

        // Chain1 verification and checks with the receiving of the message
        vm.chainId(chainId1);

        {
            uint256 supplyBefore = token1.totalSupply();
            wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);

            uint256 supplyAfter = token1.totalSupply();

            require(supplyBefore == supplyAfter, "Supplies don't match between operations");
            require(token1.balanceOf(userB) == 0, "OG user receive tokens");
            require(token1.balanceOf(userC) == 0, "Sending user didn't receive tokens");
            require(token1.balanceOf(userD) == sendingAmount, "User received funds");
        }
    }

    function test_lotsOfReverts() public {
        vm.chainId(chainId1);

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
            nttManagerChain1.transfer(
                sendingAmount,
                chainId2,
                toWormholeFormat(userB),
                toWormholeFormat(userA),
                true,
                encodeTransceiverInstruction(true)
            );

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

        // Get and sign the log to go down the other pipe. Thank you to whoever wrote this code in the past!
        Vm.Log[] memory entries = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        bytes[] memory encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId1);
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeTransceiver.InvalidWormholePeer.selector,
                chainId1,
                wormholeTransceiverChain1
            )
        ); // Wrong chain receiving the signed VAA
        wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);

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

        // Can't resubmit the same message twice
        (IWormhole.VM memory wormholeVM,,) = wormhole.parseAndVerifyVM(encodedVMs[0]);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeTransceiver.TransferAlreadyCompleted.selector, wormholeVM.hash
            )
        );
        wormholeTransceiverChain2.receiveMessage(encodedVMs[0]);

        // Go back the other way from a THIRD user
        vm.prank(userB);
        token2.transfer(userC, sendingAmount);

        vm.startPrank(userC);
        token2.approve(address(nttManagerChain2), sendingAmount);
        vm.recordLogs();

        // Supply checks on the transfer
        {
            uint256 supplyBefore = token2.totalSupply();

            vm.stopPrank();
            nttManagerChain2.setOutboundLimit(0);

            vm.startPrank(userC);
            nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userD),
                toWormholeFormat(userC),
                true,
                encodeTransceiverInstruction(true)
            );

            // Test timing on the queues
            vm.expectRevert(
                abi.encodeWithSelector(
                    IRateLimiter.OutboundQueuedTransferStillQueued.selector,
                    0,
                    vm.getBlockTimestamp()
                )
            );
            nttManagerChain2.completeOutboundQueuedTransfer(0);
            vm.warp(vm.getBlockTimestamp() + 1 days - 1);

            vm.expectRevert(
                abi.encodeWithSelector(
                    IRateLimiter.OutboundQueuedTransferStillQueued.selector,
                    0,
                    vm.getBlockTimestamp() - 1 days + 1
                )
            );
            nttManagerChain2.completeOutboundQueuedTransfer(0);

            vm.warp(vm.getBlockTimestamp() + 1);
            nttManagerChain2.completeOutboundQueuedTransfer(0);

            // Replay - should be deleted
            vm.expectRevert(
                abi.encodeWithSelector(IRateLimiter.OutboundQueuedTransferNotFound.selector, 0)
            );
            nttManagerChain2.completeOutboundQueuedTransfer(0);

            // Non-existant
            vm.expectRevert(
                abi.encodeWithSelector(IRateLimiter.OutboundQueuedTransferNotFound.selector, 1)
            );
            nttManagerChain2.completeOutboundQueuedTransfer(1);

            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount - supplyBefore == supplyAfter, "Supplies don't match");
            require(token2.balanceOf(userB) == 0, "OG user receive tokens");
            require(token2.balanceOf(userC) == 0, "Sending user didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManager didn't receive unintended funds"
            );
        }

        // Get and sign the log to go down the other pipe. Thank you to whoever wrote this code in the past!
        entries = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId2);
        }

        // Chain1 verification and checks with the receiving of the message
        vm.chainId(chainId1);
        vm.stopPrank(); // Back to the owner of everything for this one.
        vm.recordLogs();

        {
            uint256 supplyBefore = token1.totalSupply();

            nttManagerChain1.setInboundLimit(0, chainId2);
            wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);

            bytes32[] memory queuedDigests =
                Utils.fetchQueuedTransferDigestsFromLogs(vm.getRecordedLogs());

            vm.warp(vm.getBlockTimestamp() + 100000);
            nttManagerChain1.completeInboundQueuedTransfer(queuedDigests[0]);

            // Double redeem
            vm.warp(vm.getBlockTimestamp() + 100000);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IRateLimiter.InboundQueuedTransferNotFound.selector, queuedDigests[0]
                )
            );
            nttManagerChain1.completeInboundQueuedTransfer(queuedDigests[0]);

            uint256 supplyAfter = token1.totalSupply();

            require(supplyBefore == supplyAfter, "Supplies don't match between operations");
            require(token1.balanceOf(userB) == 0, "OG user receive tokens");
            require(token1.balanceOf(userC) == 0, "Sending user didn't receive tokens");
            require(token1.balanceOf(userD) == sendingAmount, "User received funds");
        }
    }

    function test_multiTransceiver() public {
        vm.chainId(chainId1);

        WormholeTransceiver wormholeTransceiverChain1_1 = wormholeTransceiverChain1;

        // Dual transceiver setup
        WormholeTransceiver wormholeTransceiverChain1_2 = new MockWormholeTransceiverContract(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );

        wormholeTransceiverChain1_2 = MockWormholeTransceiverContract(
            address(new ERC1967Proxy(address(wormholeTransceiverChain1_2), ""))
        );
        wormholeTransceiverChain1_2.initialize();

        vm.chainId(chainId2);
        WormholeTransceiver wormholeTransceiverChain2_1 = wormholeTransceiverChain2;

        // Dual transceiver setup
        WormholeTransceiver wormholeTransceiverChain2_2 = new MockWormholeTransceiverContract(
            address(nttManagerChain2),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );

        wormholeTransceiverChain2_2 = MockWormholeTransceiverContract(
            address(new ERC1967Proxy(address(wormholeTransceiverChain2_2), ""))
        );
        wormholeTransceiverChain2_2.initialize();

        // Setup the new entrypoint hook ups to allow the transfers to occur
        wormholeTransceiverChain1_2.setWormholePeer(
            chainId2, bytes32(uint256(uint160((address(wormholeTransceiverChain2_2)))))
        );
        wormholeTransceiverChain2_2.setWormholePeer(
            chainId1, bytes32(uint256(uint160((address(wormholeTransceiverChain1_2)))))
        );
        nttManagerChain2.setTransceiver(address(wormholeTransceiverChain2_2));
        nttManagerChain1.setTransceiver(address(wormholeTransceiverChain1_2));

        // Change the threshold from the setUp functions 1 to 2.
        nttManagerChain1.setThreshold(2);
        nttManagerChain2.setThreshold(2);

        // Setting up the transfer
        DummyToken token1 = DummyToken(nttManagerChain1.token());
        DummyToken token2 = DummyTokenMintAndBurn(nttManagerChain2.token());

        vm.startPrank(userA);
        uint8 decimals = token1.decimals();
        uint256 sendingAmount = 5 * 10 ** decimals;
        token1.mintDummy(address(userA), sendingAmount);
        vm.startPrank(userA);
        token1.approve(address(nttManagerChain1), sendingAmount);

        vm.chainId(chainId1);
        vm.recordLogs();

        // Send token through standard means (not relayer)
        {
            nttManagerChain1.transfer(
                sendingAmount,
                chainId2,
                toWormholeFormat(userB),
                toWormholeFormat(userA),
                false,
                encodeTransceiverInstructions(true)
            );
        }

        // Get and sign the event emissions to go to the other chain.
        Vm.Log[] memory entries = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        bytes[] memory encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId1);
        }

        vm.chainId(chainId2);

        // Send in the messages for the two transceivers to complete the transfer from chain1 to chain2
        {
            // vm.stopPrank();
            uint256 supplyBefore = token2.totalSupply();
            wormholeTransceiverChain2_1.receiveMessage(encodedVMs[0]);

            vm.expectRevert(
                abi.encodeWithSelector(
                    IWormholeTransceiver.InvalidWormholePeer.selector,
                    chainId1,
                    wormholeTransceiverChain1_1
                )
            );
            wormholeTransceiverChain2_2.receiveMessage(encodedVMs[0]);

            // Threshold check
            require(supplyBefore == token2.totalSupply(), "Supplies have been updated too early");
            require(token2.balanceOf(userB) == 0, "User received tokens to early");

            // Finish the transfer out once the second VAA arrives
            wormholeTransceiverChain2_2.receiveMessage(encodedVMs[1]);
            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount + supplyBefore == supplyAfter, "Supplies dont match");
            require(token2.balanceOf(userB) == sendingAmount, "User didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0, "NttManager has unintended funds"
            );
        }

        // Back the other way for the burn!
        vm.startPrank(userB);
        token2.approve(address(nttManagerChain2), sendingAmount);

        vm.recordLogs();

        // Send token through standard means (not relayer)
        {
            uint256 userBalanceBefore = token1.balanceOf(address(userB));
            nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userA),
                toWormholeFormat(userB),
                false,
                encodeTransceiverInstructions(true)
            );
            uint256 nttManagerBalanceAfter = token1.balanceOf(address(nttManagerChain2));
            uint256 userBalanceAfter = token1.balanceOf(address(userB));

            require(userBalanceBefore - userBalanceAfter == 0, "No funds left for user");
            require(nttManagerBalanceAfter == 0, "NttManager should burn all tranferred tokens");
        }

        // Get the VAA proof for the transfers to use
        entries = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        encodedVMs = new bytes[](entries.length);
        for (uint256 i = 0; i < encodedVMs.length; i++) {
            encodedVMs[i] = guardian.fetchSignedMessageFromLogs(entries[i], chainId2);
        }

        vm.chainId(chainId1);
        {
            uint256 supplyBefore = token1.totalSupply();
            wormholeTransceiverChain1_1.receiveMessage(encodedVMs[0]);

            require(supplyBefore == token1.totalSupply(), "Supplies have been updated too early");
            require(token2.balanceOf(userA) == 0, "User received tokens to early");

            // Finish the transfer out once the second VAA arrives
            wormholeTransceiverChain1_2.receiveMessage(encodedVMs[1]);
            uint256 supplyAfter = token1.totalSupply();

            require(
                supplyBefore == supplyAfter,
                "Supplies don't match between operations. Should not increase."
            );
            require(token1.balanceOf(userB) == 0, "Sending user receive tokens");
            require(
                token1.balanceOf(userA) == sendingAmount, "Receiving user didn't receive tokens"
            );
        }

        vm.stopPrank();
    }

    function copyBytes(
        bytes memory _bytes
    ) private pure returns (bytes memory) {
        bytes memory copy = new bytes(_bytes.length);
        uint256 max = _bytes.length + 31;
        for (uint256 i = 32; i <= max; i += 32) {
            assembly {
                mstore(add(copy, i), mload(add(_bytes, i)))
            }
        }
        return copy;
    }

    function encodeTransceiverInstruction(
        bool relayer_off
    ) public view returns (bytes memory) {
        WormholeTransceiver.WormholeTransceiverInstruction memory instruction =
            IWormholeTransceiver.WormholeTransceiverInstruction(relayer_off);
        bytes memory encodedInstructionWormhole =
            wormholeTransceiverChain1.encodeWormholeTransceiverInstruction(instruction);
        TransceiverStructs.TransceiverInstruction memory TransceiverInstruction = TransceiverStructs
            .TransceiverInstruction({index: 0, payload: encodedInstructionWormhole});
        TransceiverStructs.TransceiverInstruction[] memory TransceiverInstructions =
            new TransceiverStructs.TransceiverInstruction[](1);
        TransceiverInstructions[0] = TransceiverInstruction;
        return TransceiverStructs.encodeTransceiverInstructions(TransceiverInstructions);
    }

    // Encode an instruction for each of the relayers
    function encodeTransceiverInstructions(
        bool relayer_off
    ) public view returns (bytes memory) {
        WormholeTransceiver.WormholeTransceiverInstruction memory instruction =
            IWormholeTransceiver.WormholeTransceiverInstruction(relayer_off);

        bytes memory encodedInstructionWormhole =
            wormholeTransceiverChain1.encodeWormholeTransceiverInstruction(instruction);

        TransceiverStructs.TransceiverInstruction memory TransceiverInstruction1 =
        TransceiverStructs.TransceiverInstruction({index: 0, payload: encodedInstructionWormhole});
        TransceiverStructs.TransceiverInstruction memory TransceiverInstruction2 =
        TransceiverStructs.TransceiverInstruction({index: 1, payload: encodedInstructionWormhole});

        TransceiverStructs.TransceiverInstruction[] memory TransceiverInstructions =
            new TransceiverStructs.TransceiverInstruction[](2);

        TransceiverInstructions[0] = TransceiverInstruction1;
        TransceiverInstructions[1] = TransceiverInstruction2;

        return TransceiverStructs.encodeTransceiverInstructions(TransceiverInstructions);
    }
}
