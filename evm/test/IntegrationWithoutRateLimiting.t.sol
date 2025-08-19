// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManagerNoRateLimiting.sol";
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

contract TestEndToEndNoRateLimiting is Test {
    NttManagerNoRateLimiting nttManagerChain1;
    NttManagerNoRateLimiting nttManagerChain2;

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

    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);

    function setUp() public {
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        vm.createSelectFork(url);
        initialBlockTimestamp = vm.getBlockTimestamp();

        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        vm.chainId(chainId1);
        DummyToken t1 = new DummyToken();
        NttManagerNoRateLimiting implementation = new MockNttManagerNoRateLimitingContract(
            address(t1), INttManager.Mode.LOCKING, chainId1
        );

        nttManagerChain1 = MockNttManagerNoRateLimitingContract(
            address(new ERC1967Proxy(address(implementation), ""))
        );
        nttManagerChain1.initialize();

        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain1), address(wormhole), FAST_CONSISTENCY_LEVEL, GAS_LIMIT
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
        nttManagerChain1.setSendTransceiverForChain(chainId2, address(wormholeTransceiverChain1));
        nttManagerChain1.setReceiveTransceiverForChain(chainId1, address(wormholeTransceiverChain1));
        nttManagerChain1.setReceiveTransceiverForChain(chainId2, address(wormholeTransceiverChain1));
        nttManagerChain1.setThreshold(chainId1, 1);
        nttManagerChain1.setThreshold(chainId2, 1);
        // nttManagerChain1.setOutboundLimit(type(uint64).max);
        // nttManagerChain1.setInboundLimit(type(uint64).max, chainId2);

        // Chain 2 setup
        vm.chainId(chainId2);
        DummyToken t2 = new DummyTokenMintAndBurn();
        NttManagerNoRateLimiting implementationChain2 = new MockNttManagerNoRateLimitingContract(
            address(t2), INttManager.Mode.BURNING, chainId2
        );

        nttManagerChain2 = MockNttManagerNoRateLimitingContract(
            address(new ERC1967Proxy(address(implementationChain2), ""))
        );
        nttManagerChain2.initialize();

        WormholeTransceiver wormholeTransceiverChain2Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain2), address(wormhole), FAST_CONSISTENCY_LEVEL, GAS_LIMIT
        );
        wormholeTransceiverChain2 = MockWormholeTransceiverContract(
            address(new ERC1967Proxy(address(wormholeTransceiverChain2Implementation), ""))
        );
        wormholeTransceiverChain2.initialize();

        nttManagerChain2.setTransceiver(address(wormholeTransceiverChain2));
        nttManagerChain2.setSendTransceiverForChain(chainId1, address(wormholeTransceiverChain2));
        nttManagerChain2.setReceiveTransceiverForChain(chainId1, address(wormholeTransceiverChain2));
        nttManagerChain2.setReceiveTransceiverForChain(chainId2, address(wormholeTransceiverChain2));
        nttManagerChain2.setThreshold(chainId1, 1);
        nttManagerChain2.setThreshold(chainId2, 1);
        // nttManagerChain2.setOutboundLimit(type(uint64).max);
        // nttManagerChain2.setInboundLimit(type(uint64).max, chainId1);

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

        require(
            nttManagerChain1.getThreshold(chainId2) != 0,
            "Threshold is zero with active transceivers"
        );

        // Actually set it
        nttManagerChain1.setThreshold(chainId2, 1);
        nttManagerChain2.setThreshold(chainId1, 1);

        INttManager.NttManagerPeer memory peer = nttManagerChain1.getPeer(chainId2);
        require(9 == peer.tokenDecimals, "Peer has the wrong number of token decimals");
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

        // Get and sign the log to go down the other pipe. Thank you to whoever wrote this code in the past!
        Vm.Log[] memory entries = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
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
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManagerNoRateLimiting has unintended funds"
            );
        }

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
                "NttManagerNoRateLimiting didn't receive unintended funds"
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

    // This test triggers some basic reverts to increase our code coverage.
    function test_someReverts() public {
        // These shouldn't revert.
        nttManagerChain1.setOutboundLimit(0);
        nttManagerChain1.setInboundLimit(0, chainId2);

        require(
            nttManagerChain1.getCurrentOutboundCapacity() == 0,
            "getCurrentOutboundCapacity returned unexpected value"
        );

        require(
            nttManagerChain1.getCurrentInboundCapacity(chainId2) == 0,
            "getCurrentInboundCapacity returned unexpected value"
        );

        // Everything else should.
        vm.expectRevert(abi.encodeWithSelector(IManagerBase.InvalidPeerChainIdZero.selector));
        nttManagerChain1.setPeer(
            0, bytes32(uint256(uint160(address(nttManagerChain2)))), 9, type(uint64).max
        );

        vm.expectRevert(abi.encodeWithSelector(IManagerBase.InvalidPeerZeroAddress.selector));
        nttManagerChain1.setPeer(chainId2, bytes32(0), 9, type(uint64).max);

        vm.expectRevert(abi.encodeWithSelector(INttManager.InvalidPeerDecimals.selector));
        nttManagerChain1.setPeer(
            chainId2, bytes32(uint256(uint160(address(nttManagerChain2)))), 0, type(uint64).max
        );

        vm.expectRevert(abi.encodeWithSelector(IManagerBase.InvalidPeerSameChainId.selector));
        nttManagerChain1.setPeer(
            chainId1, bytes32(uint256(uint160(address(nttManagerChain2)))), 9, type(uint64).max
        );

        vm.expectRevert(abi.encodeWithSelector(INttManager.NotImplemented.selector));
        nttManagerChain1.getOutboundQueuedTransfer(0);

        vm.expectRevert(abi.encodeWithSelector(INttManager.NotImplemented.selector));
        nttManagerChain1.getInboundQueuedTransfer(bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(INttManager.NotImplemented.selector));
        nttManagerChain1.completeInboundQueuedTransfer(bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(INttManager.NotImplemented.selector));
        nttManagerChain1.completeOutboundQueuedTransfer(0);

        vm.expectRevert(abi.encodeWithSelector(INttManager.NotImplemented.selector));
        nttManagerChain1.cancelOutboundQueuedTransfer(0);
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
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManagerNoRateLimiting has unintended funds"
            );
        }

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
            // nttManagerChain2.setOutboundLimit(0);

            vm.startPrank(userC);
            nttManagerChain2.transfer(
                sendingAmount,
                chainId1,
                toWormholeFormat(userD),
                toWormholeFormat(userC),
                true,
                encodeTransceiverInstruction(true)
            );

            uint256 supplyAfter = token2.totalSupply();

            require(sendingAmount - supplyBefore == supplyAfter, "Supplies don't match");
            require(token2.balanceOf(userB) == 0, "OG user receive tokens");
            require(token2.balanceOf(userC) == 0, "Sending user didn't receive tokens");
            require(
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManagerNoRateLimiting didn't receive unintended funds"
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

            // nttManagerChain1.setInboundLimit(0, chainId2);
            wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);

            bytes32[] memory queuedDigests =
                Utils.fetchQueuedTransferDigestsFromLogs(vm.getRecordedLogs());

            require(0 == queuedDigests.length, "Should not queue inbound messages");

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
            address(nttManagerChain1), address(wormhole), FAST_CONSISTENCY_LEVEL, GAS_LIMIT
        );

        wormholeTransceiverChain1_2 = MockWormholeTransceiverContract(
            address(new ERC1967Proxy(address(wormholeTransceiverChain1_2), ""))
        );
        wormholeTransceiverChain1_2.initialize();

        vm.chainId(chainId2);
        WormholeTransceiver wormholeTransceiverChain2_1 = wormholeTransceiverChain2;

        // Dual transceiver setup
        WormholeTransceiver wormholeTransceiverChain2_2 = new MockWormholeTransceiverContract(
            address(nttManagerChain2), address(wormhole), FAST_CONSISTENCY_LEVEL, GAS_LIMIT
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
        // Configure second transceiver for chain2
        nttManagerChain2.setSendTransceiverForChain(chainId1, address(wormholeTransceiverChain2_2));
        nttManagerChain2.setSendTransceiverForChain(chainId2, address(wormholeTransceiverChain2_2));
        nttManagerChain2.setReceiveTransceiverForChain(
            chainId1, address(wormholeTransceiverChain2_2)
        );
        nttManagerChain2.setReceiveTransceiverForChain(
            chainId2, address(wormholeTransceiverChain2_2)
        );

        nttManagerChain1.setTransceiver(address(wormholeTransceiverChain1_2));
        // Configure second transceiver for both chains
        nttManagerChain1.setSendTransceiverForChain(chainId1, address(wormholeTransceiverChain1_2));
        nttManagerChain1.setSendTransceiverForChain(chainId2, address(wormholeTransceiverChain1_2));
        nttManagerChain1.setReceiveTransceiverForChain(
            chainId1, address(wormholeTransceiverChain1_2)
        );
        nttManagerChain1.setReceiveTransceiverForChain(
            chainId2, address(wormholeTransceiverChain1_2)
        );

        // Change the threshold from the setUp functions 1 to 2.
        nttManagerChain1.setThreshold(chainId2, 2);
        nttManagerChain2.setThreshold(chainId1, 2);

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
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManagerNoRateLimiting has unintended funds"
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
            require(
                nttManagerBalanceAfter == 0,
                "NttManagerNoRateLimiting should burn all tranferred tokens"
            );
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
