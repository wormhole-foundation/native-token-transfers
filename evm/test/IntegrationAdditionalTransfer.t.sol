// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManagerNoRateLimiting.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IRateLimiter.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/IRateLimiterEvents.sol";
import {Utils} from "./libraries/Utils.sol";
import {DummyToken, DummyTokenMintAndBurn} from "./NttManager.t.sol";
import "../src/libraries/TransceiverStructs.sol";
import "./libraries/TransceiverHelpers.sol";
import "./mocks/MockNttManagerAdditionalPayload.sol";
import "./mocks/MockEndpoint.sol";
import "./mocks/MockExecutor.sol";
import "./mocks/DummyTransceiver.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";
import "example-messaging-endpoint/evm/src/Endpoint.sol";
//import "wormhole-solidity-sdk/testing/WormholeRelayerTest.sol";

contract TestAdditionalPayload is Test {
    MockEndpoint endpointChain1;
    MockEndpoint endpointChain2;

    MockExecutor executorChain1;
    MockExecutor executorChain2;

    NttManagerNoRateLimiting nttManagerChain1;
    NttManagerNoRateLimiting nttManagerChain2;

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
        NttManagerNoRateLimiting implementation = new MockNttManagerAdditionalPayloadContract(
            address(endpointChain1),
            address(executorChain1),
            address(t1),
            IManagerBase.Mode.LOCKING,
            chainId1
        );

        nttManagerChain1 = MockNttManagerAdditionalPayloadContract(
            address(new ERC1967Proxy(address(implementation), ""))
        );
        nttManagerChain1.initialize();

        transceiverChain1 = new DummyTransceiver(chainId1, address(endpointChain1));
        nttManagerChain1.setTransceiver(address(transceiverChain1));
        nttManagerChain1.enableSendTransceiver(chainId2, address(transceiverChain1));
        nttManagerChain1.enableRecvTransceiver(chainId2, address(transceiverChain1));

        // Chain 2 setup
        vm.chainId(chainId2);
        DummyToken t2 = new DummyTokenMintAndBurn();
        NttManagerNoRateLimiting implementationChain2 = new MockNttManagerAdditionalPayloadContract(
            address(endpointChain2),
            address(executorChain2),
            address(t2),
            IManagerBase.Mode.BURNING,
            chainId2
        );

        nttManagerChain2 = MockNttManagerAdditionalPayloadContract(
            address(new ERC1967Proxy(address(implementationChain2), ""))
        );
        nttManagerChain2.initialize();

        transceiverChain2 = new DummyTransceiver(chainId2, address(endpointChain2));
        nttManagerChain2.setTransceiver(address(transceiverChain2));
        nttManagerChain2.enableSendTransceiver(chainId1, address(transceiverChain2));
        nttManagerChain2.enableRecvTransceiver(chainId1, address(transceiverChain2));

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

        // Actually set it
        nttManagerChain1.setThreshold(chainId2, 1);
        nttManagerChain2.setThreshold(chainId1, 1);

        INttManager.NttManagerPeer memory peer = nttManagerChain1.getPeer(chainId2);
        require(9 == peer.tokenDecimals, "Peer has the wrong number of token decimals");
    }

    function test_setUp() public {}

    function test_transferWithAdditionalPayload() public {
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

        assertEq(seqNo, 0);
        DummyTransceiver.Message[] memory rmsgs = transceiverChain1.getMessages();
        assertEq(1, rmsgs.length);

        // Get the execution events from the logs.
        Vm.Log[] memory recordedLogs = vm.getRecordedLogs();
        bytes memory encoded =
            TransceiverHelpersLib.getExecutionSent(recordedLogs, address(nttManagerChain1), seqNo);

        vm.stopPrank();

        // Get the AdditionalPayloadSent(bytes) event to ensure it matches up with the AdditionalPayloadReceived(bytes) event later
        string memory expectedAP = "banana";
        string memory sentAP;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (recordedLogs[i].topics[0] == keccak256("AdditionalPayloadSent(bytes)")) {
                sentAP = abi.decode(recordedLogs[i].data, (string));
                break;
            }
        }
        assertEq(sentAP, expectedAP);

        // Chain2 verification and checks
        vm.chainId(chainId2);

        // Wrong chain receiving the signed VAA
        vm.expectRevert(Endpoint.InvalidDestinationChain.selector);
        transceiverChain1.receiveMessage(rmsgs[0]);

        // Attest on the correct chain.
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
                token2.balanceOf(address(nttManagerChain2)) == 0,
                "NttManagerNoRateLimiting has unintended funds"
            );
        }

        // Get the AdditionalPayloadReceived(bytes) event to ensure it matches up with the AdditionalPayloadSent(bytes) event earlier
        recordedLogs = vm.getRecordedLogs();
        string memory receivedAP;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (recordedLogs[i].topics[0] == keccak256("AdditionalPayloadReceived(bytes)")) {
                receivedAP = abi.decode(recordedLogs[i].data, (string));
                break;
            }
        }
        assertEq(receivedAP, expectedAP);

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
                "NttManagerNoRateLimiting didn't receive unintended funds"
            );
        }

        recordedLogs = vm.getRecordedLogs();
        encoded =
            TransceiverHelpersLib.getExecutionSent(recordedLogs, address(nttManagerChain2), seqNo);

        // Chain1 verification and checks with the receiving of the message
        vm.chainId(chainId1);

        // Attest the message.
        rmsgs = transceiverChain2.getMessages();
        assertEq(1, rmsgs.length);
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
}
