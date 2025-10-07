// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../src/MultiTokenNtt/MultiTokenNtt.sol";
import "../src/interfaces/IMultiTokenRateLimiter.sol";
import "../src/GmpManager/GmpManager.sol";
import "../src/interfaces/IRateLimiter.sol";
import "./mocks/WETH9.sol";
import "./mocks/MockERC20.sol";
import "./helpers/TestDeployment.sol";
import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Token} from "../src/MultiTokenNtt/Token.sol";
import "../src/libraries/TokenId.sol";
import "../src/interfaces/IGmpManager.sol";
import "./mocks/MockNttTokenReceiver.sol";

import {GenericDummyTransceiver} from "./mocks/DummyTransceiver.sol";
import "../src/NttManager/TransceiverRegistry.sol";

// Source: ntt/libraries/PausableUpgradeable.sol
error RequireContractIsNotPaused();
error RequireContractIsPaused();
error InvalidPauser(address account);
// Source: ntt/libraries/external/OwnableUpgradeable.sol
error OwnableUnauthorizedAccount(address account);

contract MultiTokenNttTest is Test {
    // Add receive function to handle ETH refunds
    receive() external payable {}

    // ============ Test Configuration ============
    TestDeployment chain1;
    TestDeployment chain2;
    uint16 constant CHAIN_ID = 2;
    uint16 constant OTHER_CHAIN_ID = 0xAB;

    // Test users and keys
    address user1 = vm.addr(uint256(bytes32("bob")));
    address user2 = vm.addr(uint256(bytes32("alice")));
    address relayer = vm.addr(uint256(bytes32("relayer")));
    uint256 user1Key = uint256(bytes32("bob"));

    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    // ============ Setup Functions ============
    function setUp() public {
        chain1 = new TestDeployment(CHAIN_ID);
        chain2 = new TestDeployment(OTHER_CHAIN_ID);
        _setupCrossChainCommunication();
    }

    function _setupCrossChainCommunication() internal {
        // Set GMP Manager peers
        chain1.gmpManager().setPeer(OTHER_CHAIN_ID, toWormholeFormat(address(chain2.gmpManager())));
        chain2.gmpManager().setPeer(CHAIN_ID, toWormholeFormat(address(chain1.gmpManager())));

        // Add transceivers
        chain1.addTransceiver();
        chain2.addTransceiver();

        // Configure bidirectional transceivers
        _configureBidirectionalTransceivers();

        // Set NTT peers
        chain1.ntt().setPeer(OTHER_CHAIN_ID, toWormholeFormat(address(chain2.ntt())));
        chain2.ntt().setPeer(CHAIN_ID, toWormholeFormat(address(chain1.ntt())));
    }

    function _configureBidirectionalTransceivers() internal {
        address chain1Transceiver = chain1.gmpManager().getTransceivers()[0];
        address chain2Transceiver = chain2.gmpManager().getTransceivers()[0];

        // Configure send transceivers
        chain1.gmpManager().setSendTransceiverForChain(OTHER_CHAIN_ID, chain1Transceiver);
        chain2.gmpManager().setSendTransceiverForChain(CHAIN_ID, chain2Transceiver);

        // Configure receive transceivers
        chain1.gmpManager().setReceiveTransceiverForChain(OTHER_CHAIN_ID, chain1Transceiver);
        chain2.gmpManager().setReceiveTransceiverForChain(CHAIN_ID, chain2Transceiver);
    }

    // ============ Helper Functions ============
    function _deployAndMintToken(
        string memory name,
        string memory symbol,
        address to,
        uint256 amount
    ) internal returns (MockERC20 token) {
        token = new MockERC20(name, symbol, 18);
        token.mint(to, amount);
    }

    function _executeTransfer(
        TestDeployment fromChain,
        TestDeployment toChain,
        address recipient,
        address token,
        uint256 amount,
        uint256 msgValue
    )
        internal
        returns (
            uint64 sequence,
            bytes memory payload,
            TransceiverStructs.TransceiverMessage memory parsed
        )
    {
        bytes32 recipientBytes32 = toWormholeFormat(recipient);
        uint16 targetChain = toChain.chainId();

        if (token == address(fromChain.ntt().WETH())) {
            MultiTokenNtt.GasTokenTransferArgs memory gasArgs = MultiTokenNtt.GasTokenTransferArgs({
                amount: amount,
                recipientChain: targetChain,
                recipient: recipientBytes32,
                refundAddress: recipientBytes32,
                shouldQueue: false,
                transceiverInstructions: new bytes(1),
                additionalPayload: ""
            });
            sequence = fromChain.ntt().wrapAndTransferGasToken{value: msgValue}(gasArgs);
        } else {
            MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
                token: token,
                amount: amount,
                recipientChain: targetChain,
                recipient: recipientBytes32,
                refundAddress: recipientBytes32,
                shouldQueue: false,
                transceiverInstructions: new bytes(1),
                additionalPayload: ""
            });
            sequence = fromChain.ntt().transfer{value: msgValue}(args);
        }

        (payload, parsed) = _extractTransferMessage(fromChain);
    }

    function _extractTransferMessage(
        TestDeployment fromChain
    )
        internal
        view
        returns (bytes memory payload, TransceiverStructs.TransceiverMessage memory parsed)
    {
        GenericDummyTransceiver transceiver =
            GenericDummyTransceiver(fromChain.gmpManager().getTransceivers()[0]);
        payload = transceiver.messages(transceiver.getMessagesLength() - 1);

        GenericDummyTransceiver.DummyTransceiverMessage memory message =
            abi.decode(payload, (GenericDummyTransceiver.DummyTransceiverMessage));

        parsed = TransceiverStructs.parseTransceiverMessage(
            transceiver.TEST_TRANSCEIVER_PAYLOAD_PREFIX(), message.transceiverMessage
        );
    }

    function _processMessage(TestDeployment chain, bytes memory payload) internal {
        vm.prank(relayer);
        GenericDummyTransceiver(chain.gmpManager().getTransceivers()[0]).receiveMessage(payload);
    }

    function _getWrappedToken(
        TestDeployment chain,
        address originalToken,
        uint16 originChainId
    ) internal view returns (Token) {
        return Token(
            chain.ntt().getToken(
                TokenId({chainId: originChainId, tokenAddress: toWormholeFormat(originalToken)})
            )
        );
    }

    // ============ Cross-Chain Transfer Tests ============
    function testTransferWETH() public {
        IWETH weth = chain1.ntt().WETH();
        uint256 amount = 100 * 10 ** 18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user1);

        vm.deal(sender, 10 * amount);
        vm.startPrank(sender);

        (uint64 sequence,, TransceiverStructs.TransceiverMessage memory transceiverMessage) =
            _executeTransfer(chain1, chain2, recipient, address(weth), amount, amount);

        TransceiverStructs.NttManagerMessage memory nttManagerMessage =
            TransceiverStructs.parseNttManagerMessage(transceiverMessage.nttManagerPayload);

        assertEq(nttManagerMessage.id, bytes32(uint256(1)));
        assertEq(nttManagerMessage.sender, toWormholeFormat(address(chain1.ntt())));

        GmpStructs.GenericMessage memory message =
            GmpStructs.parseGenericMessage(nttManagerMessage.payload);

        assertEq(message.toChain, OTHER_CHAIN_ID);

        NativeTokenTransferCodec.NativeTokenTransfer memory transferMessage =
            NativeTokenTransferCodec.parseNativeTokenTransfer(message.data);

        assertEq(transferMessage.amount.getDecimals(), 8);
        assertEq(transferMessage.amount.getAmount(), 100 * 10 ** 8);
        assertEq(transferMessage.token.meta.name, bytes32("Wrapped Ether"));
        assertEq(transferMessage.token.meta.symbol, bytes32("WETH"));
        assertEq(transferMessage.token.meta.decimals, 18);

        assertEq(transferMessage.token.token.chainId, CHAIN_ID);
        assertEq(transferMessage.token.token.tokenAddress, toWormholeFormat(address(weth)));

        assertEq(transferMessage.sender, toWormholeFormat(sender));
        assertEq(transferMessage.to, toWormholeFormat(recipient));

        assertEq(sequence, 1);
        assertEq(weth.balanceOf(address(chain1.ntt())), amount);
        assertEq(sender.balance, 9 * amount);
        vm.stopPrank();
    }

    function testTransferNative() public {
        uint256 amount = 100 * 10 ** 18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user1);

        MockERC20 chain1Token = _deployAndMintToken("Test Token", "TEST", sender, 10 * amount);

        vm.startPrank(sender);
        chain1Token.approve(address(chain1.ntt()), amount);

        (uint64 sequence,, TransceiverStructs.TransceiverMessage memory transceiverMessage) =
            _executeTransfer(chain1, chain2, recipient, address(chain1Token), amount, 0);

        TransceiverStructs.NttManagerMessage memory nttManagerMessage =
            TransceiverStructs.parseNttManagerMessage(transceiverMessage.nttManagerPayload);

        assertEq(nttManagerMessage.id, bytes32(uint256(1)));
        assertEq(nttManagerMessage.sender, toWormholeFormat(address(chain1.ntt())));

        GmpStructs.GenericMessage memory message =
            GmpStructs.parseGenericMessage(nttManagerMessage.payload);

        assertEq(message.toChain, OTHER_CHAIN_ID);

        NativeTokenTransferCodec.NativeTokenTransfer memory transferMessage =
            NativeTokenTransferCodec.parseNativeTokenTransfer(message.data);

        assertEq(transferMessage.amount.getDecimals(), 8);
        assertEq(transferMessage.amount.getAmount(), 100 * 10 ** 8);
        assertEq(transferMessage.token.meta.name, bytes32("Test Token"));
        assertEq(transferMessage.token.meta.symbol, bytes32("TEST"));
        assertEq(transferMessage.token.meta.decimals, 18);

        assertEq(transferMessage.token.token.chainId, CHAIN_ID);
        assertEq(transferMessage.token.token.tokenAddress, toWormholeFormat(address(chain1Token)));

        assertEq(transferMessage.sender, toWormholeFormat(sender));
        assertEq(transferMessage.to, toWormholeFormat(recipient));

        assertEq(sequence, 1);
        assertEq(chain1Token.balanceOf(address(chain1.ntt())), amount);
        assertEq(chain1Token.balanceOf(sender), 9 * amount);
        vm.stopPrank();
    }

    function testReceiveCreateWrapped() public {
        uint256 amount = 100 * 10 ** 18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user1);

        MockERC20 chain1Token = _deployAndMintToken("Test Token", "TEST", sender, 10 * amount);

        vm.startPrank(sender);
        chain1Token.approve(address(chain1.ntt()), amount);
        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, recipient, address(chain1Token), amount, 0);
        vm.stopPrank();

        _processMessage(chain2, payload);

        Token chain2Token = _getWrappedToken(chain2, address(chain1Token), chain1.chainId());

        assertEq(chain2Token.decimals(), 18);
        assertEq(chain2Token.symbol(), "TEST");
        assertEq(chain2Token.name(), "Test Token");
        assertEq(chain2Token.balanceOf(recipient), amount);
    }

    function testSendBack() public {
        MockERC20 chain1Token = new MockERC20("Test Token", "TEST", 18);
        uint256 amount = 100 * 10 ** 18;
        chain1Token.mint(chain1.addr(user1), 10 * amount);

        vm.startPrank(chain1.addr(user1));
        chain1Token.approve(address(chain1.ntt()), amount);

        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, chain2.addr(user1), address(chain1Token), amount, 0);
        vm.stopPrank();

        vm.startPrank(chain2.addr(relayer));
        GenericDummyTransceiver(chain2.gmpManager().getTransceivers()[0]).receiveMessage(payload);
        vm.stopPrank();

        // token created:
        Token chain2Token = Token(
            chain2.ntt().getToken(
                TokenId({
                    chainId: chain1.chainId(),
                    tokenAddress: toWormholeFormat(address(chain1Token))
                })
            )
        );

        vm.startPrank(chain2.addr(user1));
        chain2Token.approve(address(chain2.ntt()), amount);

        (, bytes memory payload2,) =
            _executeTransfer(chain2, chain1, chain1.addr(user2), address(chain2Token), amount, 0);
        vm.stopPrank();

        assertEq(chain1Token.balanceOf(chain1.addr(user2)), 0);

        vm.startPrank(relayer);
        GenericDummyTransceiver transceiver =
            GenericDummyTransceiver(chain1.gmpManager().getTransceivers()[0]);
        transceiver.receiveMessage(payload2);
        vm.stopPrank();

        assertEq(chain1Token.balanceOf(chain1.addr(user2)), amount);
    }

    function testSendBackETH() public {
        IWETH weth = chain1.ntt().WETH();
        uint256 amount = 100 * 10 ** 18;

        // Give user1 some ETH on chain1
        vm.deal(chain1.addr(user1), 10 * amount);

        // First transfer: chain1 (native ETH) -> chain2 (wrapped WETH)
        vm.startPrank(chain1.addr(user1));
        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, chain2.addr(user1), address(weth), amount, amount);
        vm.stopPrank();

        // Process transfer on chain2
        vm.startPrank(chain2.addr(relayer));
        GenericDummyTransceiver(chain2.gmpManager().getTransceivers()[0]).receiveMessage(payload);
        vm.stopPrank();

        // Get the wrapped token on chain2
        Token chain2Token = Token(
            chain2.ntt().getToken(
                TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(weth))})
            )
        );

        // Verify initial transfer state
        assertEq(chain2Token.balanceOf(chain2.addr(user1)), amount);
        assertEq(weth.balanceOf(address(chain1.ntt())), amount);
        assertEq(chain1.addr(user1).balance, 9 * amount);

        // Now transfer back: chain2 (wrapped WETH) -> chain1 (native ETH)
        vm.startPrank(chain2.addr(user1));
        chain2Token.approve(address(chain2.ntt()), amount);
        (, bytes memory payload2,) =
            _executeTransfer(chain2, chain1, chain1.addr(user1), address(chain2Token), amount, 0);
        vm.stopPrank();

        // Process return transfer on chain1
        vm.startPrank(chain1.addr(relayer));
        GenericDummyTransceiver(chain1.gmpManager().getTransceivers()[0]).receiveMessage(payload2);
        vm.stopPrank();

        // Verify final state
        assertEq(chain2Token.balanceOf(chain2.addr(user1)), 0); // User's chain2 balance should be 0
        assertEq(weth.balanceOf(address(chain1.ntt())), 0); // Contract's WETH should be 0
        assertEq(chain1.addr(user1).balance, 10 * amount); // User should have their ETH back
    }

    // ============ Security Tests ============
    function testReceiveNoReplay() public {
        uint256 amount = 100 * 10 ** 18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user1);

        MockERC20 chain1Token = _deployAndMintToken("Test Token", "TEST", sender, 10 * amount);

        vm.startPrank(sender);
        chain1Token.approve(address(chain1.ntt()), amount);
        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, recipient, address(chain1Token), amount, 0);
        vm.stopPrank();

        GenericDummyTransceiver transceiver =
            GenericDummyTransceiver(chain2.gmpManager().getTransceivers()[0]);

        vm.startPrank(relayer);
        transceiver.receiveMessage(payload);

        vm.expectRevert();
        transceiver.receiveMessage(payload);
        vm.stopPrank();
    }

    function testReceiveMultiple() public {
        MockERC20 chain1Token = new MockERC20("Test Token", "TEST", 18);
        uint256 amount = 100 * 10 ** 18;

        chain1Token.mint(chain1.addr(user1), 10 * amount);

        vm.startPrank(chain1.addr(user1));
        chain1Token.approve(address(chain1.ntt()), 2 * amount);

        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, chain2.addr(user1), address(chain1Token), amount, 0);
        (, bytes memory payload2,) =
            _executeTransfer(chain1, chain2, chain2.addr(user1), address(chain1Token), amount, 0);
        vm.stopPrank();

        // now let's complete the transfer
        vm.startPrank(chain2.addr(relayer));
        GenericDummyTransceiver transceiver =
            GenericDummyTransceiver(chain2.gmpManager().getTransceivers()[0]);
        transceiver.receiveMessage(payload);
        transceiver.receiveMessage(payload2);

        Token chain2Token = Token(
            chain2.ntt().getToken(
                TokenId({
                    chainId: chain1.chainId(),
                    tokenAddress: toWormholeFormat(address(chain1Token))
                })
            )
        );
        assertEq(chain2Token.balanceOf(chain2.addr(user1)), 2 * amount);
        vm.stopPrank();
    }

    // ============ Permit Tests ============
    function testTransferWithPermit() public {
        Token chain1Token = new Token();
        chain1Token.initialize("Test Token", "TEST", 18);
        uint256 amount = 100 * 10 ** 18;

        // Use a simple test user for permit testing
        uint256 testUserKey = 0x1234;
        address testUser = vm.addr(testUserKey);

        // Set the test contract as minter and mint tokens
        chain1Token.setMinter(address(this));
        chain1Token.mint(testUser, 10 * amount);

        // Create permit signature instead of direct approval
        {
            uint256 deadline = block.timestamp + 1000;
            uint256 nonce = chain1Token.nonces(testUser);
            bytes32 domainSeparator = chain1Token.DOMAIN_SEPARATOR();

            bytes32 structHash = keccak256(
                abi.encode(
                    keccak256(
                        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                    ),
                    testUser,
                    address(chain1.ntt()),
                    amount,
                    nonce,
                    deadline
                )
            );

            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(testUserKey, digest);

            // Use permit instead of approve
            vm.startPrank(testUser);
            chain1Token.permit(testUser, address(chain1.ntt()), amount, deadline, v, r, s);

            // Verify permit worked
            assertEq(chain1Token.allowance(testUser, address(chain1.ntt())), amount);
        }

        // Now execute the transfer as normal
        vm.startPrank(testUser);
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(chain1Token),
            amount: amount,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(chain2.addr(user2)),
            refundAddress: toWormholeFormat(chain2.addr(user2)),
            shouldQueue: false,
            transceiverInstructions: new bytes(1),
            additionalPayload: ""
        });
        uint64 sequence = chain1.ntt().transfer(args);

        // Verify the transfer was successful
        assertEq(sequence, 1);
        assertEq(chain1Token.balanceOf(address(chain1.ntt())), amount);
        assertEq(chain1Token.balanceOf(testUser), 9 * amount);

        vm.stopPrank();
    }

    function testRegularTransferStillWorks() public {
        uint256 amount = 10e18;

        // Regular transfer should still work
        vm.startPrank(user1);
        MockERC20 token = new MockERC20("Test Token", "TEST", 18);
        token.mint(user1, amount);
        token.approve(address(chain1.ntt()), amount);
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(user2),
            refundAddress: bytes32(0), // will default to recipient
            shouldQueue: false,
            transceiverInstructions: "",
            additionalPayload: ""
        });
        uint64 sequence = chain1.ntt().transfer(args);
        vm.stopPrank();

        // Sequence should be valid (0 or higher)
        assertTrue(sequence >= 0);
    }

    // ============ Payload Tests ============

    function testTransferWithPayloadFullIntegration() public {
        uint256 amount = 100e18;
        bytes memory swapPayload = abi.encode("swap", 1000, address(0xABC));

        // Deploy mock receiver on chain2 that trusts chain2's MultiTokenNtt
        MockNttTokenReceiver receiver = new MockNttTokenReceiver(address(chain2.ntt()));

        // Deploy and mint test token on chain1
        MockERC20 token = new MockERC20("Test Token", "TEST", 18);
        token.mint(user1, amount);

        // User1 approves and sends the transfer with payload
        vm.startPrank(user1);
        token.approve(address(chain1.ntt()), amount);
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(address(receiver)),
            refundAddress: bytes32(0), // will default to recipient
            shouldQueue: false,
            transceiverInstructions: "",
            additionalPayload: swapPayload
        });
        uint64 sequence = chain1.ntt().transfer(args);
        vm.stopPrank();

        // Verify sequence was generated (transfer was initiated)
        assertTrue(sequence >= 0);

        // Get the sent message from chain1's transceiver
        GenericDummyTransceiver chain1Transceiver =
            GenericDummyTransceiver(chain1.gmpManager().getTransceivers()[0]);
        bytes memory sentMessage =
            chain1Transceiver.messages(chain1Transceiver.getMessagesLength() - 1);

        // Verify message was sent with payload
        assertTrue(sentMessage.length > 0);

        // Process the message on chain2 - this should trigger the receiver callback with payload
        vm.prank(relayer);
        GenericDummyTransceiver(chain2.gmpManager().getTransceivers()[0]).receiveMessage(
            sentMessage
        );

        // Verify the receiver stored the correct payload data
        assertEq(receiver.lastReceivedPayload(), swapPayload);
        assertEq(receiver.lastReceivedFrom(), user1);
        assertEq(receiver.lastReceivedSourceChain(), CHAIN_ID);
        assertEq(receiver.lastReceivedSourceAddress(), toWormholeFormat(user1));

        // Verify the payload can be decoded correctly
        (string memory action, uint256 value, address target) =
            abi.decode(receiver.lastReceivedPayload(), (string, uint256, address));
        assertEq(action, "swap");
        assertEq(value, 1000);
        assertEq(target, address(0xABC));
    }

    function testTransferWithPayloadSecurityCheck() public {
        uint256 amount = 100e18;
        bytes memory payload = abi.encode("test", 123);

        // Deploy mock receiver that trusts chain2's MultiTokenNtt
        MockNttTokenReceiver receiver = new MockNttTokenReceiver(address(chain2.ntt()));

        // Deploy and mint test token
        MockERC20 token = new MockERC20("Test Token", "TEST", 18);
        token.mint(user1, amount);

        // Test 1: Authorized caller should succeed
        vm.prank(address(chain2.ntt()));
        receiver.onNttTokenReceived(
            address(token), user1, amount, payload, CHAIN_ID, toWormholeFormat(user1)
        );

        // Test 2: Unauthorized caller should fail
        vm.expectRevert("MockNttTokenReceiver: unauthorized caller");
        vm.prank(user1); // Random user, not the trusted MultiTokenNtt
        receiver.onNttTokenReceived(
            address(token), user1, amount, payload, CHAIN_ID, toWormholeFormat(user1)
        );
    }

    function testTransferWithEmptyPayload() public {
        uint256 amount = 50e18;
        bytes memory emptyPayload = "";

        // Deploy and mint test token
        MockERC20 token = new MockERC20("Test Token", "TEST", 18);
        token.mint(user1, amount);

        // User1 approves and sends the transfer
        vm.startPrank(user1);
        token.approve(address(chain1.ntt()), amount);

        // Send transfer with empty payload (should work fine)
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(user2),
            refundAddress: bytes32(0), // will default to recipient
            shouldQueue: false,
            transceiverInstructions: "",
            additionalPayload: emptyPayload
        });
        uint64 sequence = chain1.ntt().transfer(args);
        vm.stopPrank();

        // Sequence should be valid
        assertTrue(sequence >= 0);
    }

    // ============ Pause Tests ============

    function test_pauseUnpause() public {
        MultiTokenNtt ntt = chain1.ntt();

        // Initial state should not be paused
        assertEq(ntt.isPaused(), false);

        // Owner should be able to pause
        ntt.pause();
        assertEq(ntt.isPaused(), true);

        // Owner should be able to unpause
        ntt.unpause();
        assertEq(ntt.isPaused(), false);
    }

    function test_pauseAccessControl() public {
        MultiTokenNtt ntt = chain1.ntt();
        address pauser = address(0x5555);
        address nonAuthorized = address(0x6666);

        // Set pauser (owner can set pauser)
        ntt.transferPauserCapability(pauser);
        assertEq(ntt.pauser(), pauser);

        // Pauser should be able to pause
        vm.prank(pauser);
        ntt.pause();
        assertEq(ntt.isPaused(), true);

        // Pauser should NOT be able to unpause (only owner can)
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, pauser));
        vm.prank(pauser);
        ntt.unpause();

        // Owner should be able to unpause
        ntt.unpause();
        assertEq(ntt.isPaused(), false);

        // Non-authorized user should NOT be able to pause
        vm.expectRevert(abi.encodeWithSelector(InvalidPauser.selector, nonAuthorized));
        vm.prank(nonAuthorized);
        ntt.pause();

        // Non-authorized user should NOT be able to unpause
        ntt.pause(); // pause first
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, nonAuthorized));
        vm.prank(nonAuthorized);
        ntt.unpause();
    }

    function test_pauseBlocksFunctions() public {
        MultiTokenNtt ntt = chain1.ntt();
        MockERC20 token = new MockERC20("Test Token", "TEST", 18);
        uint256 amount = 100e18;

        // Setup token
        token.mint(user1, amount);
        vm.prank(user1);
        token.approve(address(ntt), amount);

        // Pause the contract
        ntt.pause();

        // transfer() should revert when paused
        vm.startPrank(user1);
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(user2),
            refundAddress: bytes32(0),
            shouldQueue: false,
            transceiverInstructions: "",
            additionalPayload: ""
        });

        vm.expectRevert(abi.encodeWithSelector(RequireContractIsNotPaused.selector));
        ntt.transfer(args);
        vm.stopPrank();

        // wrapAndTransferGasToken() should revert when paused
        vm.deal(user1, 1 ether);
        vm.startPrank(user1);
        MultiTokenNtt.GasTokenTransferArgs memory gasArgs = MultiTokenNtt.GasTokenTransferArgs({
            amount: 0.5 ether,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(user2),
            refundAddress: bytes32(0),
            shouldQueue: false,
            transceiverInstructions: "",
            additionalPayload: ""
        });

        vm.expectRevert(abi.encodeWithSelector(RequireContractIsNotPaused.selector));
        ntt.wrapAndTransferGasToken{value: 0.5 ether}(gasArgs);
        vm.stopPrank();

        // completeOutboundQueuedTransfer() should revert when paused
        vm.expectRevert(abi.encodeWithSelector(RequireContractIsNotPaused.selector));
        ntt.completeOutboundQueuedTransfer(0);

        // cancelOutboundQueuedTransfer() should revert when paused
        vm.expectRevert(abi.encodeWithSelector(RequireContractIsNotPaused.selector));
        vm.prank(user1);
        ntt.cancelOutboundQueuedTransfer(0);

        // completeInboundQueuedTransfer() should revert when paused
        vm.expectRevert(abi.encodeWithSelector(RequireContractIsNotPaused.selector));

        NativeTokenTransferCodec.NativeTokenTransfer memory dummyTransfer;
        ntt.completeInboundQueuedTransfer(dummyTransfer);
    }

    function test_pauseEvents() public {
        MultiTokenNtt ntt = chain1.ntt();

        // Test pause event
        vm.expectEmit(true, false, false, true);
        emit Paused(true);
        ntt.pause();

        // Test unpause event
        vm.expectEmit(true, false, false, true);
        emit NotPaused(false);
        ntt.unpause();
    }

    function test_pauseStateTransitions() public {
        MultiTokenNtt ntt = chain1.ntt();

        // Cannot pause when already paused (_pause has whenNotPaused modifier)
        ntt.pause();
        vm.expectRevert(abi.encodeWithSelector(RequireContractIsNotPaused.selector));
        ntt.pause();

        // Cannot unpause when not paused (_unpause has whenPaused modifier)
        ntt.unpause();
        vm.expectRevert(abi.encodeWithSelector(RequireContractIsPaused.selector));
        ntt.unpause();
    }

    // Events for pause testing (need to be defined for expectEmit)
    event Paused(bool paused);
    event NotPaused(bool notPaused);

    // ============ Override Local Asset Tests ============

    function testOverrideLocalAsset_SameDecimals() public {
        // Deploy a token on chain1 (18 decimals)
        Token originalToken = new Token();
        originalToken.initialize("Original Token", "ORIG", 18);
        uint256 amount = 100 * 10 ** 18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user1);

        originalToken.setMinter(address(this));
        originalToken.mint(sender, amount);

        // Deploy a replacement token on chain2 with SAME decimals (18)
        Token replacementToken = new Token();
        replacementToken.initialize("Replacement Token", "REPL", 18);
        replacementToken.setMinter(address(chain2.ntt())); // Allow MultiTokenNtt to mint/burn

        // Override the local asset on chain2 to use replacementToken instead of creating a wrapped token
        TokenId memory tokenId = TokenId({
            chainId: chain1.chainId(),
            tokenAddress: toWormholeFormat(address(originalToken))
        });

        chain2.ntt().overrideLocalAsset(tokenId, address(replacementToken));

        // Verify the override worked by checking getToken
        address localToken = chain2.ntt().getToken(tokenId);
        assertEq(localToken, address(replacementToken));

        // Test transfer: chain1 -> chain2 (should mint replacement tokens, not wrap)
        vm.startPrank(sender);
        originalToken.approve(address(chain1.ntt()), amount);

        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, recipient, address(originalToken), amount, 0);
        vm.stopPrank();

        // Process the transfer on chain2
        _processMessage(chain2, payload);

        // Verify recipient received replacement tokens (not wrapped tokens)
        assertEq(replacementToken.balanceOf(recipient), amount);
        assertEq(originalToken.balanceOf(address(chain1.ntt())), amount); // Locked on origin chain

        // Test reverse transfer: chain2 -> chain1 (should burn replacement tokens, unlock originals)
        vm.startPrank(recipient);
        replacementToken.approve(address(chain2.ntt()), amount);

        (, bytes memory returnPayload,) =
            _executeTransfer(chain2, chain1, sender, address(replacementToken), amount, 0);
        vm.stopPrank();

        // Process the return transfer on chain1
        _processMessage(chain1, returnPayload);

        // Verify the original tokens were unlocked to sender
        assertEq(originalToken.balanceOf(sender), amount);
        assertEq(originalToken.balanceOf(address(chain1.ntt())), 0); // Unlocked from origin chain
        assertEq(replacementToken.balanceOf(recipient), 0); // Burned on chain2
    }

    function testOverrideLocalAsset_DifferentDecimals() public {
        // Deploy a token on chain1 (6 decimals - like USDC)
        Token originalToken = new Token();
        originalToken.initialize("Original USDC", "USDC", 6);
        uint256 amount = 100 * 10 ** 6; // 100 USDC
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user1);

        originalToken.setMinter(address(this));
        originalToken.mint(sender, amount);

        // Deploy a replacement token on chain2 with DIFFERENT decimals (18)
        Token replacementToken = new Token();
        replacementToken.initialize("Replacement USDC", "rUSDC", 18);
        replacementToken.setMinter(address(chain2.ntt())); // Allow MultiTokenNtt to mint/burn

        // Override the local asset on chain2
        TokenId memory tokenId = TokenId({
            chainId: chain1.chainId(),
            tokenAddress: toWormholeFormat(address(originalToken))
        });

        chain2.ntt().overrideLocalAsset(tokenId, address(replacementToken));

        // Verify the override worked
        assertEq(chain2.ntt().getToken(tokenId), address(replacementToken));

        // Test transfer: chain1 (6 decimals) -> chain2 (18 decimals)
        vm.startPrank(sender);
        originalToken.approve(address(chain1.ntt()), amount);

        (, bytes memory payload,) =
            _executeTransfer(chain1, chain2, recipient, address(originalToken), amount, 0);
        vm.stopPrank();

        // Process the transfer on chain2
        _processMessage(chain2, payload);

        // Verify decimal conversion: 100 USDC (6 decimals) should become 100 rUSDC (18 decimals)
        uint256 expectedAmount18 = amount * 10 ** (18 - 6); // Convert from 6 to 18 decimals
        assertEq(replacementToken.balanceOf(recipient), expectedAmount18);
        assertEq(originalToken.balanceOf(address(chain1.ntt())), amount); // Original locked

        // Test reverse transfer: chain2 (18 decimals) -> chain1 (6 decimals)
        vm.startPrank(recipient);
        replacementToken.approve(address(chain2.ntt()), expectedAmount18);

        (, bytes memory returnPayload,) =
            _executeTransfer(chain2, chain1, sender, address(replacementToken), expectedAmount18, 0);
        vm.stopPrank();

        // Process the return transfer on chain1
        _processMessage(chain1, returnPayload);

        // Verify decimal conversion back: 100 rUSDC (18 decimals) should become 100 USDC (6 decimals)
        assertEq(originalToken.balanceOf(sender), amount);
        assertEq(originalToken.balanceOf(address(chain1.ntt())), 0); // Unlocked
        assertEq(replacementToken.balanceOf(recipient), 0); // Burned

        // Test partial transfer to ensure decimal handling works correctly
        {
            uint256 partialAmount6 = 50 * 10 ** 6; // 50 USDC
            uint256 partialAmount18 = partialAmount6 * 10 ** (18 - 6); // 50 rUSDC in 18 decimals

            // Transfer again: 50 USDC -> 50 rUSDC
            vm.startPrank(sender);
            originalToken.approve(address(chain1.ntt()), partialAmount6);

            (, bytes memory partialPayload,) = _executeTransfer(
                chain1, chain2, recipient, address(originalToken), partialAmount6, 0
            );
            vm.stopPrank();

            _processMessage(chain2, partialPayload);

            assertEq(replacementToken.balanceOf(recipient), partialAmount18);
            assertEq(originalToken.balanceOf(sender), amount - partialAmount6); // 50 USDC remaining
        }
    }

    function testOverrideLocalAsset_OwnerCanOverride() public {
        Token originalToken = new Token();
        originalToken.initialize("Original Token", "ORIG", 18);
        Token replacementToken = new Token();
        replacementToken.initialize("Replacement Token", "REPL", 18);

        TokenId memory tokenId = TokenId({
            chainId: chain1.chainId(),
            tokenAddress: toWormholeFormat(address(originalToken))
        });

        // Owner (this contract) should be able to call it
        chain2.ntt().overrideLocalAsset(tokenId, address(replacementToken));
        assertEq(chain2.ntt().getToken(tokenId), address(replacementToken));
    }

    function testOverrideLocalAsset_OverwriteExisting() public {
        Token originalToken = new Token();
        originalToken.initialize("Original Token", "ORIG", 18);
        Token firstReplacement = new Token();
        firstReplacement.initialize("First Replacement", "REPL1", 18);
        Token secondReplacement = new Token();
        secondReplacement.initialize("Second Replacement", "REPL2", 18);

        TokenId memory tokenId = TokenId({
            chainId: chain1.chainId(),
            tokenAddress: toWormholeFormat(address(originalToken))
        });

        // First override
        chain2.ntt().overrideLocalAsset(tokenId, address(firstReplacement));
        assertEq(chain2.ntt().getToken(tokenId), address(firstReplacement));

        // Override again - should overwrite the first one
        chain2.ntt().overrideLocalAsset(tokenId, address(secondReplacement));
        assertEq(chain2.ntt().getToken(tokenId), address(secondReplacement));
    }

    function testOverrideLocalAsset_CannotOverrideNativeToken() public {
        Token nativeToken = new Token();
        nativeToken.initialize("Native Token", "NATIVE", 18);

        // Try to override a token where chainId matches the current chain
        TokenId memory tokenId = TokenId({
            chainId: chain2.chainId(), // Same as current chain
            tokenAddress: toWormholeFormat(address(nativeToken))
        });

        MultiTokenNtt ntt = chain2.ntt();
        vm.expectRevert("Cannot override native token representation");
        ntt.overrideLocalAsset(tokenId, address(nativeToken));
    }

    // ============ Regular Transfer Queuing Tests ============

    function testRegularTransferQueuing() public {
        // Deploy and setup test token
        Token token = new Token();
        token.initialize("Test Token", "TEST", 18);
        token.setMinter(address(this));

        uint256 amount = 100e18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user2);

        // Mint tokens to the correct sender address
        token.mint(sender, 1000e18);

        // Set a low rate limit to trigger queueing
        TokenId memory tokenId =
            TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(token))});

        chain1.ntt().setOutboundLimit(tokenId, 50e18); // Less than transfer amount

        // Create transfer args with shouldQueue = true
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: chain2.chainId(),
            recipient: toWormholeFormat(recipient),
            refundAddress: toWormholeFormat(sender),
            shouldQueue: true,
            transceiverInstructions: new bytes(1),
            additionalPayload: ""
        });

        // Approve tokens for transfer from the correct sender
        vm.startPrank(sender);
        token.approve(address(chain1.ntt()), amount);

        // Execute transfer - should be queued due to rate limiting
        uint64 queueId = chain1.ntt().transfer(args);
        vm.stopPrank();

        // Verify transfer was queued (positive queueId indicates queuing)
        assertTrue(queueId > 0);

        // Verify tokens were taken from sender
        assertEq(token.balanceOf(sender), 1000e18 - amount);
        assertEq(token.balanceOf(address(chain1.ntt())), amount);

        // Verify the queued transfer exists
        MultiTokenNtt.OutboundQueuedTransfer memory queuedTransfer =
            chain1.ntt().getOutboundQueuedTransfer(queueId);

        assertEq(queuedTransfer.sender, sender);
        assertEq(queuedTransfer.recipientChain, chain2.chainId());
        assertEq(queuedTransfer.recipient, toWormholeFormat(recipient));
        assertEq(queuedTransfer.refundAddress, toWormholeFormat(sender));
        assertTrue(queuedTransfer.txTimestamp > 0);
        assertTrue(queuedTransfer.amount.getAmount() > 0);

        // Fast forward time to allow rate limit to refresh
        vm.warp(block.timestamp + 1 days);

        // Complete the queued transfer
        vm.prank(sender);
        uint64 sequence = chain1.ntt().completeOutboundQueuedTransfer(queueId);

        assertTrue(sequence == queueId);

        // Verify the queued transfer was removed (txTimestamp should be 0)
        MultiTokenNtt.OutboundQueuedTransfer memory removedTransfer =
            chain1.ntt().getOutboundQueuedTransfer(queueId);
        assertEq(removedTransfer.txTimestamp, 0);
    }

    function testRegularTransferQueueingWithoutEnoughCapacity() public {
        // Deploy and setup test token
        Token token = new Token();
        token.initialize("Test Token", "TEST", 18);
        token.setMinter(address(this));

        uint256 amount = 100e18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user2);

        // Mint tokens to the correct sender address
        token.mint(sender, 1000e18);

        // Set a low rate limit to trigger queueing
        TokenId memory tokenId =
            TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(token))});

        chain1.ntt().setOutboundLimit(tokenId, 50e18); // Less than transfer amount

        // Create transfer args with shouldQueue = false (should revert)
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: chain2.chainId(),
            recipient: toWormholeFormat(recipient),
            refundAddress: toWormholeFormat(sender),
            shouldQueue: false, // This should cause revert due to insufficient capacity
            transceiverInstructions: new bytes(1),
            additionalPayload: ""
        });

        // Approve tokens for transfer
        vm.startPrank(sender);
        token.approve(address(chain1.ntt()), amount);

        // Execute transfer - should revert due to insufficient capacity and shouldQueue = false
        MultiTokenNtt ntt1 = chain1.ntt();
        vm.expectRevert(
            abi.encodeWithSelector(
                IMultiTokenRateLimiter.NotEnoughCapacity.selector,
                tokenId,
                50e18, // current capacity
                amount // requested amount
            )
        );
        ntt1.transfer(args);
        vm.stopPrank();
    }

    function testRegularTransferImmediateWhenCapacityAvailable() public {
        // Deploy and setup test token
        Token token = new Token();
        token.initialize("Test Token", "TEST", 18);
        token.setMinter(address(this));

        uint256 amount = 50e18; // Within rate limit
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user2);

        // Mint tokens to the correct sender address
        token.mint(sender, 1000e18);

        // Set rate limit higher than transfer amount
        TokenId memory tokenId =
            TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(token))});

        chain1.ntt().setOutboundLimit(tokenId, 100e18); // More than transfer amount

        // Create transfer args - use OTHER_CHAIN_ID like other tests
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: OTHER_CHAIN_ID,
            recipient: toWormholeFormat(recipient),
            refundAddress: toWormholeFormat(sender),
            shouldQueue: false, // Should not need to queue
            transceiverInstructions: new bytes(1),
            additionalPayload: ""
        });

        // Approve tokens for transfer
        vm.startPrank(sender);
        token.approve(address(chain1.ntt()), amount);

        // Execute transfer - should be immediate (not queued)
        uint64 sequence = chain1.ntt().transfer(args);
        vm.stopPrank();

        // Verify transfer was sent immediately (positive sequence)
        assertTrue(sequence > 0);

        // Verify tokens were taken from sender
        assertEq(token.balanceOf(sender), 1000e18 - amount);
        assertEq(token.balanceOf(address(chain1.ntt())), amount);
    }

    function testCompleteQueuedTransferBeforeTimeWindow() public {
        // Deploy and setup test token
        Token token = new Token();
        token.initialize("Test Token", "TEST", 18);
        token.setMinter(address(this));

        uint256 amount = 100e18;
        address sender = chain1.addr(user1);
        address recipient = chain2.addr(user2);

        // Mint tokens to the correct sender address
        token.mint(sender, 1000e18);

        // Set a low rate limit to trigger queueing
        TokenId memory tokenId =
            TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(token))});

        chain1.ntt().setOutboundLimit(tokenId, 50e18); // Less than transfer amount

        // Create and execute queued transfer
        MultiTokenNtt.TransferArgs memory args = MultiTokenNtt.TransferArgs({
            token: address(token),
            amount: amount,
            recipientChain: chain2.chainId(),
            recipient: toWormholeFormat(recipient),
            refundAddress: toWormholeFormat(sender),
            shouldQueue: true,
            transceiverInstructions: new bytes(1),
            additionalPayload: ""
        });

        vm.startPrank(sender);
        token.approve(address(chain1.ntt()), amount);

        uint64 queueId = chain1.ntt().transfer(args);
        vm.stopPrank();

        MultiTokenNtt ntt1 = chain1.ntt();
        // Try to complete queued transfer immediately (should still fail if rate limit not refreshed)
        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(OutboundQueuedTransferStillQueued.selector, 1, 1));
        ntt1.completeOutboundQueuedTransfer(queueId);
    }

    struct Capacities {
        uint256 chain1Outbound;
        uint256 chain1Inbound;
        uint256 chain2Outbound;
        uint256 chain2Inbound;
    }

    // ============ Backfilling Tests ============

    function testRateLimitBackfilling() public {
        // Deploy and setup test token on both chains
        Token token = new Token();
        token.initialize("Test Token", "TEST", 18);
        token.setMinter(address(this));

        uint256 transferAmount = 50e18;
        uint256 rateLimitCapacity = 100e18;

        // Mint tokens on chain1
        token.mint(chain1.addr(user1), 1000e18);

        // Create wrapped token on chain2 by doing an initial transfer
        vm.startPrank(chain1.addr(user1));
        token.approve(address(chain1.ntt()), transferAmount);
        (, bytes memory initialPayload,) =
            _executeTransfer(chain1, chain2, chain2.addr(user1), address(token), transferAmount, 0);
        vm.stopPrank();
        _processMessage(chain2, initialPayload);

        // Get the wrapped token on chain2
        Token chain2Token = _getWrappedToken(chain2, address(token), chain1.chainId());

        // Set up rate limits for the token on both chains
        TokenId memory chain1TokenId =
            TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(token))});
        TokenId memory chain2TokenId =
            TokenId({chainId: chain1.chainId(), tokenAddress: toWormholeFormat(address(token))});

        // Set outbound and inbound limits
        chain1.ntt().setOutboundLimit(chain1TokenId, rateLimitCapacity);
        chain1.ntt().setInboundLimit(chain1TokenId, rateLimitCapacity, chain2.chainId());

        chain2.ntt().setOutboundLimit(chain2TokenId, rateLimitCapacity);
        chain2.ntt().setInboundLimit(chain2TokenId, rateLimitCapacity, chain1.chainId());

        // Test 1: Check initial capacities
        Capacities memory initialCapacities = Capacities({
            chain1Outbound: chain1.ntt().getCurrentOutboundCapacity(chain1TokenId),
            chain1Inbound: chain1.ntt().getCurrentInboundCapacity(chain1TokenId, chain2.chainId()),
            chain2Outbound: chain2.ntt().getCurrentOutboundCapacity(chain2TokenId),
            chain2Inbound: chain2.ntt().getCurrentInboundCapacity(chain2TokenId, chain1.chainId())
        });

        // Rate limits start at full capacity when first set
        assertEq(initialCapacities.chain1Outbound, rateLimitCapacity); // Fresh limit, no consumption yet
        assertEq(initialCapacities.chain1Inbound, rateLimitCapacity); // Fresh limit, no consumption yet
        assertEq(initialCapacities.chain2Outbound, rateLimitCapacity); // Fresh limit, no consumption yet
        assertEq(initialCapacities.chain2Inbound, rateLimitCapacity); // Fresh limit, no consumption yet

        // Test 2: Do an inbound transfer to chain1 (chain2 -> chain1)
        // This should decrease chain2's outbound capacity and increase chain1's inbound capacity
        vm.startPrank(chain2.addr(user1));
        chain2Token.approve(address(chain2.ntt()), transferAmount);
        (, bytes memory returnPayload,) = _executeTransfer(
            chain2, chain1, chain1.addr(user2), address(chain2Token), transferAmount, 0
        );
        vm.stopPrank();
        _processMessage(chain1, returnPayload);

        // Test 3: Check capacities after inbound transfer
        Capacities memory afterInboundCapacities = Capacities({
            chain1Outbound: chain1.ntt().getCurrentOutboundCapacity(chain1TokenId),
            chain1Inbound: chain1.ntt().getCurrentInboundCapacity(chain1TokenId, chain2.chainId()),
            chain2Outbound: chain2.ntt().getCurrentOutboundCapacity(chain2TokenId),
            chain2Inbound: chain2.ntt().getCurrentInboundCapacity(chain2TokenId, chain1.chainId())
        });

        uint256 _transferAmount = transferAmount;

        // Chain1's outbound capacity should stay max (no backfilling past limit)
        assertEq(afterInboundCapacities.chain1Outbound, initialCapacities.chain1Outbound);

        // Chain1's inbound capacity should have decreased (consumed by receiving)
        assertEq(
            afterInboundCapacities.chain1Inbound, initialCapacities.chain1Inbound - _transferAmount
        );
        // Chain2's outbound capacity should have decreased (consumed by sending)
        assertEq(
            afterInboundCapacities.chain2Outbound,
            initialCapacities.chain2Outbound - _transferAmount
        );
        // Chain2's inbound capacity should stay (no backfilling)
        assertEq(afterInboundCapacities.chain2Inbound, initialCapacities.chain2Inbound);

        // Test 4: Do an outbound transfer from chain1 (chain1 -> chain2)
        // This should decrease chain1's outbound capacity and increase chain2's inbound capacity
        token.mint(chain1.addr(user2), 1000e18); // Mint some tokens for the recipient to send back
        vm.startPrank(chain1.addr(user2));
        token.approve(address(chain1.ntt()), transferAmount);
        (, bytes memory outboundPayload,) =
            _executeTransfer(chain1, chain2, chain2.addr(user2), address(token), transferAmount, 0);
        vm.stopPrank();
        _processMessage(chain2, outboundPayload);

        // Test 5: Check final capacities
        Capacities memory finalCapacities = Capacities({
            chain1Outbound: chain1.ntt().getCurrentOutboundCapacity(chain1TokenId),
            chain1Inbound: chain1.ntt().getCurrentInboundCapacity(chain1TokenId, chain2.chainId()),
            chain2Outbound: chain2.ntt().getCurrentOutboundCapacity(chain2TokenId),
            chain2Inbound: chain2.ntt().getCurrentInboundCapacity(chain2TokenId, chain1.chainId())
        });

        // Chain1's outbound capacity should have decreased (consumed by sending)
        assertEq(
            finalCapacities.chain1Outbound, afterInboundCapacities.chain1Outbound - transferAmount
        );
        // Chain1's inbound capacity should have increased (backfilled from sending)
        assertEq(
            finalCapacities.chain1Inbound, afterInboundCapacities.chain1Inbound + transferAmount
        );
        // Chain2's outbound capacity should have increased (backfilled from receiving)
        assertEq(
            finalCapacities.chain2Outbound, afterInboundCapacities.chain2Outbound + transferAmount
        );
        // Chain2's inbound capacity should have decreased (consumed by receiving)
        assertEq(
            finalCapacities.chain2Inbound, afterInboundCapacities.chain2Inbound - transferAmount
        );
    }

    function test_removeTransceiverPreventsMessageDelivery() public {
        MockERC20 token = new MockERC20("Test Token", "TEST", 18);

        uint16[] memory chains = chain1.gmpManager().getKnownChains();
        assertTrue(chains.length > 0);

        // get transceivers and remove them to test the removal functionality
        address[] memory transceivers =
            chain1.gmpManager().getSendTransceiversForChain(OTHER_CHAIN_ID);
        assertTrue(transceivers.length > 0);

        // add dummy transceiver so we can remove the existing one without breaking threshold
        GenericDummyTransceiver dummy = new GenericDummyTransceiver(address(chain1.gmpManager()));
        chain1.gmpManager().setTransceiver(address(dummy));

        // remove the original transceiver from all chains
        chain1.gmpManager().removeTransceiver(transceivers[0]);

        // verify that after removal, there are no transceivers for this specific chain
        bool noTransceiversForChain = false;
        try chain1.gmpManager().getSendTransceiversForChain(OTHER_CHAIN_ID) returns (
            address[] memory
        ) {
            noTransceiversForChain = false;
        } catch (bytes memory) {
            noTransceiversForChain = true;
        }
        assertTrue(
            noTransceiversForChain, "Expected no transceivers configured for chain after removal"
        );

        // Now try to send a message - this should fail because no transceivers are configured
        address user = address(0x123);
        token.mint(user, 100e18);
        vm.startPrank(user);
        token.approve(address(chain1.ntt()), 100e18);

        MultiTokenNtt ntt1 = chain1.ntt();
        // This should revert because no send transceivers are configured for this chain after removal
        vm.expectRevert(
            abi.encodeWithSelector(
                TransceiverRegistry.NoTransceiversConfiguredForChain.selector, OTHER_CHAIN_ID
            )
        );
        ntt1.transfer(
            MultiTokenNtt.TransferArgs({
                token: address(token),
                amount: 100e18,
                recipientChain: OTHER_CHAIN_ID,
                recipient: toWormholeFormat(address(0x123)),
                refundAddress: toWormholeFormat(address(0x123)),
                shouldQueue: false,
                transceiverInstructions: new bytes(1),
                additionalPayload: ""
            })
        );
        vm.stopPrank();

        // Verify that after reconfiguring dummy transceiver, messages work again
        chain1.gmpManager().setSendTransceiverForChain(OTHER_CHAIN_ID, address(dummy));
        chain1.gmpManager().setReceiveTransceiverForChain(OTHER_CHAIN_ID, address(dummy));

        vm.startPrank(user);
        uint64 seq = chain1.ntt().transfer(
            MultiTokenNtt.TransferArgs({
                token: address(token),
                amount: 100e18,
                recipientChain: OTHER_CHAIN_ID,
                recipient: toWormholeFormat(address(0x123)),
                refundAddress: toWormholeFormat(address(0x123)),
                shouldQueue: false,
                transceiverInstructions: new bytes(1),
                additionalPayload: ""
            })
        );
        vm.stopPrank();
        assertTrue(seq > 0);
    }
}
