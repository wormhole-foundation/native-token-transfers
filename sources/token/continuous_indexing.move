module sui_m::continuous_indexing {
    use sui::event;
    use sui_m::continuous_indexing_math::{
        divide_down,
        divide_up,
        multiply_down,
        multiply_up
    };

    // ============ Constants ============

    /// The scaling of rates for exponent math
    const EXP_SCALED_ONE: u128 = 1_000_000_000_000; // 1e12

    // ============ Error Codes ============
    const EDecreasingIndex: u64 = 1;

    // ============ Events ============

    /// Emitted when the index is updated
    public struct IndexUpdated has copy, drop {
        current_index: u128
    }

    // ============ Structs ============

    /// ContinuousIndexing state that tracks index and rate updates
    public struct ContinuousIndexing has store {
        /// The latest index value (uint128 in Solidity → u128)
        latest_index: u128,

        /// The timestamp of the latest update (uint40 in Solidity → u64)
        latest_update_timestamp: u64
    }

    // ============ Constructor Functions ============

    /// Create a new ContinuousIndexing instance
    public fun new(ctx: &tx_context::TxContext): ContinuousIndexing {
        ContinuousIndexing {
            latest_index: EXP_SCALED_ONE,
            latest_update_timestamp: tx_context::epoch_timestamp_ms(ctx) / 1000 // Convert ms to seconds
        }
    }

    // ============ View Functions ============

    /// Get the latest index
    public fun latest_index(indexing: &ContinuousIndexing): u128 {
        indexing.latest_index
    }

    /// Get the latest update timestamp
    public fun latest_update_timestamp(indexing: &ContinuousIndexing): u64 {
        indexing.latest_update_timestamp
    }

    /// Get the latest index
    public fun current_index(indexing: &ContinuousIndexing): u128 {
        indexing.latest_index
    }

    // ============ Update Functions ============

    /// Update the index with a new value
    /// This is the internal _updateIndex from Solidity made public for Sui
    public fun update_index(
        indexing: &mut ContinuousIndexing, index: u128, current_timestamp: u64
    ) {
        assert!(index >= indexing.latest_index, EDecreasingIndex);
        indexing.latest_index = index;
        indexing.latest_update_timestamp = current_timestamp;

        event::emit(IndexUpdated { current_index: index })
    }

    // ============ Principal Amount Functions (from present amount) ============

    /// Returns the principal amount (rounded down) given the present amount, using the current index
    public fun get_principal_amount_rounded_down(
        indexing: &ContinuousIndexing, present_amount: u256
    ): u128 {
        get_principal_amount_rounded_down_with_index(
            present_amount, current_index(indexing)
        )
    }

    /// Returns the principal amount (rounded up) given the present amount, using the current index
    public fun get_principal_amount_rounded_up(
        indexing: &ContinuousIndexing, present_amount: u256
    ): u128 {
        get_principal_amount_rounded_up_with_index(
            present_amount, current_index(indexing)
        )
    }

    /// Returns the principal amount (rounded down) given the present amount and an index
    public fun get_principal_amount_rounded_down_with_index(
        present_amount: u256, index: u128
    ): u128 {
        divide_down(present_amount, index)
    }

    /// Returns the principal amount (rounded up) given the present amount and an index
    public fun get_principal_amount_rounded_up_with_index(
        present_amount: u256, index: u128
    ): u128 {
        divide_up(present_amount, index)
    }

    // ============ Present Amount Functions (from principal amount) ============

    /// Returns the present amount (rounded down) given the principal amount and an index
    public fun get_present_amount_rounded_down(
        principal_amount: u128, index: u128
    ): u256 {
        multiply_down(principal_amount, index)
    }

    /// Returns the present amount (rounded up) given the principal amount and an index
    public fun get_present_amount_rounded_up(
        principal_amount: u128, index: u128
    ): u256 {
        multiply_up(principal_amount, index)
    }

    /// Returns the present amount (rounded down) given the principal amount, using the current index
    public fun get_present_amount_rounded_down_current(
        indexing: &ContinuousIndexing, principal_amount: u128
    ): u256 {
        multiply_down(principal_amount, current_index(indexing))
    }

    /// Returns the present amount (rounded up) given the principal amount, using the current index
    public fun get_present_amount_rounded_up_current(
        indexing: &ContinuousIndexing, principal_amount: u128
    ): u256 {
        multiply_up(principal_amount, current_index(indexing))
    }
}
