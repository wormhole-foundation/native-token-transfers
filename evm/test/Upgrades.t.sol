// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManager.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/IRateLimiter.sol";
import "../src/interfaces/IRateLimiterEvents.sol";
import "../src/libraries/external/OwnableUpgradeable.sol";
import "../src/libraries/external/Initializable.sol";
import "../src/libraries/Implementation.sol";
import {Utils} from "./libraries/Utils.sol";
import {DummyToken, DummyTokenMintAndBurn} from "./NttManager.t.sol";
import {WormholeTransceiver} from "../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import "../src/libraries/TransceiverStructs.sol";
import "./mocks/MockNttManager.sol";
import "./mocks/MockTransceivers.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";

contract TestUpgrades is Test, IRateLimiterEvents {
    NttManager nttManagerChain1;
    NttManager nttManagerChain2;

    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    uint16 constant chainId1 = 7;
    uint16 constant chainId2 = 100;

    uint16 constant SENDING_CHAIN_ID = 1;
    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;
    WormholeSimulator guardian;
    uint256 initialBlockTimestamp;
    uint8 constant FAST_CONSISTENCY_LEVEL = 200;
    uint256 constant GAS_LIMIT = 500000;

    WormholeTransceiver wormholeTransceiverChain1;
    WormholeTransceiver wormholeTransceiverChain2;
    address userA = address(0x123);
    address userB = address(0x456);
    address userC = address(0x789);
    address userD = address(0xABC);

    address relayer = address(0x28D8F1Be96f97C1387e94A53e00eCcFb4E75175a);
    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);

    function setUp() public virtual {
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
            chainId2,
            bytes32(uint256(uint160(address(nttManagerChain2)))),
            DummyToken(nttManagerChain2.token()).decimals(),
            type(uint64).max
        );
        nttManagerChain2.setPeer(
            chainId1,
            bytes32(uint256(uint160(address(nttManagerChain1)))),
            DummyToken(nttManagerChain1.token()).decimals(),
            type(uint64).max
        );

        wormholeTransceiverChain1.setWormholePeer(
            chainId2, bytes32(uint256(uint160((address(wormholeTransceiverChain2)))))
        );
        wormholeTransceiverChain2.setWormholePeer(
            chainId1, bytes32(uint256(uint160(address(wormholeTransceiverChain1))))
        );

        nttManagerChain1.setThreshold(1);
        nttManagerChain2.setThreshold(1);
        vm.chainId(chainId1);
    }

    function test_basicUpgradeNttManager() public {
        // Basic call to upgrade with the same contact as ewll
        NttManager newImplementation = new MockNttManagerContract(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );
        nttManagerChain1.upgrade(address(newImplementation));

        basicFunctionality();
    }

    //Upgradability stuff for transceivers is real borked because of some missing implementation. Test this later once fixed.
    function test_basicUpgradeTransceiver() public {
        // Basic call to upgrade with the same contact as well
        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));

        basicFunctionality();
    }

    // Confirm that we can handle multiple upgrades as a nttManager
    function test_doubleUpgradeNttManager() public {
        // Basic call to upgrade with the same contact as ewll
        NttManager newImplementation = new MockNttManagerContract(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );
        nttManagerChain1.upgrade(address(newImplementation));
        basicFunctionality();

        newImplementation = new MockNttManagerContract(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );
        nttManagerChain1.upgrade(address(newImplementation));

        basicFunctionality();
    }

    // NOTE: There are additional tests in `Upgrades.t.sol` to verifying downgrading from `NttManagerNoRateLimiting` to `NttManager`.

    function test_cannotUpgradeToNoRateLimitingIfItWasEnabled() public {
        // The default set up has rate limiting enabled. When we attempt to upgrade to no rate limiting, the immutable check should panic.
        NttManager rateLimitingImplementation = new MockNttManagerNoRateLimitingContract(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1
        );

        vm.expectRevert(); // Reverts with a panic on the assert. So, no way to tell WHY this happened.
        nttManagerChain1.upgrade(address(rateLimitingImplementation));
    }

    function test_upgradeToNoRateLimiting() public {
        // Create a standard manager with rate limiting disabled.
        DummyToken t = new DummyToken();
        NttManager implementation =
            new MockNttManagerContract(address(t), IManagerBase.Mode.LOCKING, chainId1, 0, true);

        MockNttManagerContract thisNttManager =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        thisNttManager.initialize();

        thisNttManager.setPeer(chainId2, toWormholeFormat(address(0x1)), 9, type(uint64).max);

        // Upgrade from NttManager with rate limiting disabled to NttManagerNoRateLimiting.
        NttManager rateLimitingImplementation = new MockNttManagerNoRateLimitingContract(
            address(t), IManagerBase.Mode.LOCKING, chainId1
        );
        thisNttManager.upgrade(address(rateLimitingImplementation));
        basicFunctionality();

        // Upgrade from NttManagerNoRateLimiting to NttManagerNoRateLimiting.
        rateLimitingImplementation = new MockNttManagerNoRateLimitingContract(
            address(t), IManagerBase.Mode.LOCKING, chainId1
        );
        thisNttManager.upgrade(address(rateLimitingImplementation));
        basicFunctionality();

        // Upgrade from NttManagerNoRateLimiting back to NttManager.
        NttManager nttManagerImplementation =
            new MockNttManagerContract(address(t), IManagerBase.Mode.LOCKING, chainId1, 0, true);
        thisNttManager.upgrade(address(nttManagerImplementation));
        basicFunctionality();
    }

    //Upgradability stuff for transceivers is real borked because of some missing implementation. Test this later once fixed.
    function test_doubleUpgradeTransceiver() public {
        // Basic call to upgrade with the same contact as well
        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));

        basicFunctionality();

        // Basic call to upgrade with the same contact as well
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));

        basicFunctionality();
    }

    function test_storageSlotNttManager() public {
        // Basic call to upgrade with the same contact as ewll
        NttManager newImplementation = new MockNttManagerStorageLayoutChange(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );
        nttManagerChain1.upgrade(address(newImplementation));

        address oldOwner = nttManagerChain1.owner();
        MockNttManagerStorageLayoutChange(address(nttManagerChain1)).setData();

        // If we overrode something important, it would probably break here
        basicFunctionality();

        require(oldOwner == nttManagerChain1.owner(), "Owner changed in an unintended way.");
    }

    function test_storageSlotTransceiver() public {
        // Basic call to upgrade with the same contact as ewll
        WormholeTransceiver newImplementation = new MockWormholeTransceiverLayoutChange(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain1.upgrade(address(newImplementation));

        address oldOwner = nttManagerChain1.owner();
        MockWormholeTransceiverLayoutChange(address(wormholeTransceiverChain1)).setData();

        // If we overrode something important, it would probably break here
        basicFunctionality();

        require(oldOwner == nttManagerChain1.owner(), "Owner changed in an unintended way.");
    }

    function test_callMigrateNttManager() public {
        // Basic call to upgrade with the same contact as ewll
        NttManager newImplementation = new MockNttManagerMigrateBasic(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        vm.expectRevert("Proper migrate called");
        nttManagerChain1.upgrade(address(newImplementation));

        basicFunctionality();
    }

    //Upgradability stuff for transceivers is real borked because of some missing implementation. Test this later once fixed.
    function test_callMigrateTransceiver() public {
        // Basic call to upgrade with the same contact as well
        MockWormholeTransceiverMigrateBasic wormholeTransceiverChain1Implementation = new MockWormholeTransceiverMigrateBasic(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );

        vm.expectRevert("Proper migrate called");
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));

        basicFunctionality();
    }

    function test_immutableBlockUpdateFailureNttManager() public {
        DummyToken tnew = new DummyToken();

        // Basic call to upgrade with the same contact as ewll
        NttManager newImplementation = new MockNttManagerImmutableCheck(
            address(tnew), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        vm.expectRevert(); // Reverts with a panic on the assert. So, no way to tell WHY this happened.
        nttManagerChain1.upgrade(address(newImplementation));

        require(nttManagerChain1.token() != address(tnew), "Token updated when it shouldn't be");

        basicFunctionality();
    }

    function test_immutableBlockUpdateFailureTransceiver() public {
        // Don't allow upgrade to work with a change immutable

        address oldNttManager = wormholeTransceiverChain1.nttManager();
        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverMigrateBasic(
            address(nttManagerChain2),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );

        vm.expectRevert(); // Reverts with a panic on the assert. So, no way to tell WHY this happened.
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));

        require(
            wormholeTransceiverChain1.nttManager() == oldNttManager,
            "NttManager updated when it shouldn't be"
        );
    }

    function test_immutableBlockUpdateSuccessNttManager() public {
        DummyToken tnew = new DummyToken();

        // Basic call to upgrade with the same contact as ewll
        NttManager newImplementation = new MockNttManagerImmutableRemoveCheck(
            address(tnew), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        // Allow an upgrade, since we enabled the ability to edit the immutables within the code
        nttManagerChain1.upgrade(address(newImplementation));
        require(nttManagerChain1.token() == address(tnew), "Token not updated");

        basicFunctionality();
    }

    function test_immutableBlockUpdateSuccessTransceiver() public {
        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverImmutableAllow(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );

        //vm.expectRevert(); // Reverts with a panic on the assert. So, no way to tell WHY this happened.
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));

        require(
            wormholeTransceiverChain1.nttManager() == address(nttManagerChain1),
            "NttManager updated when it shouldn't be"
        );
    }

    function test_specialRelayerMigration() public {
        WormholeTransceiver newImplementation = new MockWormholeTransceiverImmutableAllow(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x8C56eE9cd232d23541a697C0eBd3cA597DE3c88D), // new specialRelayer address
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );

        // Perform upgrade which will trigger migration
        wormholeTransceiverChain1.upgrade(address(newImplementation));

        // Verify specialRelayer was set to the expected address
        require(
            address(wormholeTransceiverChain1.specialRelayer()) == 0x8C56eE9cd232d23541a697C0eBd3cA597DE3c88D,
            "SpecialRelayer not set to expected address"
        );
    }


    function test_authNttManager() public {
        // User not owner so this should fail
        vm.prank(userA);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, userA)
        );
        nttManagerChain1.upgrade(address(0x1));

        // Basic call to upgrade so that we can get the real implementation.
        NttManager newImplementation = new MockNttManagerContract(
            address(nttManagerChain1.token()), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );
        nttManagerChain1.upgrade(address(newImplementation));

        basicFunctionality(); // Ensure that the upgrade was proper

        vm.expectRevert(abi.encodeWithSelector(Implementation.NotMigrating.selector));
        nttManagerChain1.migrate();

        // Test if we can 'migrate' from this point
        // Migrate without delegatecall
        vm.expectRevert(abi.encodeWithSelector(Implementation.OnlyDelegateCall.selector));
        newImplementation.migrate();

        // Transfer the ownership - shouldn't have permission for that
        vm.prank(userA);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, userA)
        );
        nttManagerChain1.transferOwnership(address(0x1));

        // Should fail because it's already initialized
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nttManagerChain1.initialize();

        // Should fail because we're calling the implementation directly instead of the proxy.
        vm.expectRevert(Implementation.OnlyDelegateCall.selector);
        newImplementation.initialize();
    }

    function test_authTransceiver() public {
        // User not owner so this should fail
        vm.prank(userA);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, userA)
        );
        wormholeTransceiverChain1.upgrade(address(0x01));

        // Basic call so that we can easily see what the new transceiver is.
        WormholeTransceiver wormholeTransceiverChain1Implementation = new MockWormholeTransceiverContract(
            address(nttManagerChain1),
            address(wormhole),
            address(relayer),
            address(0x0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain1.upgrade(address(wormholeTransceiverChain1Implementation));
        basicFunctionality(); // Ensure that the upgrade was proper

        // Test if we can 'migrate' from this point
        // Migrate without delegatecall
        vm.expectRevert(abi.encodeWithSelector(Implementation.OnlyDelegateCall.selector));
        wormholeTransceiverChain1Implementation.migrate();

        // Migrate - should fail since we're executing something outside of a migration
        vm.expectRevert(abi.encodeWithSelector(Implementation.NotMigrating.selector));
        wormholeTransceiverChain1.migrate();

        // Transfer the ownership - shouldn't have permission for that
        vm.prank(userA);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, userA)
        );
        wormholeTransceiverChain1.transferOwnership(address(0x1));

        // Should fail because it's already initialized
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        wormholeTransceiverChain1.initialize();

        // // Should fail because we're calling the implementation directly instead of the proxy.
        vm.expectRevert(Implementation.OnlyDelegateCall.selector);
        wormholeTransceiverChain1Implementation.initialize();
    }

    function test_nonZeroWormholeFee() public {
        // Set the message fee to be non-zero
        vm.chainId(11155111); // Sepolia testnet id
        uint256 fee = 0.000001e18;
        guardian.setMessageFee(fee);
        uint256 balanceBefore = address(userA).balance;
        basicFunctionality();
        uint256 balanceAfter = address(userA).balance;
        assertEq(balanceAfter + fee, balanceBefore);
    }

    function basicFunctionality() public {
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

        // Fetch quote
        (, uint256 totalQuote) =
            nttManagerChain1.quoteDeliveryPrice(chainId2, encodeTransceiverInstruction(true));

        // Send token through standard means (not relayer)
        {
            uint256 nttManagerBalanceBefore = token1.balanceOf(address(nttManagerChain1));
            uint256 userBalanceBefore = token1.balanceOf(address(userA));
            nttManagerChain1.transfer{value: totalQuote}(
                sendingAmount,
                chainId2,
                toWormholeFormat(userB),
                toWormholeFormat(userA),
                false,
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

        // Fetch quote
        (, totalQuote) =
            nttManagerChain2.quoteDeliveryPrice(chainId1, encodeTransceiverInstruction(true));

        // Supply checks on the transfer
        {
            uint256 supplyBefore = token2.totalSupply();
            nttManagerChain2.transfer{value: totalQuote}(
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
            uint256 userDBalanceBefore = token1.balanceOf(userD);
            wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);

            uint256 supplyAfter = token1.totalSupply();

            require(supplyBefore == supplyAfter, "Supplies don't match between operations");
            require(token1.balanceOf(userB) == 0, "OG user receive tokens");
            require(token1.balanceOf(userC) == 0, "Sending user didn't receive tokens");
            require(
                token1.balanceOf(userD) == sendingAmount + userDBalanceBefore, "User received funds"
            );
        }

        vm.stopPrank();
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

contract TestInitialize is Test {
    function setUp() public {}

    NttManager nttManagerChain1;
    NttManager nttManagerChain2;

    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    uint16 constant chainId1 = 7;

    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;

    WormholeTransceiver wormholeTransceiverChain1;
    address userA = address(0x123);

    address relayer = address(0x28D8F1Be96f97C1387e94A53e00eCcFb4E75175a);
    IWormhole wormhole = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);

    function test_doubleInitialize() public {
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        vm.createSelectFork(url);

        vm.chainId(chainId1);
        DummyToken t1 = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(t1), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        nttManagerChain1 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));

        // Initialize once
        nttManagerChain1.initialize();

        // Initialize twice
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nttManagerChain1.initialize();
    }

    function test_cannotFrontrunInitialize() public {
        string memory url = "https://ethereum-sepolia-rpc.publicnode.com";
        vm.createSelectFork(url);

        vm.chainId(chainId1);
        DummyToken t1 = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(t1), IManagerBase.Mode.LOCKING, chainId1, 1 days, false
        );

        nttManagerChain1 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));

        // Attempt to initialize the contract from a non-deployer account.
        vm.prank(userA);
        vm.expectRevert(
            abi.encodeWithSelector(INttManager.UnexpectedDeployer.selector, address(this), userA)
        );
        nttManagerChain1.initialize();
    }
}
