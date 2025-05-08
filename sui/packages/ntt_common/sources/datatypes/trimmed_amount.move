// SPDX-License-Identifier: Apache 2

/// Amounts represented in transfers are capped at 8 decimals. This
/// means that any amount that's given as having more decimals is truncated to 8
/// decimals. On the way out, these amount have to be scaled back to the
/// original decimal amount. This module defines [`TrimmedAmount`], which
/// represents amounts that have been capped at 8 decimals.
///
/// The functions [`trim`] and [`untrim`] take care of convertion to/from
/// this type given the original amount's decimals.
module ntt_common::trimmed_amount {
    use sui::coin::Coin;
    use sui::balance::Balance;
    use wormhole::bytes;
    use wormhole::cursor::{Self, Cursor};

    /// Maximum number of decimals supported in trimmed amounts
    const TRIMMED_DECIMALS: u8 = 8;

    /// Error when exponent calculation overflows
    const E_OVERFLOW_EXPONENT: u64 = 0;
    /// Error when scaling amount overflows
    const E_OVERFLOW_SCALED_AMOUNT: u64 = 1;

    const U64_MAX: u64 = 18446744073709551615;

    /// Container holding a trimmed amount and its decimal precision
    public struct TrimmedAmount has store, copy, drop {
        amount: u64,
        decimals: u8
    }

    /// Create new TrimmedAmount with given amount and decimals
    public fun new(amount: u64, decimals: u8): TrimmedAmount {
        TrimmedAmount {
            amount,
            decimals
        }
    }

    /// Scale amount between different decimal precisions
    public fun scale(amount: u64, from_decimals: u8, to_decimals: u8): u64 {
        if (from_decimals == to_decimals) {
            return amount
        };

        if (from_decimals > to_decimals) {
            let power = from_decimals - to_decimals;
            assert!(power <= 18, E_OVERFLOW_EXPONENT);
            let scaling_factor = 10u64.pow(power);
            amount / scaling_factor
        } else {
            let power = to_decimals - from_decimals;
            assert!(power <= 18, E_OVERFLOW_EXPONENT);
            let scaling_factor = 10u64.pow(power);
            assert!(amount <= (U64_MAX / scaling_factor), E_OVERFLOW_SCALED_AMOUNT);
            amount * scaling_factor
        }
    }

    /// Trim amount to specified decimal precision, capped at TRIMMED_DECIMALS
    public fun trim(amount: u64, from_decimals: u8, to_decimals: u8): TrimmedAmount {
        let to_decimals = min(TRIMMED_DECIMALS, min(from_decimals, to_decimals));
        let amount = scale(amount, from_decimals, to_decimals);
        new(amount, to_decimals)
    }

    /// Scale amount back to original decimal precision
    public fun untrim(self: &TrimmedAmount, to_decimals: u8): u64 {
        scale(self.amount, self.decimals, to_decimals)
    }

    /// Remove dust from amount by trimming and scaling back. Returns both the
    /// trimmed amount and modifies the original amount in place.
    public fun remove_dust<T>(
        coin: &mut Coin<T>,
        from_decimals: u8,
        to_decimals: u8
    ): (TrimmedAmount, Balance<T>) {
        let amount = coin.value();
        let trimmed = trim(amount, from_decimals, to_decimals);
        let without_dust = untrim(&trimmed, from_decimals);
        (trimmed, coin.balance_mut().split(amount - without_dust))
    }

    public fun amount(self: &TrimmedAmount): u64 {
        self.amount
    }

    public fun decimals(self: &TrimmedAmount): u8 {
        self.decimals
    }

    public fun take_bytes(cur: &mut Cursor<u8>): TrimmedAmount {
        let decimals = cursor::poke(cur);
        let amount = bytes::take_u64_be(cur);
        new(amount, decimals)
    }

    public fun to_bytes(self: &TrimmedAmount): vector<u8> {
        let mut result = vector::empty();
        bytes::push_u8(&mut result, self.decimals);
        bytes::push_u64_be(&mut result, self.amount);
        result
    }

    fun min(a: u8, b: u8): u8 {
        if (a < b) { a } else { b }
    }
}

#[test_only]
module ntt_common::trimmed_amount_tests {
    use ntt_common::trimmed_amount;

    #[test]
    fun test_trim_and_untrim() {
        let amount = 100555555555555555;
        let trimmed = trimmed_amount::trim(amount, 18, 9);
        let untrimmed = trimmed_amount::untrim(&trimmed, 18);
        assert!(untrimmed == 100555550000000000, 0);

        let amount = 100000000000000000;
        let trimmed = trimmed_amount::trim(amount, 7, 11);
        assert!(trimmed_amount::amount(&trimmed) == amount, 0);

        let trimmed = trimmed_amount::trim(158434, 6, 3);
        assert!(trimmed_amount::amount(&trimmed) == 158, 0);
        assert!(trimmed_amount::decimals(&trimmed) == 3, 0);

        let small_amount = trimmed_amount::new(1, 6);
        let scaled = trimmed_amount::untrim(&small_amount, 13);
        assert!(scaled == 10000000, 0);
    }

    #[test]
    #[expected_failure(abort_code = ntt_common::trimmed_amount::E_OVERFLOW_EXPONENT)]
    fun test_scale_overflow_exponent() {
        trimmed_amount::scale(100, 0, 255);
    }

    #[test]
    #[expected_failure(abort_code = ntt_common::trimmed_amount::E_OVERFLOW_SCALED_AMOUNT)]
    fun test_scale_overflow_amount() {
        trimmed_amount::scale(18446744073709551615, 10, 11);
    }
}
