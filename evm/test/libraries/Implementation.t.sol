// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";
import "../../src/libraries/Implementation.sol";

contract TestImplementation is Implementation {
    uint256 public upgradeCount;

    function _initialize() internal override {
        super._initialize();
        upgradeCount = 0;
    }

    function _migrate() internal override {}

    function _checkImmutables() internal view override {
        super._checkImmutables();
    }

    function upgrade(
        address newImplementation
    ) external {
        _upgrade(newImplementation);
    }

    function otherInitializer() external initializer {
        // this one is not protected by the 'onlyDelegateCall' modifier, it
        // should still fail as a direct call
    }

    function incrementCounter() public onlyInitializing {
        // this should fail if called outside of initialization (including migration)
        upgradeCount++;
    }
}

contract TestImplementation2 is Implementation {
    uint256 public upgradeCount;

    function _initialize() internal override {
        super._initialize();
    }

    function _migrate() internal override {
        incrementCounter();
    }

    function _checkImmutables() internal view override {
        super._checkImmutables();
    }

    function upgrade(
        address newImplementation
    ) external {
        _upgrade(newImplementation);
    }

    function otherInitializer() external initializer {
        // this one is not protected by the 'onlyDelegateCall' modifier, it
        // should still fail as a direct call
    }

    function incrementCounter() public onlyInitializing {
        // this should fail if called outside of initialization (including migration)
        upgradeCount++;
    }
}

contract ImplementationTest is Test {
    function test_cantInitializeDirectly() public {
        TestImplementation impl = new TestImplementation();

        vm.expectRevert(abi.encodeWithSignature("OnlyDelegateCall()"));
        impl.initialize();
    }

    function test_cantInitializeDirectly2() public {
        TestImplementation impl = new TestImplementation();

        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        impl.otherInitializer();
    }

    function test_initializeProxy() public {
        TestImplementation impl = new TestImplementation();
        TestImplementation proxy = TestImplementation(address(new ERC1967Proxy(address(impl), "")));

        proxy.initialize();
    }

    function test_cantUpgradeDirectly() public {
        TestImplementation impl = new TestImplementation();

        vm.expectRevert(abi.encodeWithSignature("OnlyDelegateCall()"));
        impl.upgrade(address(0xdeadbeef));
    }

    function test_cantIncrementCounterDirectly() public {
        TestImplementation impl = new TestImplementation();
        TestImplementation proxy = TestImplementation(address(new ERC1967Proxy(address(impl), "")));

        vm.expectRevert(abi.encodeWithSignature("NotInitializing()"));
        proxy.incrementCounter();
    }

    function test_upgradeProxy() public {
        TestImplementation impl = new TestImplementation();
        TestImplementation proxy = TestImplementation(address(new ERC1967Proxy(address(impl), "")));
        TestImplementation2 impl2 = new TestImplementation2();

        proxy.initialize();
        proxy.upgrade(address(impl2));

        assertEq(proxy.upgradeCount(), 1);

        proxy.upgrade(address(impl2));
        assertEq(proxy.upgradeCount(), 2);
    }

    function test_cantMigrateExternally() public {
        TestImplementation impl = new TestImplementation();
        TestImplementation proxy = TestImplementation(address(new ERC1967Proxy(address(impl), "")));

        vm.expectRevert(abi.encodeWithSignature("NotMigrating()"));
        proxy.migrate();
    }
}
