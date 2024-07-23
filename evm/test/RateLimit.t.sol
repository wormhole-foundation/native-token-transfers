// SPDX-License-Identifier: Apache 2

import "forge-std/Test.sol";
import "../src/interfaces/IRateLimiterEvents.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/NttManager/NttManager.sol";
import "./mocks/DummyTransceiver.sol";
import "../src/mocks/DummyToken.sol";
import "./mocks/MockNttManager.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./libraries/TransceiverHelpers.sol";
import "./libraries/NttManagerHelpers.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

pragma solidity >=0.8.8 <0.9.0;

contract TestRateLimit is Test, IRateLimiterEvents {
    MockNttManagerContract nttManager;

    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;
    using BytesParsing for bytes;

    uint16 constant chainId = 7;
    uint16 constant chainId2 = 8;

    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;
    WormholeSimulator guardian;
    uint256 initialBlockTimestamp;

    function setUp() public {
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);
        vm.createSelectFork(url);
        initialBlockTimestamp = vm.getBlockTimestamp();

        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        DummyToken t = new DummyToken();
        NttManager implementation =
            new MockNttManagerContract(address(t), INttManager.Mode.LOCKING, chainId, 1 days, false);

        nttManager = MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        nttManager.initialize();

        nttManager.setPeer(chainId2, toWormholeFormat(address(0x1)), 9, type(uint64).max);

        DummyTransceiver e = new DummyTransceiver(address(nttManager));
        nttManager.setTransceiver(address(e));
    }

    function test_outboundRateLimit_setLimitSimple() public {
        DummyToken token = DummyToken(nttManager.token());
        uint8 decimals = token.decimals();

        uint256 limit = 1 * 10 ** 6;
        nttManager.setOutboundLimit(limit);

        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();

        assertEq(outboundLimitParams.limit.getAmount(), limit.trim(decimals, decimals).getAmount());
        assertEq(
            outboundLimitParams.currentCapacity.getAmount(),
            limit.trim(decimals, decimals).getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
    }

    function test_outboundRateLimit() public {
        // transfer 3 tokens
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 3 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // assert outbound rate limit was updated
        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();
        assertEq(
            outboundLimitParams.currentCapacity.getAmount(),
            (outboundLimit - transferAmount).trim(decimals, decimals).getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);

        // assert inbound rate limit for destination chain is still at the max.
        // the backflow should not override the limit.
        IRateLimiter.RateLimitParams memory inboundLimitParams =
            nttManager.getInboundLimitParams(chainId2);
        assertEq(
            inboundLimitParams.currentCapacity.getAmount(), inboundLimitParams.limit.getAmount()
        );
        assertEq(inboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
    }

    function test_outboundRateLimit_setHigherLimit() public {
        // transfer 3 tokens
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 3 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // update the outbound limit to 5 tokens
        vm.startPrank(address(this));

        uint256 higherLimit = 5 * 10 ** decimals;
        nttManager.setOutboundLimit(higherLimit);

        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();

        assertEq(
            outboundLimitParams.limit.getAmount(), higherLimit.trim(decimals, decimals).getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
        assertEq(
            outboundLimitParams.currentCapacity.getAmount(),
            (2 * 10 ** decimals).trim(decimals, decimals).getAmount()
        );
    }

    function test_outboundRateLimit_setLowerLimit() public {
        // transfer 3 tokens
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 3 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // update the outbound limit to 5 tokens
        vm.startPrank(address(this));

        uint256 lowerLimit = 2 * 10 ** decimals;
        nttManager.setOutboundLimit(lowerLimit);

        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();

        assertEq(outboundLimitParams.limit.untrim(decimals), lowerLimit);
        assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
        assertEq(outboundLimitParams.currentCapacity.getAmount(), 0);
    }

    function test_outboundRateLimit_setHigherLimit_duration() public {
        // transfer 3 tokens
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 3 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // change block timestamp to be 6 hours later
        uint256 sixHoursLater = initialBlockTimestamp + 6 hours;
        vm.warp(sixHoursLater);

        // update the outbound limit to 5 tokens
        vm.startPrank(address(this));

        uint256 higherLimit = 5 * 10 ** decimals;
        nttManager.setOutboundLimit(higherLimit);

        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();

        assertEq(
            outboundLimitParams.limit.getAmount(), higherLimit.trim(decimals, decimals).getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, sixHoursLater);
        // capacity should be:
        // difference in limits + remaining capacity after t1 + the amount that's refreshed (based on the old rps)
        assertEq(
            outboundLimitParams.currentCapacity.getAmount(),
            (
                (1 * 10 ** decimals) + (1 * 10 ** decimals)
                    + (outboundLimit * (6 hours)) / nttManager.rateLimitDuration()
            ).trim(decimals, decimals).getAmount()
        );
    }

    function test_outboundRateLimit_setLowerLimit_durationCaseOne() public {
        // transfer 3 tokens
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 5 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 4 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // change block timestamp to be 6 hours later
        uint256 sixHoursLater = initialBlockTimestamp + 3 hours;
        vm.warp(sixHoursLater);

        // update the outbound limit to 3 tokens
        vm.startPrank(address(this));

        uint256 lowerLimit = 3 * 10 ** decimals;
        nttManager.setOutboundLimit(lowerLimit);

        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();

        assertEq(
            outboundLimitParams.limit.getAmount(), lowerLimit.trim(decimals, decimals).getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, sixHoursLater);
        // capacity should be: 0
        assertEq(outboundLimitParams.currentCapacity.getAmount(), 0);
    }

    function test_outboundRateLimit_setLowerLimit_durationCaseTwo() public {
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        // set the outbound limit to 5 tokens
        uint256 outboundLimit = 5 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        // transfer 2 tokens
        uint256 transferAmount = 2 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // change block timestamp to be 6 hours later
        uint256 sixHoursLater = initialBlockTimestamp + 6 hours;
        vm.warp(sixHoursLater);

        vm.startPrank(address(this));

        // update the outbound limit to 4 tokens
        uint256 lowerLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(lowerLimit);

        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();

        assertEq(
            outboundLimitParams.limit.getAmount(), lowerLimit.trim(decimals, decimals).getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, sixHoursLater);
        // capacity should be:
        // remaining capacity after t1 - difference in limits + the amount that's refreshed (based on the old rps)
        assertEq(
            outboundLimitParams.currentCapacity.getAmount(),
            (
                (3 * 10 ** decimals) - (1 * 10 ** decimals)
                    + (outboundLimit * (6 hours)) / nttManager.rateLimitDuration()
            ).trim(decimals, decimals).getAmount()
        );
    }

    function test_outboundRateLimit_singleHit() public {
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 1 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 3 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                IRateLimiter.NotEnoughCapacity.selector, outboundLimit, transferAmount
            )
        );
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );
    }

    function test_outboundRateLimit_multiHit() public {
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 3 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);
        nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        // assert that first transfer went through
        assertEq(token.balanceOf(address(user_A)), 2 * 10 ** decimals);
        assertEq(token.balanceOf(address(nttManager)), transferAmount);

        // assert currentCapacity is updated
        TrimmedAmount newCapacity =
            outboundLimit.trim(decimals, decimals) - (transferAmount.trim(decimals, decimals));
        assertEq(nttManager.getCurrentOutboundCapacity(), newCapacity.untrim(decimals));

        uint256 badTransferAmount = 2 * 10 ** decimals;
        token.approve(address(nttManager), badTransferAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                IRateLimiter.NotEnoughCapacity.selector,
                newCapacity.untrim(decimals),
                badTransferAmount
            )
        );
        nttManager.transfer(
            badTransferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );
    }

    // make a transfer with shouldQueue == true
    // check that it hits rate limit and gets inserted into the queue
    // test that it remains in queue after < rateLimitDuration
    // test that it exits queue after >= rateLimitDuration
    // test that it's removed from queue and can't be replayed
    function test_outboundRateLimit_queue() public {
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();

        token.mintDummy(address(user_A), 5 * 10 ** decimals);
        uint256 outboundLimit = 4 * 10 ** decimals;
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        uint256 transferAmount = 5 * 10 ** decimals;
        token.approve(address(nttManager), transferAmount);

        // transfer with shouldQueue == true
        uint64 qSeq = nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            true,
            new bytes(1)
        );

        // assert that the transfer got queued up
        assertEq(qSeq, 0);
        IRateLimiter.OutboundQueuedTransfer memory qt = nttManager.getOutboundQueuedTransfer(0);
        assertEq(qt.amount.getAmount(), transferAmount.trim(decimals, decimals).getAmount());
        assertEq(qt.recipientChain, chainId2);
        assertEq(qt.recipient, toWormholeFormat(user_B));
        assertEq(qt.txTimestamp, initialBlockTimestamp);

        // assert that the contract also locked funds from the user
        assertEq(token.balanceOf(address(user_A)), 0);
        assertEq(token.balanceOf(address(nttManager)), transferAmount);

        // elapse rate limit duration - 1
        uint256 durationElapsedTime = initialBlockTimestamp + nttManager.rateLimitDuration();
        vm.warp(durationElapsedTime - 1);

        // assert that transfer still can't be completed
        vm.expectRevert(
            abi.encodeWithSelector(
                IRateLimiter.OutboundQueuedTransferStillQueued.selector, 0, initialBlockTimestamp
            )
        );
        nttManager.completeOutboundQueuedTransfer(0);

        // now complete transfer
        vm.warp(durationElapsedTime);
        uint64 seq = nttManager.completeOutboundQueuedTransfer(0);
        assertEq(seq, 0);

        // now ensure transfer was removed from queue
        vm.expectRevert(
            abi.encodeWithSelector(IRateLimiter.OutboundQueuedTransferNotFound.selector, 0)
        );
        nttManager.completeOutboundQueuedTransfer(0);
    }

    function test_inboundRateLimit_simple() public {
        address user_B = address(0x456);

        (DummyTransceiver e1, DummyTransceiver e2) =
            TransceiverHelpersLib.setup_transceivers(nttManager);

        DummyToken token = DummyToken(nttManager.token());

        ITransceiverReceiver[] memory transceivers = new ITransceiverReceiver[](2);
        transceivers[0] = e1;
        transceivers[1] = e2;

        TrimmedAmount transferAmount = packTrimmedAmount(50, 8);
        TrimmedAmount limitAmount = packTrimmedAmount(100, 8);
        TransceiverHelpersLib.attestTransceiversHelper(
            user_B, 0, chainId, nttManager, nttManager, transferAmount, limitAmount, transceivers
        );

        // assert that the user received tokens
        assertEq(token.balanceOf(address(user_B)), transferAmount.untrim(token.decimals()));

        // assert that the inbound limits updated
        IRateLimiter.RateLimitParams memory inboundLimitParams =
            nttManager.getInboundLimitParams(TransceiverHelpersLib.SENDING_CHAIN_ID);
        assertEq(
            inboundLimitParams.currentCapacity.getAmount(),
            (limitAmount - (transferAmount)).getAmount()
        );
        assertEq(inboundLimitParams.lastTxTimestamp, initialBlockTimestamp);

        // assert that the outbound limit is still at the max
        // backflow should not go over the max limit
        IRateLimiter.RateLimitParams memory outboundLimitParams =
            nttManager.getOutboundLimitParams();
        assertEq(
            outboundLimitParams.currentCapacity.getAmount(), outboundLimitParams.limit.getAmount()
        );
        assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
    }

    function test_inboundRateLimit_queue() public {
        address user_B = address(0x456);

        (DummyTransceiver e1, DummyTransceiver e2) =
            TransceiverHelpersLib.setup_transceivers(nttManager);

        DummyToken token = DummyToken(nttManager.token());

        ITransceiverReceiver[] memory transceivers = new ITransceiverReceiver[](1);
        transceivers[0] = e1;

        TransceiverStructs.NttManagerMessage memory m;
        bytes memory encodedEm;
        {
            TransceiverStructs.TransceiverMessage memory em;
            (m, em) = TransceiverHelpersLib.attestTransceiversHelper(
                user_B,
                0,
                chainId,
                nttManager,
                nttManager,
                packTrimmedAmount(50, 8),
                uint256(5).trim(token.decimals(), token.decimals()),
                transceivers
            );
            encodedEm = TransceiverStructs.encodeTransceiverMessage(
                TransceiverHelpersLib.TEST_TRANSCEIVER_PAYLOAD_PREFIX, em
            );
        }

        bytes32 digest =
            TransceiverStructs.nttManagerMessageDigest(TransceiverHelpersLib.SENDING_CHAIN_ID, m);

        // no quorum yet
        assertEq(token.balanceOf(address(user_B)), 0);

        vm.expectEmit(address(nttManager));
        emit InboundTransferQueued(digest);
        e2.receiveMessage(encodedEm);

        {
            // now we have quorum but it'll hit limit
            IRateLimiter.InboundQueuedTransfer memory qt =
                nttManager.getInboundQueuedTransfer(digest);
            assertEq(qt.amount.getAmount(), 50);
            assertEq(qt.txTimestamp, initialBlockTimestamp);
            assertEq(qt.recipient, user_B);
        }

        // assert that the user doesn't have funds yet
        assertEq(token.balanceOf(address(user_B)), 0);

        // change block time to (duration - 1) seconds later
        uint256 durationElapsedTime = initialBlockTimestamp + nttManager.rateLimitDuration();
        vm.warp(durationElapsedTime - 1);

        {
            // assert that transfer still can't be completed
            vm.expectRevert(
                abi.encodeWithSelector(
                    IRateLimiter.InboundQueuedTransferStillQueued.selector,
                    digest,
                    initialBlockTimestamp
                )
            );
            nttManager.completeInboundQueuedTransfer(digest);
        }

        // now complete transfer
        vm.warp(durationElapsedTime);
        nttManager.completeInboundQueuedTransfer(digest);

        {
            // assert transfer no longer in queue
            vm.expectRevert(
                abi.encodeWithSelector(IRateLimiter.InboundQueuedTransferNotFound.selector, digest)
            );
            nttManager.completeInboundQueuedTransfer(digest);
        }

        // assert user now has funds
        assertEq(token.balanceOf(address(user_B)), 50 * 10 ** (token.decimals() - 8));

        // replay protection on executeMsg
        vm.recordLogs();
        nttManager.executeMsg(
            TransceiverHelpersLib.SENDING_CHAIN_ID, toWormholeFormat(address(nttManager)), m
        );

        {
            Vm.Log[] memory entries = vm.getRecordedLogs();
            assertEq(entries.length, 1);
            assertEq(entries[0].topics.length, 3);
            assertEq(entries[0].topics[0], keccak256("MessageAlreadyExecuted(bytes32,bytes32)"));
            assertEq(entries[0].topics[1], toWormholeFormat(address(nttManager)));
            assertEq(
                entries[0].topics[2],
                TransceiverStructs.nttManagerMessageDigest(
                    TransceiverHelpersLib.SENDING_CHAIN_ID, m
                )
            );
        }
    }

    function test_circular_flow() public {
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();
        assertEq(decimals, 18);

        TrimmedAmount mintAmount = packTrimmedAmount(50, 8);
        token.mintDummy(address(user_A), mintAmount.untrim(decimals));
        nttManager.setOutboundLimit(mintAmount.untrim(decimals));

        // transfer 10 tokens
        vm.startPrank(user_A);

        TrimmedAmount transferAmount = packTrimmedAmount(10, 8);
        token.approve(address(nttManager), type(uint256).max);
        // transfer 10 tokens from user_A -> user_B via the nttManager
        nttManager.transfer(
            transferAmount.untrim(decimals),
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // assert nttManager has 10 tokens and user_A has 10 fewer tokens
        assertEq(token.balanceOf(address(nttManager)), transferAmount.untrim(decimals));
        assertEq(token.balanceOf(user_A), (mintAmount - (transferAmount)).untrim(decimals));

        {
            // consumed capacity on the outbound side
            // assert outbound capacity decreased
            IRateLimiter.RateLimitParams memory outboundLimitParams =
                nttManager.getOutboundLimitParams();
            assertEq(
                outboundLimitParams.currentCapacity.getAmount(),
                (outboundLimitParams.limit - (transferAmount)).getAmount()
            );
            assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
        }

        // go 1 second into the future
        uint256 receiveTime = initialBlockTimestamp + 1;
        vm.warp(receiveTime);

        // now receive 10 tokens from user_B -> user_A
        (DummyTransceiver e1, DummyTransceiver e2) =
            TransceiverHelpersLib.setup_transceivers(nttManager);

        ITransceiverReceiver[] memory transceivers = new ITransceiverReceiver[](2);
        transceivers[0] = e1;
        transceivers[1] = e2;

        TransceiverHelpersLib.attestTransceiversHelper(
            user_A, 0, chainId, nttManager, nttManager, transferAmount, mintAmount, transceivers
        );

        // assert that user_A has original amount
        assertEq(token.balanceOf(user_A), mintAmount.untrim(decimals));

        {
            // consume capacity on the inbound side
            // assert that the inbound capacity decreased
            IRateLimiter.RateLimitParams memory inboundLimitParams =
                nttManager.getInboundLimitParams(TransceiverHelpersLib.SENDING_CHAIN_ID);
            assertEq(
                inboundLimitParams.currentCapacity.getAmount(),
                (inboundLimitParams.limit - transferAmount).getAmount()
            );
            assertEq(inboundLimitParams.lastTxTimestamp, receiveTime);
        }

        {
            // assert that outbound limit is at max again (because of backflow)
            IRateLimiter.RateLimitParams memory outboundLimitParams =
                nttManager.getOutboundLimitParams();
            assertEq(
                outboundLimitParams.currentCapacity.getAmount(),
                outboundLimitParams.limit.getAmount()
            );
            assertEq(outboundLimitParams.lastTxTimestamp, receiveTime);
        }

        // go 1 second into the future
        uint256 sendAgainTime = receiveTime + 1;
        vm.warp(sendAgainTime);

        // transfer 10 back to the contract
        vm.startPrank(user_A);

        // push onto the stack again to avoid stack too deep error
        address userA = user_A;

        nttManager.transfer(
            transferAmount.untrim(decimals),
            TransceiverHelpersLib.SENDING_CHAIN_ID,
            toWormholeFormat(user_B),
            toWormholeFormat(userA),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        {
            // assert outbound rate limit decreased
            IRateLimiter.RateLimitParams memory outboundLimitParams =
                nttManager.getOutboundLimitParams();
            assertEq(
                outboundLimitParams.currentCapacity.getAmount(),
                (outboundLimitParams.limit - transferAmount).getAmount()
            );
            assertEq(outboundLimitParams.lastTxTimestamp, sendAgainTime);
        }

        {
            // assert that the inbound limit is at max again (because of backflow)
            IRateLimiter.RateLimitParams memory inboundLimitParams =
                nttManager.getInboundLimitParams(TransceiverHelpersLib.SENDING_CHAIN_ID);
            assertEq(
                inboundLimitParams.currentCapacity.getAmount(), inboundLimitParams.limit.getAmount()
            );
            assertEq(inboundLimitParams.lastTxTimestamp, sendAgainTime);
        }
    }

    // helper functions
    function setupToken() public returns (address, address, DummyToken, uint8) {
        address user_A = address(0x123);
        address user_B = address(0x456);

        DummyToken token = DummyToken(nttManager.token());

        uint8 decimals = token.decimals();
        assertEq(decimals, 18);

        return (user_A, user_B, token, decimals);
    }

    function initializeTransceivers() public returns (ITransceiverReceiver[] memory) {
        (DummyTransceiver e1, DummyTransceiver e2) =
            TransceiverHelpersLib.setup_transceivers(nttManager);

        ITransceiverReceiver[] memory transceivers = new ITransceiverReceiver[](2);
        transceivers[0] = e1;
        transceivers[1] = e2;

        return transceivers;
    }

    function expectRevert(
        address contractAddress,
        bytes memory encodedSignature,
        string memory expectedRevert
    ) internal {
        (bool success, bytes memory result) = contractAddress.call(encodedSignature);
        require(!success, "call did not revert");

        console.log("result: %s", result.length);
        // // compare revert strings
        bytes32 expectedRevertHash = keccak256(abi.encode(expectedRevert));
        (bytes memory res,) = result.slice(4, result.length - 4);
        bytes32 actualRevertHash = keccak256(abi.encodePacked(res));
        require(expectedRevertHash == actualRevertHash, "call did not revert as expected");
    }

    // transfer tokens from user_A to user_B
    // this consumes capacity on the outbound side
    // send tokens from user_B to user_A
    // this consumes capacity on the inbound side
    // send tokens from user_A to user_B
    // this should consume capacity on the outbound side
    // and backfill the inbound side
    function testFuzz_CircularFlowBackFilling(uint256 mintAmt, uint256 transferAmt) public {
        mintAmt = bound(mintAmt, 1, type(uint256).max);
        // enforces transferAmt <= mintAmt
        transferAmt = bound(transferAmt, 0, mintAmt);

        (address user_A, address user_B, DummyToken token, uint8 decimals) = setupToken();

        // allow for amounts greater than uint64 to check if [`setOutboundLimit`] reverts
        // on amounts greater than u64 MAX.
        if (mintAmt.scale(decimals, 8) > type(uint64).max) {
            vm.expectRevert("SafeCast: value doesn't fit in 64 bits");
            nttManager.setOutboundLimit(mintAmt);

            return;
        }

        nttManager.setOutboundLimit(mintAmt);
        TrimmedAmount mintAmount = mintAmt.trim(decimals, 8);
        token.mintDummy(address(user_A), mintAmount.untrim(decimals));
        nttManager.setOutboundLimit(mintAmount.untrim(decimals));

        vm.startPrank(user_A);
        token.approve(address(nttManager), type(uint256).max);

        TrimmedAmount transferAmount = transferAmt.trim(decimals, 8);

        // check error conditions
        // revert if amount to be transferred is 0
        if (transferAmount.getAmount() == 0) {
            vm.expectRevert(abi.encodeWithSelector(INttManager.ZeroAmount.selector));
            nttManager.transfer(
                transferAmount.untrim(decimals),
                chainId2,
                toWormholeFormat(user_B),
                toWormholeFormat(user_A),
                false,
                new bytes(1)
            );

            return;
        }

        // transfer tokens from user_A -> user_B via the nttManager
        nttManager.transfer(
            transferAmount.untrim(decimals),
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        // assert nttManager has 10 tokens and user_A has 10 fewer tokens
        assertEq(token.balanceOf(address(nttManager)), transferAmount.untrim(decimals));
        assertEq(token.balanceOf(user_A), (mintAmount - transferAmount).untrim(decimals));

        {
            // consumed capacity on the outbound side
            // assert outbound capacity decreased
            IRateLimiter.RateLimitParams memory outboundLimitParams =
                nttManager.getOutboundLimitParams();
            assertEq(
                outboundLimitParams.currentCapacity.getAmount(),
                (outboundLimitParams.limit - transferAmount).getAmount()
            );
            assertEq(outboundLimitParams.lastTxTimestamp, initialBlockTimestamp);
        }

        // go 1 second into the future
        uint256 receiveTime = initialBlockTimestamp + 1;
        vm.warp(receiveTime);

        ITransceiverReceiver[] memory transceivers = initializeTransceivers();
        // now receive tokens from user_B -> user_A
        TransceiverHelpersLib.attestTransceiversHelper(
            user_A, 0, chainId, nttManager, nttManager, transferAmount, mintAmount, transceivers
        );

        // assert that user_A has original amount
        assertEq(token.balanceOf(user_A), mintAmount.untrim(decimals));

        {
            // consume capacity on the inbound side
            // assert that the inbound capacity decreased
            IRateLimiter.RateLimitParams memory inboundLimitParams =
                nttManager.getInboundLimitParams(TransceiverHelpersLib.SENDING_CHAIN_ID);
            assertEq(
                inboundLimitParams.currentCapacity.getAmount(),
                (inboundLimitParams.limit - transferAmount).getAmount()
            );
            assertEq(inboundLimitParams.lastTxTimestamp, receiveTime);
        }

        {
            // assert that outbound limit is at max again (because of backflow)
            IRateLimiter.RateLimitParams memory outboundLimitParams =
                nttManager.getOutboundLimitParams();
            assertEq(
                outboundLimitParams.currentCapacity.getAmount(),
                outboundLimitParams.limit.getAmount()
            );
            assertEq(outboundLimitParams.lastTxTimestamp, receiveTime);
        }

        // go 1 second into the future
        uint256 sendAgainTime = receiveTime + 1;
        vm.warp(sendAgainTime);

        // transfer 10 back to the contract
        vm.startPrank(user_A);

        nttManager.transfer(
            transferAmount.untrim(decimals),
            TransceiverHelpersLib.SENDING_CHAIN_ID,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            false,
            new bytes(1)
        );

        vm.stopPrank();

        {
            // assert outbound rate limit decreased
            IRateLimiter.RateLimitParams memory outboundLimitParams =
                nttManager.getOutboundLimitParams();
            assertEq(
                outboundLimitParams.currentCapacity.getAmount(),
                (outboundLimitParams.limit - transferAmount).getAmount()
            );
            assertEq(outboundLimitParams.lastTxTimestamp, sendAgainTime);
        }

        {
            // assert that the inbound limit is at max again (because of backflow)
            IRateLimiter.RateLimitParams memory inboundLimitParams =
                nttManager.getInboundLimitParams(TransceiverHelpersLib.SENDING_CHAIN_ID);
            assertEq(
                inboundLimitParams.currentCapacity.getAmount(), inboundLimitParams.limit.getAmount()
            );
            assertEq(inboundLimitParams.lastTxTimestamp, sendAgainTime);
        }
    }

    function testFuzz_outboundRateLimitShouldQueue(uint256 limitAmt, uint256 transferAmt) public {
        // setup
        address user_A = address(0x123);
        address user_B = address(0x456);
        DummyToken token = DummyToken(nttManager.token());
        uint8 decimals = token.decimals();

        // inputs
        uint256 totalAmt = (type(uint64).max) / (10 ** decimals);
        // avoids the ZeroAmount() error
        // cannot transfer more than what's available
        transferAmt = bound(transferAmt, 1, totalAmt);
        // this ensures that the transfer is always queued up
        vm.assume(limitAmt < transferAmt);

        // mint
        token.mintDummy(address(user_A), totalAmt * (10 ** decimals));
        uint256 outboundLimit = limitAmt * (10 ** decimals);
        nttManager.setOutboundLimit(outboundLimit);

        vm.startPrank(user_A);

        // initiate transfer
        uint256 transferAmount = transferAmt * (10 ** decimals);
        token.approve(address(nttManager), transferAmount);

        // shouldQueue == true
        uint64 qSeq = nttManager.transfer(
            transferAmount,
            chainId2,
            toWormholeFormat(user_B),
            toWormholeFormat(user_A),
            true,
            new bytes(1)
        );

        // assert that the transfer got queued up
        assertEq(qSeq, 0);
        IRateLimiter.OutboundQueuedTransfer memory qt = nttManager.getOutboundQueuedTransfer(0);
        assertEq(qt.amount.getAmount(), transferAmount.trim(decimals, decimals).getAmount());
        assertEq(qt.recipientChain, chainId2);
        assertEq(qt.recipient, toWormholeFormat(user_B));
        assertEq(qt.txTimestamp, initialBlockTimestamp);

        // assert that the contract also locked funds from the user
        assertEq(token.balanceOf(address(user_A)), totalAmt * (10 ** decimals) - transferAmount);
        assertEq(token.balanceOf(address(nttManager)), transferAmount);

        // elapse rate limit duration - 1
        uint256 durationElapsedTime = initialBlockTimestamp + nttManager.rateLimitDuration();
        vm.warp(durationElapsedTime - 1);

        // assert that transfer still can't be completed
        vm.expectRevert(
            abi.encodeWithSelector(
                IRateLimiter.OutboundQueuedTransferStillQueued.selector, 0, initialBlockTimestamp
            )
        );
        nttManager.completeOutboundQueuedTransfer(0);

        // now complete transfer
        vm.warp(durationElapsedTime);
        uint64 seq = nttManager.completeOutboundQueuedTransfer(0);
        assertEq(seq, 0);

        // now ensure transfer was removed from queue
        vm.expectRevert(
            abi.encodeWithSelector(IRateLimiter.OutboundQueuedTransferNotFound.selector, 0)
        );
        nttManager.completeOutboundQueuedTransfer(0);
    }

    function testFuzz_inboundRateLimitShouldQueue(uint256 inboundLimitAmt, uint256 amount) public {
        amount = bound(amount, 1, type(uint64).max);
        inboundLimitAmt = bound(amount, 0, amount - 1);

        address user_B = address(0x456);

        (DummyTransceiver e1, DummyTransceiver e2) =
            TransceiverHelpersLib.setup_transceivers(nttManager);

        DummyToken token = DummyToken(nttManager.token());

        ITransceiverReceiver[] memory transceivers = new ITransceiverReceiver[](1);
        transceivers[0] = e1;

        TransceiverStructs.NttManagerMessage memory m;
        bytes memory encodedEm;
        uint256 inboundLimit = inboundLimitAmt;
        TrimmedAmount trimmedAmount = packTrimmedAmount(uint64(amount), 8);
        {
            TransceiverStructs.TransceiverMessage memory em;
            (m, em) = TransceiverHelpersLib.attestTransceiversHelper(
                user_B,
                0,
                chainId,
                nttManager,
                nttManager,
                trimmedAmount,
                inboundLimit.trim(token.decimals(), token.decimals()),
                transceivers
            );
            encodedEm = TransceiverStructs.encodeTransceiverMessage(
                TransceiverHelpersLib.TEST_TRANSCEIVER_PAYLOAD_PREFIX, em
            );
        }

        bytes32 digest =
            TransceiverStructs.nttManagerMessageDigest(TransceiverHelpersLib.SENDING_CHAIN_ID, m);

        // no quorum yet
        assertEq(token.balanceOf(address(user_B)), 0);

        vm.expectEmit(address(nttManager));
        emit InboundTransferQueued(digest);
        e2.receiveMessage(encodedEm);

        {
            // now we have quorum but it'll hit limit
            IRateLimiter.InboundQueuedTransfer memory qt =
                nttManager.getInboundQueuedTransfer(digest);
            assertEq(qt.amount.getAmount(), trimmedAmount.getAmount());
            assertEq(qt.txTimestamp, initialBlockTimestamp);
            assertEq(qt.recipient, user_B);
        }

        // assert that the user doesn't have funds yet
        assertEq(token.balanceOf(address(user_B)), 0);

        // change block time to (duration - 1) seconds later
        uint256 durationElapsedTime = initialBlockTimestamp + nttManager.rateLimitDuration();
        vm.warp(durationElapsedTime - 1);

        {
            // assert that transfer still can't be completed
            vm.expectRevert(
                abi.encodeWithSelector(
                    IRateLimiter.InboundQueuedTransferStillQueued.selector,
                    digest,
                    initialBlockTimestamp
                )
            );
            nttManager.completeInboundQueuedTransfer(digest);
        }

        // now complete transfer
        vm.warp(durationElapsedTime);
        nttManager.completeInboundQueuedTransfer(digest);

        {
            // assert transfer no longer in queue
            vm.expectRevert(
                abi.encodeWithSelector(IRateLimiter.InboundQueuedTransferNotFound.selector, digest)
            );
            nttManager.completeInboundQueuedTransfer(digest);
        }

        // assert user now has funds
        assertEq(
            token.balanceOf(address(user_B)),
            trimmedAmount.getAmount() * 10 ** (token.decimals() - 8)
        );

        // replay protection on executeMsg
        vm.recordLogs();
        nttManager.executeMsg(
            TransceiverHelpersLib.SENDING_CHAIN_ID, toWormholeFormat(address(nttManager)), m
        );

        {
            Vm.Log[] memory entries = vm.getRecordedLogs();
            assertEq(entries.length, 1);
            assertEq(entries[0].topics.length, 3);
            assertEq(entries[0].topics[0], keccak256("MessageAlreadyExecuted(bytes32,bytes32)"));
            assertEq(entries[0].topics[1], toWormholeFormat(address(nttManager)));
            assertEq(
                entries[0].topics[2],
                TransceiverStructs.nttManagerMessageDigest(
                    TransceiverHelpersLib.SENDING_CHAIN_ID, m
                )
            );
        }
    }
}
