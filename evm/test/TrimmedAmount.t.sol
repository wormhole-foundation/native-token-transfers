// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Test, stdError} from "forge-std/Test.sol";
import "../src/libraries/TrimmedAmount.sol";
import "forge-std/console.sol";

contract TrimmingTest is Test {
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    function testTrimmingRoundTrip() public {
        uint8 decimals = 18;
        uint256 amount = 50 * 10 ** decimals;
        TrimmedAmount trimmed = amount.trim(decimals, 8);
        uint256 roundTrip = trimmed.untrim(decimals);

        uint256 expectedAmount = 50 * 10 ** decimals;
        assertEq(expectedAmount, roundTrip);
    }

    function testTrimLessThan8() public {
        uint8 decimals = 7;
        uint8 targetDecimals = 3;
        uint256 amount = 9123412342342;
        TrimmedAmount trimmed = amount.trim(decimals, targetDecimals);

        uint64 expectedAmount = 912341234;
        uint8 expectedDecimals = targetDecimals;
        assertEq(trimmed.getAmount(), expectedAmount);
        assertEq(trimmed.getDecimals(), expectedDecimals);
    }

    function testAddOperatorNonZero() public pure {
        uint8[2] memory decimals = [18, 3];
        uint8[2] memory expectedDecimals = [8, 3];

        for (uint8 i = 0; i < decimals.length; i++) {
            uint256 amount = 5 * 10 ** decimals[i];
            uint256 amountOther = 2 * 10 ** decimals[i];
            TrimmedAmount trimmedAmount = amount.trim(decimals[i], 8);
            TrimmedAmount trimmedAmountOther = amountOther.trim(decimals[i], 8);
            TrimmedAmount trimmedSum = trimmedAmount + trimmedAmountOther;

            TrimmedAmount expectedTrimmedSum = packTrimmedAmount(
                uint64(7 * 10 ** uint64(expectedDecimals[i])), expectedDecimals[i]
            );
            assert(expectedTrimmedSum == trimmedSum);
        }
    }

    function testAddOperatorZero() public pure {
        uint8[2] memory decimals = [18, 3];
        uint8[2] memory expectedDecimals = [8, 3];

        for (uint8 i = 0; i < decimals.length; i++) {
            uint256 amount = 5 * 10 ** decimals[i];
            uint256 amountOther = 0;
            TrimmedAmount trimmedAmount = amount.trim(decimals[i], 8);
            TrimmedAmount trimmedAmountOther = amountOther.trim(decimals[i], 8);
            TrimmedAmount trimmedSum = trimmedAmount + trimmedAmountOther;

            TrimmedAmount expectedTrimmedSum = packTrimmedAmount(
                uint64(5 * 10 ** uint64(expectedDecimals[i])), expectedDecimals[i]
            );
            assert(expectedTrimmedSum == trimmedSum);
        }
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function testAddOperatorDecimalsNotEqualRevert() public {
        uint8 decimals = 18;
        uint8 decimalsOther = 3;

        uint256 amount = 5 * 10 ** decimals;
        uint256 amountOther = 2 * 10 ** decimalsOther;
        TrimmedAmount trimmedAmount = amount.trim(decimals, 8);
        TrimmedAmount trimmedAmountOther = amountOther.trim(decimalsOther, 8);

        vm.expectRevert(abi.encodeWithSelector(NumberOfDecimalsNotEqual.selector, 8, decimalsOther));
        trimmedAmount + trimmedAmountOther;
    }

    function testAddOperatorDecimalsNotEqualNoRevert() public pure {
        uint8[2] memory decimals = [18, 10];
        uint8[2] memory expectedDecimals = [8, 8];

        for (uint8 i = 0; i < decimals.length; i++) {
            uint256 amount = 5 * 10 ** decimals[i];
            uint256 amountOther = 2 * 10 ** 9;
            TrimmedAmount trimmedAmount = amount.trim(decimals[i], 8);
            TrimmedAmount trimmedAmountOther = amountOther.trim(9, 8);
            TrimmedAmount trimmedSum = trimmedAmount + trimmedAmountOther;

            TrimmedAmount expectedTrimmedSum = packTrimmedAmount(
                uint64(7 * 10 ** uint64(expectedDecimals[i])), expectedDecimals[i]
            );
            assert(expectedTrimmedSum == trimmedSum);
        }
    }

    function testSubOperatorNonZero() public pure {
        uint8[2] memory decimals = [18, 3];
        uint8[2] memory expectedDecimals = [8, 3];

        for (uint8 i = 0; i < decimals.length; i++) {
            uint256 amount = 5 * 10 ** decimals[i];
            uint256 amountOther = 2 * 10 ** decimals[i];
            TrimmedAmount trimmedAmount = amount.trim(decimals[i], 8);
            TrimmedAmount trimmedAmountOther = amountOther.trim(decimals[i], 8);
            TrimmedAmount trimmedSub = trimmedAmount - trimmedAmountOther;

            TrimmedAmount expectedTrimmedSub = packTrimmedAmount(
                uint64(3 * 10 ** uint64(expectedDecimals[i])), expectedDecimals[i]
            );
            assert(expectedTrimmedSub == trimmedSub);
        }
    }

    function testSubOperatorZero() public pure {
        uint8[2] memory decimals = [18, 3];
        uint8[2] memory expectedDecimals = [8, 3];

        for (uint8 i = 0; i < decimals.length; i++) {
            uint256 amount = 5 * 10 ** decimals[i];
            uint256 amountOther = 0;
            TrimmedAmount trimmedAmount = amount.trim(decimals[i], 8);
            TrimmedAmount trimmedAmountOther = amountOther.trim(decimals[i], 8);
            TrimmedAmount trimmedSub = trimmedAmount - trimmedAmountOther;

            TrimmedAmount expectedTrimmedSub = packTrimmedAmount(
                uint64(5 * 10 ** uint64(expectedDecimals[i])), expectedDecimals[i]
            );
            assert(expectedTrimmedSub == trimmedSub);
        }
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function testSubOperatorOverflow() public {
        uint8[2] memory decimals = [18, 3];

        for (uint8 i = 0; i < decimals.length; i++) {
            uint256 amount = 5 * 10 ** decimals[i];
            uint256 amountOther = 6 * 10 ** decimals[i];
            TrimmedAmount trimmedAmount = amount.trim(decimals[i], 8);
            TrimmedAmount trimmedAmountOther = amountOther.trim(decimals[i], 8);

            // arithmetic overflow
            vm.expectRevert(stdError.arithmeticError);
            trimmedAmount - trimmedAmountOther;
        }
    }

    function testDifferentDecimals() public {
        uint8 sourceDecimals = 18;
        uint8 targetDecimals = 6;
        uint256 amount = 5 * 10 ** sourceDecimals;

        TrimmedAmount trimmedAmount = amount.trim(sourceDecimals, 8);
        // trimmed to 8
        uint256 amountRoundTrip = trimmedAmount.untrim(targetDecimals);
        // untrim to 6
        uint256 expectedRoundTrip = 5 * 10 ** targetDecimals;

        assertEq(expectedRoundTrip, amountRoundTrip);
    }

    // =============   FUZZ TESTS ================== //

    function testFuzz_setDecimals(TrimmedAmount a, uint8 decimals) public {
        TrimmedAmount b = a.setDecimals(decimals);
        assertEq(b.getDecimals(), decimals);
    }

    function test_packUnpack(uint64 amount, uint8 decimals) public {
        TrimmedAmount trimmed = packTrimmedAmount(amount, decimals);
        assertEq(trimmed.getAmount(), amount);
        assertEq(trimmed.getDecimals(), decimals);
    }

    function testFuzz_AddOperatorOverload(TrimmedAmount a, TrimmedAmount b) public {
        a = a.setDecimals(b.getDecimals());

        // check if the add operation reverts on an overflow.
        // if it overflows, discard the input
        uint256 largeSum = uint256(a.getAmount()) + uint256(b.getAmount());
        vm.assume(largeSum <= type(uint64).max);

        // check if the sum matches the expected sum if no overflow
        TrimmedAmount sum = a + b;
        TrimmedAmount expectedSum = add(a, b);

        assertEq(expectedSum.getAmount(), sum.getAmount());
        assertEq(expectedSum.getDecimals(), sum.getDecimals());
    }

    function testFuzz_SubOperatorOverload(TrimmedAmount a, TrimmedAmount b) public {
        a = a.setDecimals(b.getDecimals());
        vm.assume(a.getAmount() >= b.getAmount());

        TrimmedAmount subAmt = a - b;
        TrimmedAmount expectedSub = sub(a, b);

        assertEq(expectedSub.getAmount(), subAmt.getAmount());
        assertEq(expectedSub.getDecimals(), subAmt.getDecimals());
    }

    function testFuzz_EqOperatorOverload(TrimmedAmount a, TrimmedAmount b) public {
        bool isEqual = a == b;
        bool expectedIsEqual = eq(a, b);

        assertEq(expectedIsEqual, isEqual);
    }

    function testFuzz_GtOperatorOverload(TrimmedAmount a, TrimmedAmount b) public {
        a = a.setDecimals(b.getDecimals());
        bool isGt = a > b;
        bool expectedIsGt = gt(a, b);

        assertEq(expectedIsGt, isGt);
    }

    function testFuzz_LtOperatorOverload(TrimmedAmount a, TrimmedAmount b) public {
        a = a.setDecimals(b.getDecimals());
        bool isLt = a > b;
        bool expectedIsLt = gt(a, b);

        assertEq(expectedIsLt, isLt);
    }

    // invariant: forall (TrimmedAmount a, TrimmedAmount b)
    //            a.saturatingAdd(b).amount <= type(uint64).max
    function testFuzz_saturatingAddDoesNotOverflow(TrimmedAmount a, TrimmedAmount b) public {
        a = a.setDecimals(b.getDecimals());

        TrimmedAmount c = a.saturatingAdd(b);

        // decimals should always be the same, else revert
        assertEq(c.getDecimals(), a.getDecimals());

        // amount should never overflow
        assertLe(c.getAmount(), type(uint64).max);
        // amount should never underflow
        assertGe(c.getAmount(), 0);
    }

    // NOTE: above the TRIMMED_DECIMALS threshold will always get trimmed to TRIMMED_DECIMALS
    // or trimmed to the number of decimals on the recipient chain.
    // this tests for inputs with decimals > TRIMMED_DECIMALS
    function testFuzz_SubOperatorZeroAboveThreshold(uint256 amt, uint8 decimals) public {
        decimals = uint8(bound(decimals, 8, 18));
        uint256 maxAmt = (type(uint64).max) / (10 ** decimals);
        vm.assume(amt < maxAmt);

        uint256 amount = amt * (10 ** decimals);
        uint256 amountOther = 0;
        TrimmedAmount trimmedAmount = amount.trim(decimals, 8);
        TrimmedAmount trimmedAmountOther = amountOther.trim(decimals, 8);

        TrimmedAmount trimmedSub = trimmedAmount - trimmedAmountOther;

        TrimmedAmount expectedTrimmedSub = packTrimmedAmount(uint64(amt * (10 ** 8)), 8);
        assert(expectedTrimmedSub == trimmedSub);
        assertEq(expectedTrimmedSub.getAmount(), trimmedSub.getAmount());
        assertEq(expectedTrimmedSub.getDecimals(), trimmedSub.getDecimals());
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function testFuzz_SubOperatorWillOverflow(
        uint8 decimals,
        uint256 amtLeft,
        uint256 amtRight
    ) public {
        decimals = uint8(bound(decimals, 8, 18));
        uint256 maxAmt = (type(uint64).max) / (10 ** decimals);
        vm.assume(amtRight < maxAmt);
        vm.assume(amtLeft < amtRight);

        uint256 amountLeft = amtLeft * (10 ** decimals);
        uint256 amountRight = amtRight * (10 ** decimals);
        TrimmedAmount trimmedAmount = amountLeft.trim(decimals, 8);
        TrimmedAmount trimmedAmountOther = amountRight.trim(decimals, 8);

        vm.expectRevert(stdError.arithmeticError);
        trimmedAmount - trimmedAmountOther;
    }

    // NOTE: above the TRIMMED_DECIMALS threshold will always get trimmed to TRIMMED_DECIMALS
    // or trimmed to the number of decimals on the recipient chain.
    // this tests for inputs with decimals > TRIMMED_DECIMALS
    function testFuzz_AddOperatorZeroAboveThreshold(uint256 amt, uint8 decimals) public {
        decimals = uint8(bound(decimals, 8, 18));
        uint256 maxAmt = (type(uint64).max) / (10 ** decimals);
        vm.assume(amt < maxAmt);

        uint256 amount = amt * (10 ** decimals);
        uint256 amountOther = 0;
        TrimmedAmount trimmedAmount = amount.trim(decimals, 8);
        TrimmedAmount trimmedAmountOther = amountOther.trim(decimals, 8);

        TrimmedAmount trimmedSum = trimmedAmount + trimmedAmountOther;

        TrimmedAmount expectedTrimmedSum = packTrimmedAmount(uint64(amt * (10 ** 8)), 8);
        assert(expectedTrimmedSum == trimmedSum);
        assertEq(expectedTrimmedSum.getAmount(), trimmedSum.getAmount());
        assertEq(expectedTrimmedSum.getDecimals(), trimmedSum.getDecimals());
    }

    function testFuzz_trimmingInvariants(
        uint256 amount,
        uint256 amount2,
        uint8 fromDecimals,
        uint8 midDecimals,
        uint8 toDecimals
    ) public {
        // restrict inputs up to u64MAX. Inputs above u64 are tested elsewhere
        amount = bound(amount, 0, type(uint64).max);
        amount2 = bound(amount, 0, type(uint64).max);
        vm.assume(fromDecimals <= 50);
        vm.assume(toDecimals <= 50);

        TrimmedAmount trimmedAmt = amount.trim(fromDecimals, toDecimals);
        TrimmedAmount trimmedAmt2 = amount2.trim(fromDecimals, toDecimals);
        uint256 untrimmedAmt = trimmedAmt.untrim(fromDecimals);
        uint256 untrimmedAmt2 = trimmedAmt2.untrim(fromDecimals);

        // trimming is the left inverse of untrimming
        // invariant: forall (x: TrimmedAmount, fromDecimals: uint8, toDecimals: uint8),
        //            (x.amount <= type(uint64).max)
        //                    => (trim(untrim(x)) == x)
        TrimmedAmount amountRoundTrip = untrimmedAmt.trim(fromDecimals, toDecimals);
        assertEq(trimmedAmt.getAmount(), amountRoundTrip.getAmount());

        // trimming is a NOOP
        // invariant:
        //     forall (x: uint256, y: uint8, z: uint8),
        //            (y < z && (y < 8 || z < 8)), trim(x) == x
        if (fromDecimals <= toDecimals && (fromDecimals < 8 || toDecimals < 8)) {
            assertEq(trimmedAmt.getAmount(), uint64(amount));
        }

        // invariant: source amount is always greater than or equal to the trimmed amount
        // this is also captured by the invariant above
        assertGe(amount, trimmedAmt.getAmount());

        // invariant: trimmed amount must not exceed the untrimmed amount
        assertLe(trimmedAmt.getAmount(), untrimmedAmt);

        // invariant: untrimmed amount must not exceed the source amount
        assertLe(untrimmedAmt, amount);

        // invariant:
        //         the number of decimals after trimming must not exceed
        //         the number of decimals before trimming
        assertLe(trimmedAmt.getDecimals(), fromDecimals);

        // invariant:
        //      trimming and untrimming preserve ordering relations
        if (amount > amount2) {
            assertGt(untrimmedAmt, untrimmedAmt2);
        } else if (amount < amount2) {
            assertLt(untrimmedAmt, untrimmedAmt2);
        } else {
            assertEq(untrimmedAmt, untrimmedAmt2);
        }

        // invariant: trimming and untrimming are commutative when
        //            the number of decimals are the same and less than or equal to 8
        if (fromDecimals <= 8 && fromDecimals == toDecimals) {
            assertEq(amount, untrimmedAmt);
        }

        // invariant: trimming and untrimming are associative
        //            when there is no intermediate loss of precision
        vm.assume(midDecimals >= fromDecimals);
        TrimmedAmount trimmedAmtA = amount.trim(fromDecimals, midDecimals);
        TrimmedAmount trimmedAmtB = amount.trim(fromDecimals, toDecimals);
        assertEq(trimmedAmtA.untrim(toDecimals), trimmedAmtB.untrim(toDecimals));
    }
}
