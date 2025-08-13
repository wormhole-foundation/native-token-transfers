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
import "./mocks/MockNttManagerAdditionalPayload.sol";
import "./mocks/MockTransceivers.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";
//import "wormhole-solidity-sdk/testing/WormholeRelayerTest.sol";

contract TestAdditionalPayload is Test {
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

    address relayer = address(0x28D8F1Be96f97C1387e94A53e00eCcFb4E75175a);
    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);

    function setUp() public {
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        vm.createSelectFork(url);
        initialBlockTimestamp = vm.getBlockTimestamp();

        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        vm.chainId(chainId1);
        DummyToken t1 = new DummyToken();
        NttManagerNoRateLimiting implementation = new MockNttManagerAdditionalPayloadContract(
            address(t1), INttManager.Mode.LOCKING, chainId1
        );

        nttManagerChain1 = MockNttManagerAdditionalPayloadContract(
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
        NttManagerNoRateLimiting implementationChain2 = new MockNttManagerAdditionalPayloadContract(
            address(t2), INttManager.Mode.BURNING, chainId2
        );

        nttManagerChain2 = MockNttManagerAdditionalPayloadContract(
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

        // Get the AdditionalPayloadSent(bytes) event to ensure it matches up with the AdditionalPayloadReceived(bytes) event later
        Vm.Log[] memory recordedLogs = vm.getRecordedLogs();
        string memory expectedAP = "banana";
        string memory sentAP;
        for (uint256 i = 0; i < recordedLogs.length; i++) {
            if (recordedLogs[i].topics[0] == keccak256("AdditionalPayloadSent(bytes)")) {
                sentAP = abi.decode(recordedLogs[i].data, (string));
                break;
            }
        }
        assertEq(sentAP, expectedAP);

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
}
