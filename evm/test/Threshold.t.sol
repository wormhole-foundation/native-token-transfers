// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../src/NttManager/NttManager.sol";
import "../src/interfaces/INttManager.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/libraries/external/OwnableUpgradeable.sol";

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./mocks/DummyTransceiver.sol";
import "../src/mocks/DummyToken.sol";
import "./mocks/MockNttManager.sol";
import "./mocks/MockEndpoint.sol";
import "./mocks/MockExecutor.sol";

contract TestThreshold is Test {
    MockNttManagerContract nttManager;
    MockEndpoint endpoint;
    MockExecutor executor;

    uint16 constant chainId = 7;
    uint16 constant chainId2 = 8;
    uint16 constant chainId3 = 9;

    function setUp() public {
        endpoint = new MockEndpoint(chainId);
        endpoint = new MockEndpoint(chainId);

        DummyToken t = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(endpoint),
            address(executor),
            address(t),
            IManagerBase.Mode.LOCKING,
            chainId,
            1 days,
            false
        );

        nttManager = MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        nttManager.initialize();
    }

    function test_setUp() public {}

    function test_canSetThreshold() public {
        DummyTransceiver e1 = new DummyTransceiver(chainId, address(endpoint));
        DummyTransceiver e2 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e1));
        nttManager.setTransceiver(address(e2));

        nttManager.enableRecvTransceiver(chainId2, address(e1));
        nttManager.enableRecvTransceiver(chainId2, address(e2));

        nttManager.setThreshold(chainId2, 1);
        nttManager.setThreshold(chainId2, 2);
        nttManager.setThreshold(chainId2, 1);
    }

    function test_cantSetThresholdToZero() public {
        DummyTransceiver e = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e));
        nttManager.enableRecvTransceiver(chainId2, address(e));
        vm.expectRevert(abi.encodeWithSelector(IManagerBase.ZeroThreshold.selector));
        nttManager.setThreshold(chainId2, 0);
    }

    function test_cantSetThresholdTooHigh() public {
        // With one transceiver, can't set the threshold to two.
        DummyTransceiver e1 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e1));
        nttManager.enableRecvTransceiver(chainId2, address(e1));
        vm.expectRevert(abi.encodeWithSelector(IManagerBase.ThresholdTooHigh.selector, 2, 1));
        nttManager.setThreshold(chainId2, 2);
    }

    function test_onlyOwnerCanSetThreshold() public {
        address notOwner = address(0x123);
        vm.startPrank(notOwner);

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, notOwner)
        );
        nttManager.setThreshold(chainId2, 1);
    }

    function test_thresholdGetsSetOnFirstEnable() public {
        // The threshold starts at zero.
        assertEq(0, nttManager.getThreshold(chainId2));

        // When we enable the first transceiver, it should go to one.
        DummyTransceiver e1 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e1));
        nttManager.enableRecvTransceiver(chainId2, address(e1));
        assertEq(1, nttManager.getThreshold(chainId2));

        // But it should not increase when we enable more.
        DummyTransceiver e2 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e2));
        nttManager.enableRecvTransceiver(chainId2, address(e2));
        assertEq(1, nttManager.getThreshold(chainId2));
    }

    function test_thresholdReducesOnDisable() public {
        //Create and enable a few transceivers on a couple of chains.
        DummyTransceiver e1 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e1));
        nttManager.enableRecvTransceiver(chainId2, address(e1));

        DummyTransceiver e2 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e2));
        nttManager.enableRecvTransceiver(chainId2, address(e2));

        DummyTransceiver e3 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e3));
        nttManager.enableRecvTransceiver(chainId2, address(e3));

        DummyTransceiver e4 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e4));
        nttManager.enableRecvTransceiver(chainId3, address(e4));

        DummyTransceiver e5 = new DummyTransceiver(chainId, address(endpoint));
        nttManager.setTransceiver(address(e5));
        nttManager.enableRecvTransceiver(chainId3, address(e5));

        // The thresholds should have been set to one automatically.
        assertEq(1, nttManager.getThreshold(chainId2));
        assertEq(1, nttManager.getThreshold(chainId3));

        // Bump the thresholds up.
        nttManager.setThreshold(chainId2, 3);
        nttManager.setThreshold(chainId3, 2);
        assertEq(3, nttManager.getThreshold(chainId2));
        assertEq(2, nttManager.getThreshold(chainId3));

        // Disabling should reduce the threshold if necessary.
        nttManager.disableRecvTransceiver(chainId2, address(e3));
        assertEq(2, nttManager.getThreshold(chainId2));
        assertEq(2, nttManager.getThreshold(chainId3));

        // But disabling should not reduce the threshold if it's not necessary.
        nttManager.setThreshold(chainId2, 1);
        assertEq(1, nttManager.getThreshold(chainId2));
        nttManager.disableRecvTransceiver(chainId2, address(e2));
        assertEq(1, nttManager.getThreshold(chainId2));
        assertEq(2, nttManager.getThreshold(chainId3));

        // Threshold should go to zero when we disable the last one.
        nttManager.disableRecvTransceiver(chainId2, address(e1));
        assertEq(0, nttManager.getThreshold(chainId2));
        assertEq(2, nttManager.getThreshold(chainId3));
    }
}
