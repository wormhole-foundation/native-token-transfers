module sui_m::continuous_indexing_math {
    // ============ Constants ============

    /// The scaling of rates for exponent math
    const EXP_SCALED_ONE: u64 = 1_000_000_000_000; // 1e12

    // ============ Error Codes ============

    /// Error when a division by zero occurs
    const EDivisionByZero: u64 = 1;

    // ============ Public Functions ============

    /// Helper function to calculate `(x * EXP_SCALED_ONE) / index`, rounded down
    public fun divide_down(x: u256, index: u128): u128 {
        assert!(index != 0, EDivisionByZero);

        // Calculate (x * EXP_SCALED_ONE) / index
        let scaled_x = x * (EXP_SCALED_ONE as u256);
        let result = scaled_x / (index as u256);

        // Safe cast to u128 (original returns u112, we use u128 as per type mappings)
        (result as u128)
    }

    /// Helper function to calculate `(x * EXP_SCALED_ONE) / index`, rounded up
    public fun divide_up(x: u256, index: u128): u128 {
        assert!(index != 0, EDivisionByZero);

        // Calculate ((x * EXP_SCALED_ONE) + index - 1) / index for rounding up
        let scaled_x = x * (EXP_SCALED_ONE as u256);
        let index_256 = (index as u256);
        let result = (scaled_x + index_256 - 1) / index_256;

        // Safe cast to u128 (original returns u112, we use u128 as per type mappings)
        (result as u128)
    }

    /// Helper function to calculate `(x * index) / EXP_SCALED_ONE`, rounded down
    public fun multiply_down(x: u128, index: u128): u256 {
        // Calculate (x * index) / EXP_SCALED_ONE
        let product = (x as u256) * (index as u256);
        product / (EXP_SCALED_ONE as u256)
    }

    /// Helper function to calculate `(x * index) / EXP_SCALED_ONE`, rounded up
    public fun multiply_up(x: u128, index: u128): u256 {
        // Calculate ((x * index) + (EXP_SCALED_ONE - 1)) / EXP_SCALED_ONE for rounding up
        let product = (x as u256) * (index as u256);
        let exp_scaled_one_256 = (EXP_SCALED_ONE as u256);
        (product + exp_scaled_one_256 - 1) / exp_scaled_one_256
    }
}
