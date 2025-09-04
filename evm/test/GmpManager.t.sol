// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/GmpManager/GmpManager.sol";
import "./mocks/DummyReceiver.sol";
import "../src/interfaces/IGmpManager.sol";
import "../src/MultiTokenNtt/Peers.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/NttManager/TransceiverRegistry.sol";
import "../src/libraries/PausableUpgradeable.sol";
import "../src/libraries/TransceiverHelpers.sol";
import {Utils} from "./libraries/Utils.sol";

import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/Utils.sol";
import "./libraries/TransceiverHelpers.sol";
import "./interfaces/ITransceiverReceiver.sol";
import "./mocks/DummyTransceiver.sol";

contract TestGmpManager is Test {
    GmpManager gmpManager;
    GmpManager gmpManagerOther;

    uint16 constant chainId = 7;
    uint16 constant chainId2 = 8;
    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;
    uint256 initialBlockTimestamp;
    GenericDummyTransceiver dummyTransceiver;

    function setUp() public {
        initialBlockTimestamp = vm.getBlockTimestamp();

        GmpManager implementation = new GmpManager(chainId);

        gmpManager = GmpManager(address(new ERC1967Proxy(address(implementation), "")));
        gmpManager.initialize();

        GmpManager otherImplementation = new GmpManager(chainId2);

        gmpManagerOther = GmpManager(address(new ERC1967Proxy(address(otherImplementation), "")));
        gmpManagerOther.initialize();

        dummyTransceiver = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(dummyTransceiver));
    }

    function test_owner() public {
        assertEq(gmpManager.owner(), address(this));
    }

    function test_transferOwnership() public {
        address newOwner = address(0x123);
        gmpManager.transferOwnership(newOwner);
        assertEq(gmpManager.owner(), newOwner);
    }

    function test_onlyOwnerCanTransferOwnership() public {
        address notOwner = address(0x123);
        vm.startPrank(notOwner);

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, notOwner)
        );
        gmpManager.transferOwnership(address(0x456));
    }

    function test_pauseUnpause() public {
        assertEq(gmpManager.isPaused(), false);
        gmpManager.pause();
        assertEq(gmpManager.isPaused(), true);

        // When the GmpManager is paused, sending messages and executing messages should revert
        vm.expectRevert(
            abi.encodeWithSelector(PausableUpgradeable.RequireContractIsNotPaused.selector)
        );
        gmpManager.sendMessage(0, bytes32(0), bytes32(0), 0, "", new bytes(1));

        vm.expectRevert(
            abi.encodeWithSelector(PausableUpgradeable.RequireContractIsNotPaused.selector)
        );
        TransceiverStructs.NttManagerMessage memory message;
        gmpManager.executeMsg(0, bytes32(0), message);

        gmpManager.unpause();
        assertEq(gmpManager.isPaused(), false);
    }

    function test_registerTransceiver() public {
        GenericDummyTransceiver e = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e));
    }

    function test_onlyOwnerCanModifyTransceivers() public {
        GenericDummyTransceiver e = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e));

        address notOwner = address(0x123);
        vm.startPrank(notOwner);

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, notOwner)
        );
        gmpManager.setTransceiver(address(e));

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, notOwner)
        );
        gmpManager.removeTransceiver(address(e));
    }

    function test_cantEnableTransceiverTwice() public {
        GenericDummyTransceiver e = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e));

        vm.expectRevert(
            abi.encodeWithSelector(
                TransceiverRegistry.TransceiverAlreadyEnabled.selector, address(e)
            )
        );
        gmpManager.setTransceiver(address(e));
    }

    function test_disableReenableTransceiver() public {
        GenericDummyTransceiver e = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e));
        gmpManager.removeTransceiver(address(e));
        gmpManager.setTransceiver(address(e));
    }

    function test_disableAllTransceiversFails() public {
        vm.expectRevert(abi.encodeWithSelector(IManagerBase.ZeroThreshold.selector));
        gmpManager.removeTransceiver(address(dummyTransceiver));
    }

    function test_multipleTransceivers() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        GenericDummyTransceiver e2 = new GenericDummyTransceiver(address(gmpManager));

        gmpManager.setTransceiver(address(e1));
        gmpManager.setTransceiver(address(e2));
    }

    function test_sendMessage() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));

        // Configure per-chain send transceivers for chainId2
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));

        address user = address(0x123);
        bytes32 callee = bytes32(uint256(uint160(address(0x456))));
        bytes32 refundAddress = bytes32(uint256(uint160(user)));
        bytes memory data = abi.encodeWithSignature("someFunction(uint256)", 123);

        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        vm.prank(user);
        uint64 sequence =
            gmpManager.sendMessage(chainId2, callee, refundAddress, 0, data, new bytes(1));

        assertEq(sequence, 1);
    }

    function test_executeMsg() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));

        // Configure per-chain receive transceivers for chainId2
        gmpManager.setReceiveTransceiverForChain(chainId2, address(e1));
        gmpManager.setThreshold(chainId2, 1);

        DummyReceiver receiver = new DummyReceiver(gmpManager);

        address sender = address(0x123);
        address callee = address(receiver);
        bytes memory data = abi.encode(123);

        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        GmpStructs.GenericMessage memory genericMessage = GmpStructs.GenericMessage({
            toChain: chainId,
            callee: bytes32(uint256(uint160(callee))),
            sender: bytes32(uint256(uint160(sender))),
            data: data
        });

        bytes memory payload = GmpStructs.encodeGenericMessage(genericMessage);

        bytes memory transceiverMessage;
        (, transceiverMessage) = TransceiverHelpersLib.buildTransceiverMessageWithNttManagerPayload(
            0,
            toWormholeFormat(sender),
            toWormholeFormat(address(gmpManagerOther)),
            toWormholeFormat(address(gmpManager)),
            payload,
            chainId2 // Use chainId2 (8) instead of default SENDING_CHAIN_ID (1)
        );
        e1.receiveMessage(transceiverMessage);

        assertEq(receiver.received(), 123);
    }

    function test_setPeer() public {
        bytes32 peerAddress = toWormholeFormat(address(gmpManagerOther));
        gmpManager.setPeer(chainId2, peerAddress);

        GmpManager.GmpPeer memory peer = gmpManager.getPeer(chainId2);
        assertEq(peer.peerAddress, peerAddress);
    }

    function test_onlyOwnerCanSetPeer() public {
        address notOwner = address(0x123);
        vm.startPrank(notOwner);

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, notOwner)
        );
        gmpManager.setPeer(chainId2, bytes32(0));
    }

    function test_cantSetInvalidPeer() public {
        vm.expectRevert(abi.encodeWithSelector(IManagerBase.InvalidPeerChainIdZero.selector));
        gmpManager.setPeer(0, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(IManagerBase.InvalidPeerZeroAddress.selector));
        gmpManager.setPeer(chainId2, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(IManagerBase.InvalidPeerSameChainId.selector));
        gmpManager.setPeer(chainId, bytes32(uint256(uint160(address(0x123)))));
    }

    function test_upgradeGmpManager() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));

        // Configure per-chain send transceivers for chainId2
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));

        address user = address(0x123);
        bytes32 callee = bytes32(uint256(uint160(address(0x456))));
        bytes32 refundAddress = bytes32(uint256(uint160(user)));
        bytes memory data = abi.encodeWithSignature("someFunction(uint256)", 123);

        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        vm.prank(user);
        uint64 sequence =
            gmpManager.sendMessage(chainId2, callee, refundAddress, 0, data, new bytes(1));

        assertEq(sequence, 1);

        // Upgrade to a new implementation
        GmpManager newImplementation = new GmpManager(chainId);
        gmpManager.upgrade(address(newImplementation));

        vm.prank(user);
        sequence = gmpManager.sendMessage(chainId2, callee, refundAddress, 0, data, new bytes(1));

        assertEq(sequence, 2);
    }

    function test_cannotReceiveWithZeroThreshold() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));

        // Configure per-chain receive transceivers for chainId2 but don't set threshold
        gmpManager.setReceiveTransceiverForChain(chainId2, address(e1));

        // The threshold should automatically be set to 1 when we add the first transceiver
        // But let's manually set it to 0 to test the validation
        // We can't directly set threshold to 0 via setThreshold() since it validates,
        // so we need to simulate the case where threshold becomes 0

        // Remove the transceiver which should adjust threshold to 0
        gmpManager.removeReceiveTransceiverForChain(chainId2, address(e1));

        // Now try to process a message from chainId2 - it should fail
        DummyReceiver receiver = new DummyReceiver(gmpManager);
        address sender = address(0x123);
        address callee = address(receiver);
        bytes memory data = abi.encode(123);

        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        GmpStructs.GenericMessage memory genericMessage = GmpStructs.GenericMessage({
            toChain: chainId,
            callee: bytes32(uint256(uint160(callee))),
            sender: bytes32(uint256(uint160(sender))),
            data: data
        });

        bytes memory payload = GmpStructs.encodeGenericMessage(genericMessage);

        bytes memory transceiverMessage;
        (, transceiverMessage) = TransceiverHelpersLib.buildTransceiverMessageWithNttManagerPayload(
            0,
            toWormholeFormat(sender),
            toWormholeFormat(address(gmpManagerOther)),
            toWormholeFormat(address(gmpManager)),
            payload,
            chainId2 // Use chainId2 (8) instead of default SENDING_CHAIN_ID (1)
        );

        // This should revert because threshold is 0 for chainId2 after removing all transceivers
        // The specific error should be NoThresholdConfiguredForChain
        vm.expectRevert(
            abi.encodeWithSelector(
                TransceiverRegistry.NoThresholdConfiguredForChain.selector, chainId2
            )
        );
        e1.receiveMessage(transceiverMessage);
    }

    function test_cannotReceiveFromUnconfiguredChain() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));

        // Don't configure any per-chain settings for chainId2
        // This means threshold = 0 for this chain

        // Try to process a message from chainId2 - it should fail immediately
        uint16 unconfiguredChain = 999;
        DummyReceiver receiver = new DummyReceiver(gmpManager);
        address sender = address(0x123);
        address callee = address(receiver);
        bytes memory data = abi.encode(456);

        gmpManager.setPeer(unconfiguredChain, toWormholeFormat(address(gmpManagerOther)));

        GmpStructs.GenericMessage memory genericMessage = GmpStructs.GenericMessage({
            toChain: chainId,
            callee: bytes32(uint256(uint160(callee))),
            sender: bytes32(uint256(uint160(sender))),
            data: data
        });

        bytes memory payload = GmpStructs.encodeGenericMessage(genericMessage);

        bytes memory transceiverMessage;
        (, transceiverMessage) = TransceiverHelpersLib.buildTransceiverMessageWithNttManagerPayload(
            0,
            toWormholeFormat(sender),
            toWormholeFormat(address(gmpManagerOther)),
            toWormholeFormat(address(gmpManager)),
            payload,
            unconfiguredChain // Use unconfiguredChain (999) instead of default SENDING_CHAIN_ID (1)
        );

        // This should revert because no threshold was ever configured for unconfiguredChain
        vm.expectRevert(
            abi.encodeWithSelector(
                TransceiverRegistry.NoThresholdConfiguredForChain.selector, unconfiguredChain
            )
        );
        e1.receiveMessage(transceiverMessage);
    }

    function test_cannotReceiveAfterTransceiverDisabled() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        GenericDummyTransceiver e2 = new GenericDummyTransceiver(address(gmpManager));

        // Add both transceivers
        gmpManager.setTransceiver(address(e1));
        gmpManager.setTransceiver(address(e2));

        // Configure both transceivers for receiving from chainId2
        gmpManager.setReceiveTransceiverForChain(chainId2, address(e1));
        gmpManager.setReceiveTransceiverForChain(chainId2, address(e2));
        gmpManager.setThreshold(chainId2, 1); // Only need 1 transceiver

        // Set up peer and receiver
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));
        DummyReceiver receiver = new DummyReceiver(gmpManager);

        // Create initial message for testing
        _testMessageExecution(e1, receiver, 789);

        // Now disable e1 globally using removeTransceiver
        gmpManager.removeTransceiver(address(e1));

        // Try to call attestationReceived from the disabled transceiver e1
        // This should revert because e1 is no longer enabled globally
        vm.expectRevert(
            abi.encodeWithSelector(TransceiverRegistry.CallerNotTransceiver.selector, address(e1))
        );

        vm.prank(address(e1));
        TransceiverStructs.NttManagerMessage memory dummyMessage;
        gmpManager.attestationReceived(chainId2, bytes32(0), dummyMessage);
    }

    function test_removeTransceiverDisablesGlobally() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));

        // Add transceiver
        gmpManager.setTransceiver(address(e1));

        // Verify it's enabled
        address[] memory transceivers = gmpManager.getTransceivers();
        assertEq(transceivers.length, 2); // Should have dummyTransceiver and e1

        // Now disable e1 globally using removeTransceiver
        gmpManager.removeTransceiver(address(e1));

        // Verify it's no longer in the list
        transceivers = gmpManager.getTransceivers();
        assertEq(transceivers.length, 1); // Should only have dummyTransceiver

        // Check the onlyTransceiver modifier by trying to call attestationReceived directly
        // This should revert because e1 is no longer enabled globally
        vm.expectRevert(
            abi.encodeWithSelector(TransceiverRegistry.CallerNotTransceiver.selector, address(e1))
        );

        // Try to call attestationReceived as the disabled transceiver
        vm.prank(address(e1));
        TransceiverStructs.NttManagerMessage memory dummyMessage;
        gmpManager.attestationReceived(chainId2, bytes32(0), dummyMessage);
    }

    function _testMessageExecution(
        GenericDummyTransceiver transceiver,
        DummyReceiver receiver,
        uint256 value
    ) internal {
        bytes memory data = abi.encode(value);
        bytes32 sender = bytes32(uint256(uint160(address(0x123))));
        bytes32 callee = bytes32(uint256(uint160(address(receiver))));

        GmpStructs.GenericMessage memory genericMessage = GmpStructs.GenericMessage({
            toChain: chainId,
            callee: callee,
            sender: sender,
            data: data
        });

        bytes memory payload = GmpStructs.encodeGenericMessage(genericMessage);

        bytes memory transceiverMessage;
        (, transceiverMessage) = TransceiverHelpersLib.buildTransceiverMessageWithNttManagerPayload(
            0,
            sender,
            toWormholeFormat(address(gmpManagerOther)),
            toWormholeFormat(address(gmpManager)),
            payload,
            chainId2 // Use chainId2 (8) instead of default SENDING_CHAIN_ID (1)
        );

        transceiver.receiveMessage(transceiverMessage);
        assertEq(receiver.received(), value);
    }

    // ============ Sequence Reservation Tests ============

    function test_reserveMessageSequence() public {
        address user = address(0x123);

        vm.prank(user);
        uint64 reservedSequence = gmpManager.reserveMessageSequence();

        // First reserved sequence should be 1 (since we start at 1)
        assertEq(reservedSequence, 1);

        // Reserve another sequence
        vm.prank(user);
        uint64 secondReserved = gmpManager.reserveMessageSequence();
        assertEq(secondReserved, 2);
    }

    function test_useReservedSequence() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        address user = address(0x123);
        bytes32 callee = bytes32(uint256(uint160(address(0x456))));
        bytes32 refundAddress = bytes32(uint256(uint160(user)));
        bytes memory data = abi.encodeWithSignature("someFunction(uint256)", 123);

        // Reserve a sequence
        vm.prank(user);
        uint64 reservedSequence = gmpManager.reserveMessageSequence();
        assertEq(reservedSequence, 1);

        // Use the reserved sequence in sendMessage
        vm.prank(user);
        uint64 actualSequence = gmpManager.sendMessage(
            chainId2, callee, refundAddress, reservedSequence, data, new bytes(1)
        );

        assertEq(actualSequence, reservedSequence);
    }

    function test_cannotUseUnreservedSequence() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        address user = address(0x123);
        bytes32 callee = bytes32(uint256(uint160(address(0x456))));
        bytes32 refundAddress = bytes32(uint256(uint160(user)));
        bytes memory data = abi.encodeWithSignature("someFunction(uint256)", 123);

        // Try to use sequence 5 without reserving it
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IGmpManager.SequenceNotReservedBySender.selector, 5, user)
        );
        gmpManager.sendMessage(chainId2, callee, refundAddress, 5, data, new bytes(1));
    }

    function test_cannotUseOtherUsersReservedSequence() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        address user1 = address(0x123);
        address user2 = address(0x456);
        bytes32 callee = bytes32(uint256(uint160(address(0x789))));
        bytes32 refundAddress = bytes32(uint256(uint160(user2)));
        bytes memory data = abi.encodeWithSignature("someFunction(uint256)", 123);

        // User1 reserves a sequence
        vm.prank(user1);
        uint64 reservedSequence = gmpManager.reserveMessageSequence();

        // User2 tries to use user1's reserved sequence
        vm.prank(user2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGmpManager.SequenceNotReservedBySender.selector, reservedSequence, user2
            )
        );
        gmpManager.sendMessage(
            chainId2, callee, refundAddress, reservedSequence, data, new bytes(1)
        );
    }

    function test_sequenceConsumedAfterUse() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        gmpManager.setTransceiver(address(e1));
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        address user = address(0x123);
        bytes32 callee = bytes32(uint256(uint160(address(0x456))));
        bytes32 refundAddress = bytes32(uint256(uint160(user)));
        bytes memory data = abi.encodeWithSignature("someFunction(uint256)", 123);

        // Reserve and use a sequence
        vm.prank(user);
        uint64 reservedSequence = gmpManager.reserveMessageSequence();

        vm.prank(user);
        gmpManager.sendMessage(
            chainId2, callee, refundAddress, reservedSequence, data, new bytes(1)
        );

        // Try to use the same sequence again - should fail
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGmpManager.SequenceNotReservedBySender.selector, reservedSequence, user
            )
        );
        gmpManager.sendMessage(
            chainId2, callee, refundAddress, reservedSequence, data, new bytes(1)
        );
    }

    // =============== Chain Registry Tests ===============================================

    function test_chainRegistryTracksKnownChains() public {
        uint16 chainId3 = 9;
        uint16 chainId4 = 10;

        // Initially no known chains
        uint16[] memory knownChains = gmpManager.getKnownChains();
        assertEq(knownChains.length, 0);

        // Set multiple peers
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));
        gmpManager.setPeer(chainId3, toWormholeFormat(address(0x123)));
        gmpManager.setPeer(chainId4, toWormholeFormat(address(0x456)));

        // Check all chains are tracked
        knownChains = gmpManager.getKnownChains();
        assertEq(knownChains.length, 3);

        // Verify the chains are present (order doesn't matter)
        bool foundChain2 = false;
        bool foundChain3 = false;
        bool foundChain4 = false;

        for (uint256 i = 0; i < knownChains.length; i++) {
            if (knownChains[i] == chainId2) foundChain2 = true;
            if (knownChains[i] == chainId3) foundChain3 = true;
            if (knownChains[i] == chainId4) foundChain4 = true;
        }

        assertTrue(foundChain2);
        assertTrue(foundChain3);
        assertTrue(foundChain4);

        // Setting the same peer again should not duplicate
        gmpManager.setPeer(chainId2, toWormholeFormat(address(0x789)));
        knownChains = gmpManager.getKnownChains();
        assertEq(knownChains.length, 3);
    }

    function test_registerKnownChain() public {
        // Set up a peer first
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        // Clear known chains by creating a new manager
        GmpManager implementation = new GmpManager(chainId);
        GmpManager newGmpManager =
            GmpManager(address(new ERC1967Proxy(address(implementation), "")));
        newGmpManager.initialize();

        // Set the same peer on the new manager (this will track it)
        newGmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));

        // Now test registerKnownChain with a different chain
        uint16 chainId3 = 9;
        newGmpManager.setPeer(chainId3, toWormholeFormat(address(0x123)));

        // Anyone should be able to call registerKnownChain
        address randomUser = address(0x999);
        vm.prank(randomUser);
        newGmpManager.registerKnownChain(chainId3, toWormholeFormat(address(0x123)));

        // Should not duplicate
        uint16[] memory knownChains = newGmpManager.getKnownChains();
        uint256 chain3Count = 0;
        for (uint256 i = 0; i < knownChains.length; i++) {
            if (knownChains[i] == chainId3) chain3Count++;
        }
        assertEq(chain3Count, 1);
    }

    function test_registerKnownChainRevertsForInvalidPeer() public {
        uint16 chainId3 = 9;
        bytes32 invalidPeerAddress = toWormholeFormat(address(0x123));

        // Should revert because no peer is set for chainId3
        vm.expectRevert(
            abi.encodeWithSelector(Peers.InvalidPeer.selector, chainId3, invalidPeerAddress)
        );
        gmpManager.registerKnownChain(chainId3, invalidPeerAddress);
    }

    function test_removeTransceiverRemovesFromAllChains() public {
        GenericDummyTransceiver e1 = new GenericDummyTransceiver(address(gmpManager));
        GenericDummyTransceiver e2 = new GenericDummyTransceiver(address(gmpManager));

        // Set up transceivers
        gmpManager.setTransceiver(address(e1));
        gmpManager.setTransceiver(address(e2));

        // Set up peers
        uint16 chainId3 = 9;
        gmpManager.setPeer(chainId2, toWormholeFormat(address(gmpManagerOther)));
        gmpManager.setPeer(chainId3, toWormholeFormat(address(0x123)));

        // Configure e1 for multiple chains (both send and receive)
        gmpManager.setSendTransceiverForChain(chainId2, address(e1));
        gmpManager.setReceiveTransceiverForChain(chainId2, address(e1));
        gmpManager.setSendTransceiverForChain(chainId3, address(e1));
        gmpManager.setReceiveTransceiverForChain(chainId3, address(e1));

        // Configure e2 for one chain only
        gmpManager.setSendTransceiverForChain(chainId2, address(e2));
        gmpManager.setReceiveTransceiverForChain(chainId2, address(e2));

        // Also configure the dummyTransceiver from setUp for chain2 so we have 3 total
        gmpManager.setSendTransceiverForChain(chainId2, address(dummyTransceiver));
        gmpManager.setReceiveTransceiverForChain(chainId2, address(dummyTransceiver));

        // Set thresholds
        gmpManager.setThreshold(chainId2, 2);
        gmpManager.setThreshold(chainId3, 1);

        // Verify initial configuration
        address[] memory sendTransceivers2 = gmpManager.getSendTransceiversForChain(chainId2);
        // Should have e1, e2, and dummyTransceiver
        assertEq(sendTransceivers2.length, 3);

        address[] memory sendTransceivers3 = gmpManager.getSendTransceiversForChain(chainId3);
        assertEq(sendTransceivers3.length, 1);

        (address[] memory receiveTransceivers2,) =
            gmpManager.getReceiveTransceiversForChain(chainId2);
        assertEq(receiveTransceivers2.length, 3);

        (address[] memory receiveTransceivers3,) =
            gmpManager.getReceiveTransceiversForChain(chainId3);
        assertEq(receiveTransceivers3.length, 1);

        // Remove e1 (should remove from all chains)
        gmpManager.removeTransceiver(address(e1));

        // Verify e1 is removed from all chains, should have e2 and dummyTransceiver left
        sendTransceivers2 = gmpManager.getSendTransceiversForChain(chainId2);
        assertEq(sendTransceivers2.length, 2);

        (receiveTransceivers2,) = gmpManager.getReceiveTransceiversForChain(chainId2);
        assertEq(receiveTransceivers2.length, 2);

        // Verify e1 is not in the list
        bool foundE1 = false;
        for (uint256 i = 0; i < sendTransceivers2.length; i++) {
            if (sendTransceivers2[i] == address(e1)) {
                foundE1 = true;
                break;
            }
        }
        assertFalse(foundE1);

        // Chain 3 should have no transceivers now
        vm.expectRevert(
            abi.encodeWithSelector(
                TransceiverRegistry.NoTransceiversConfiguredForChain.selector, chainId3
            )
        );
        gmpManager.getSendTransceiversForChain(chainId3);

        vm.expectRevert(
            abi.encodeWithSelector(
                TransceiverRegistry.NoTransceiversConfiguredForChain.selector, chainId3
            )
        );
        gmpManager.getReceiveTransceiversForChain(chainId3);

        // e2 and dummyTransceiver should still be globally enabled, but not e1
        address[] memory globalTransceivers = gmpManager.getTransceivers();
        assertEq(globalTransceivers.length, 2);

        foundE1 = false;
        bool foundE2 = false;
        bool foundDummy = false;

        for (uint256 i = 0; i < globalTransceivers.length; i++) {
            if (globalTransceivers[i] == address(e1)) foundE1 = true;
            if (globalTransceivers[i] == address(e2)) foundE2 = true;
            if (globalTransceivers[i] == address(dummyTransceiver)) foundDummy = true;
        }

        assertFalse(foundE1);
        assertTrue(foundE2);
        assertTrue(foundDummy);
    }
}
