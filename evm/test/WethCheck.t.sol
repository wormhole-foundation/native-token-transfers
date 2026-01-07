// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import {DummyToken} from "./NttManager.t.sol";

contract FallbackOnly {
    fallback() external payable {}
}

// from https://etherscan.io/token/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2#code
contract WETH9 {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // function() public payable {
    fallback() external payable {
        deposit();
    }

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(
        uint256 wad
    ) public {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        // msg.sender.transfer(wad);
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() public view returns (uint256) {
        // return this.balance;
        return address(this).balance;
    }

    function approve(
        address guy,
        uint256 wad
    ) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(
        address dst,
        uint256 wad
    ) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(
        address src,
        address dst,
        uint256 wad
    ) public returns (bool) {
        require(balanceOf[src] >= wad);

        // if (src != msg.sender && allowance[src][msg.sender] != uint256(-1)) {
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad);
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);

        return true;
    }
}

contract WethCheck is Test {
    FallbackOnly f;
    WETH9 w;
    DummyToken t;

    function setUp() public {
        f = new FallbackOnly();
        w = new WETH9();
        t = new DummyToken();
    }

    function checkWeth(
        address c
    ) public returns (bool isWeth) {
        // check if the token is WETH9 deposit and withdraw compatible
        (bool depositSuccess,) = c.call(abi.encodeWithSignature("deposit()"));
        (bool withdrawSuccess,) = c.call(abi.encodeWithSignature("withdraw(uint)", 0));
        isWeth = depositSuccess && withdrawSuccess;
    }

    function testWethCheckIsWrong() public {
        require(checkWeth(address(w)) == true, "expected WETH is WETH");
        require(checkWeth(address(t)) == false, "expected DummyToken is not WETH");
        // this check identifies the issue with using the above check - any contract with a fallback
        // will be incorrectly determined to be WETH
        require(checkWeth(address(f)) == true, "expected FallbackOnly is INCORRECTLY WETH");
    }
}
