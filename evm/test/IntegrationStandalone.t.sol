// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManager.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IRateLimiter.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/IRateLimiterEvents.sol";
import {Utils} from "./libraries/Utils.sol";
import {DummyToken, DummyTokenMintAndBurn} from "./NttManager.t.sol";
import "../src/libraries/TransceiverStructs.sol";
import "./libraries/TransceiverHelpers.sol";
import "./mocks/DummyTransceiver.sol";
import "./mocks/MockNttManager.sol";
import "./mocks/MockEndpoint.sol";
import "./mocks/MockExecutor.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";
import "example-messaging-endpoint/evm/src/Endpoint.sol";

contract TestEndToEndBase is Test, IRateLimiterEvents {
    NttManager nttManagerChain1;
    NttManager nttManagerChain2;

    MockEndpoint endpointChain1;
    MockEndpoint endpointChain2;

    MockExecutor executorChain1;
    MockExecutor executorChain2;

    DummyTransceiver transceiverChain1;
    DummyTransceiver transceiverChain2;

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

        endpointChain1 = new MockEndpoint(chainId1);
        endpointChain2 = new MockEndpoint(chainId2);

        executorChain1 = new MockExecutor(chainId1);
        executorChain2 = new MockExecutor(chainId2);

        vm.chainId(chainId1);
        DummyToken t1 = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(endpointChain1),
            address(executorChain1),
            address(t1),
            IManagerBase.Mode.LOCKING,
            chainId1,
            1 days,
            false
        );

        nttManagerChain1 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        nttManagerChain1.initialize();

        transceiverChain1 = new DummyTransceiver(chainId1, address(endpointChain1));
        nttManagerChain1.setTransceiver(address(transceiverChain1));
        nttManagerChain1.enableSendTransceiver(chainId2, address(transceiverChain1));
        nttManagerChain1.enableRecvTransceiver(chainId2, address(transceiverChain1));

        nttManagerChain1.setOutboundLimit(type(uint64).max);
        nttManagerChain1.setInboundLimit(type(uint64).max, chainId2);

        // Chain 2 setup
        vm.chainId(chainId2);
        DummyToken t2 = new DummyTokenMintAndBurn();
        NttManager implementationChain2 = new MockNttManagerContract(
            address(endpointChain2),
            address(executorChain2),
            address(t2),
            IManagerBase.Mode.BURNING,
            chainId2,
            1 days,
            false
        );

        nttManagerChain2 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementationChain2), "")));
        nttManagerChain2.initialize();

        transceiverChain2 = new DummyTransceiver(chainId2, address(endpointChain2));
        nttManagerChain2.setTransceiver(address(transceiverChain2));
        nttManagerChain2.enableSendTransceiver(chainId1, address(transceiverChain2));
        nttManagerChain2.enableRecvTransceiver(chainId1, address(transceiverChain2));

        nttManagerChain2.setOutboundLimit(type(uint64).max);
        nttManagerChain2.setInboundLimit(type(uint64).max, chainId2);

        // Register peer contracts for the nttManager and transceiver. Transceivers and nttManager each have the concept of peers here.
        nttManagerChain1.setPeer(
            chainId2,
            bytes32(uint256(uint160(address(nttManagerChain2)))),
            9,
            NttManagerHelpersLib.gasLimit,
            type(uint64).max
        );
        nttManagerChain2.setPeer(
            chainId1,
            bytes32(uint256(uint160(address(nttManagerChain1)))),
            7,
            NttManagerHelpersLib.gasLimit,
            type(uint64).max
        );

        require(
            nttManagerChain1.getThreshold(chainId2) != 0,
            "Threshold is zero with active transceivers"
        );

        nttManagerChain1.setThreshold(chainId2, 1);
        nttManagerChain2.setThreshold(chainId1, 1);
    }

    function test_setUp() public {}

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
        uint64 seqNo;
        {
            uint256 nttManagerBalanceBefore = token1.balanceOf(address(nttManagerChain1));
            uint256 userBalanceBefore = token1.balanceOf(address(userA));
            seqNo = nttManagerChain1.transfer(
                sendingAmount,
                chainId2,
                bytes32(uint256(uint160(userB))),
                executorChain1.createSignedQuote(executorChain2.chainId()),
                executorChain1.createRelayInstructions(),
                endpointChain1.createAdapterInstructions()
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

        assertEq(0, seqNo);
        DummyTransceiver.Message[] memory rmsgs = transceiverChain1.getMessages();
        assertEq(1, rmsgs.length);

        // Get the execution events from the logs.
        Vm.Log[] memory logEvents = vm.getRecordedLogs();

        bytes memory encoded =
            TransceiverHelpersLib.getExecutionSent(logEvents, address(nttManagerChain1), seqNo);

        vm.stopPrank();

        // Chain2 verification and checks
        vm.chainId(chainId2);

        // Wrong chain receiving the attestation.
        vm.expectRevert(abi.encodeWithSelector(Endpoint.InvalidDestinationChain.selector));
        transceiverChain1.receiveMessage(rmsgs[0]);

        // Right chain receiving the attestation.
        transceiverChain2.receiveMessage(rmsgs[0]);

        {
            uint256 supplyBefore = token2.totalSupply();
            nttManagerChain2.executeMsg(
                rmsgs[0].srcChain, rmsgs[0].srcAddr, rmsgs[0].sequence, encoded
            );
            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount + supplyBefore == supplyAfter, "Supplies dont match");
            require(token2.balanceOf(userB) == sendingAmount, "User didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0, "NttManager has unintended funds"
            );
        }

        // Can't resubmit the same message twice
        vm.expectRevert(abi.encodeWithSelector(Endpoint.DuplicateMessageAttestation.selector));
        transceiverChain2.receiveMessage(rmsgs[0]);

        // Go back the other way from a THIRD user
        vm.prank(userB);
        token2.transfer(userC, sendingAmount);

        vm.startPrank(userC);
        token2.approve(address(nttManagerChain2), sendingAmount);
        vm.recordLogs();

        // Supply checks on the transfer
        {
            uint256 supplyBefore = token2.totalSupply();
            seqNo = nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userD),
                toWormholeFormat(userC),
                false,
                executorChain2.createSignedQuote(executorChain1.chainId()),
                executorChain2.createRelayInstructions(),
                endpointChain2.createAdapterInstructions()
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

        assertEq(0, seqNo);
        rmsgs = transceiverChain2.getMessages();
        assertEq(1, rmsgs.length);

        // Get the execution events from the logs.
        logEvents = vm.getRecordedLogs();
        encoded =
            TransceiverHelpersLib.getExecutionSent(logEvents, address(nttManagerChain2), seqNo);

        // Chain1 verification and checks with the receiving of the message
        vm.chainId(chainId1);

        // Attest the transfer.
        transceiverChain1.receiveMessage(rmsgs[0]);

        {
            uint256 supplyBefore = token1.totalSupply();
            nttManagerChain1.executeMsg(
                rmsgs[0].srcChain, rmsgs[0].srcAddr, rmsgs[0].sequence, encoded
            );

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
        uint64 seqNo;
        {
            uint256 nttManagerBalanceBefore = token1.balanceOf(address(nttManagerChain1));
            uint256 userBalanceBefore = token1.balanceOf(address(userA));
            seqNo = nttManagerChain1.transfer(
                sendingAmount,
                chainId2,
                toWormholeFormat(userB),
                toWormholeFormat(userA),
                true,
                executorChain1.createSignedQuote(executorChain2.chainId()),
                executorChain1.createRelayInstructions(),
                endpointChain1.createAdapterInstructions()
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

        assertEq(0, seqNo);
        DummyTransceiver.Message[] memory rmsgs = transceiverChain1.getMessages();
        assertEq(1, rmsgs.length);

        // Get the execution events from the logs.
        Vm.Log[] memory logEvents = vm.getRecordedLogs();
        bytes memory encoded =
            TransceiverHelpersLib.getExecutionSent(logEvents, address(nttManagerChain1), seqNo);

        vm.stopPrank();

        // Wrong chain receiving the attestation.
        vm.expectRevert(abi.encodeWithSelector(Endpoint.InvalidDestinationChain.selector));
        transceiverChain1.receiveMessage(rmsgs[0]);

        // Right chain receiving the attestation.
        transceiverChain2.receiveMessage(rmsgs[0]);

        vm.chainId(chainId2);
        {
            uint256 supplyBefore = token2.totalSupply();
            nttManagerChain2.executeMsg(
                rmsgs[0].srcChain, rmsgs[0].srcAddr, rmsgs[0].sequence, encoded
            );
            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount + supplyBefore == supplyAfter, "Supplies dont match");
            require(token2.balanceOf(userB) == sendingAmount, "User didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0, "NttManager has unintended funds"
            );
        }

        // Can't resubmit the same message twice
        vm.expectRevert(abi.encodeWithSelector(Endpoint.DuplicateMessageAttestation.selector));
        transceiverChain2.receiveMessage(rmsgs[0]);

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
            seqNo = nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userD),
                toWormholeFormat(userC),
                true,
                executorChain2.createSignedQuote(executorChain1.chainId(), 2 days), // We are going to warp the time below.
                executorChain2.createRelayInstructions(),
                endpointChain2.createAdapterInstructions()
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

        // This should be the first message sent on chain2.
        assertEq(0, seqNo);
        rmsgs = transceiverChain2.getMessages();
        assertEq(1, rmsgs.length);

        // Get the execution events from the logs.
        logEvents = vm.getRecordedLogs();
        encoded =
            TransceiverHelpersLib.getExecutionSent(logEvents, address(nttManagerChain2), seqNo);

        // Chain1 verification and checks with the receiving of the message
        vm.chainId(chainId1);
        vm.stopPrank(); // Back to the owner of everything for this one.
        vm.recordLogs();

        // Attest the transfer on chain1.
        transceiverChain1.receiveMessage(rmsgs[0]);

        {
            uint256 supplyBefore = token1.totalSupply();

            nttManagerChain1.setInboundLimit(0, chainId2);
            nttManagerChain1.executeMsg(
                rmsgs[0].srcChain, rmsgs[0].srcAddr, rmsgs[0].sequence, encoded
            );

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

    function test_multIAdapter() public {
        vm.chainId(chainId1);

        // Create a dual transceiver for each manager.
        DummyTransceiver[] memory transceiversChain1 = new DummyTransceiver[](2);
        (transceiversChain1[0], transceiversChain1[1]) =
            TransceiverHelpersLib.addTransceiver(nttManagerChain1, transceiverChain1, chainId2);

        nttManagerChain2.disableSendTransceiver(chainId1, address(transceiverChain2));
        nttManagerChain2.disableRecvTransceiver(chainId1, address(transceiverChain2));
        DummyTransceiver[] memory transceiversChain2 = new DummyTransceiver[](2);
        (transceiversChain2[0], transceiversChain2[1]) =
            TransceiverHelpersLib.setup_transceivers(nttManagerChain2, chainId1);

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
        uint64 seqNo;
        {
            seqNo = nttManagerChain1.transfer(
                sendingAmount,
                chainId2,
                toWormholeFormat(userB),
                toWormholeFormat(userA),
                false,
                executorChain1.createSignedQuote(executorChain2.chainId()),
                executorChain1.createRelayInstructions(),
                endpointChain1.createAdapterInstructions()
            );
        }

        // This should be the first message sent on chain1 on both transceivers.
        assertEq(0, seqNo);
        DummyTransceiver.Message[] memory rmsgs1 = transceiversChain1[0].getMessages();
        assertEq(1, rmsgs1.length);

        DummyTransceiver.Message[] memory rmsgs2 = transceiversChain1[1].getMessages();
        assertEq(1, rmsgs2.length);

        // Get the execution events from the logs.
        Vm.Log[] memory logEvents = vm.getRecordedLogs();
        bytes memory encoded =
            TransceiverHelpersLib.getExecutionSent(logEvents, address(nttManagerChain1), seqNo);

        vm.chainId(chainId2);

        // Attest the transfer on both transceivers on chain2.
        transceiversChain2[0].receiveMessage(rmsgs1[0]);
        transceiversChain2[1].receiveMessage(rmsgs2[0]);

        // Execute the message to complete the transfer from chain1 to chain2. Only need to execute once.
        {
            // Nothing should update until we call execute.
            uint256 supplyBefore = token2.totalSupply();
            require(supplyBefore == token2.totalSupply(), "Supplies have been updated too early");
            require(token2.balanceOf(userB) == 0, "User received tokens to early");

            nttManagerChain2.executeMsg(
                rmsgs1[0].srcChain, rmsgs1[0].srcAddr, rmsgs1[0].sequence, encoded
            );

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
            seqNo = nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userA),
                toWormholeFormat(userB),
                false,
                executorChain2.createSignedQuote(executorChain1.chainId()),
                executorChain2.createRelayInstructions(),
                endpointChain2.createAdapterInstructions()
            );
            uint256 nttManagerBalanceAfter = token1.balanceOf(address(nttManagerChain2));
            uint256 userBalanceAfter = token1.balanceOf(address(userB));

            require(userBalanceBefore - userBalanceAfter == 0, "No funds left for user");
            require(nttManagerBalanceAfter == 0, "NttManager should burn all tranferred tokens");
        }

        // This should be the first message sent on chain2 on both transceivers.
        assertEq(0, seqNo);
        rmsgs1 = transceiversChain2[0].getMessages();
        assertEq(1, rmsgs1.length);

        rmsgs2 = transceiversChain2[1].getMessages();
        assertEq(1, rmsgs2.length);

        // Get the execution events from the logs.
        logEvents = vm.getRecordedLogs();
        encoded =
            TransceiverHelpersLib.getExecutionSent(logEvents, address(nttManagerChain2), seqNo);

        vm.chainId(chainId1);

        // Attest the transfer on both transceivers on chain2.
        transceiversChain1[0].receiveMessage(rmsgs1[0]);
        transceiversChain1[1].receiveMessage(rmsgs2[0]);

        {
            uint256 supplyBefore = token1.totalSupply();
            require(supplyBefore == token1.totalSupply(), "Supplies have been updated too early");
            require(token2.balanceOf(userA) == 0, "User received tokens to early");

            nttManagerChain1.executeMsg(
                rmsgs1[0].srcChain, rmsgs1[0].srcAddr, rmsgs1[0].sequence, encoded
            );

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
}
