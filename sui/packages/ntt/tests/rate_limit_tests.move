#[test_only]
/// Unit tests for the rate limiter's underlying properties
module ntt::rate_limit_tests {
    use sui::clock::{Self, Clock};
    use ntt::rate_limit::{Self, RateLimitState};

    // Mirrors the private RATE_LIMIT_DURATION in rate_limit.move (24h in ms).
    const DURATION: u64 = 24 * 60 * 60 * 1000;

    fun new_clock(): Clock {
        let mut ctx = sui::tx_context::dummy();
        clock::create_for_testing(&mut ctx)
    }

    // RateLimitState has `store` but not `drop`, so it must be explicitly consumed.
    fun teardown(state: RateLimitState, clock: Clock) {
        std::unit_test::destroy(state);
        clock::destroy_for_testing(clock);
    }

    #[test]
    fun test_new_starts_full() {
        let clock = new_clock();
        let state = rate_limit::new(1_000);
        assert!(state.limit() == 1_000);
        assert!(state.capacity_at_last_tx() == 1_000);
        assert!(state.last_tx_timestamp() == 0);
        assert!(state.capacity_at(0) == 1_000);
        teardown(state, clock);
    }

    #[test]
    fun test_consume_reduces_capacity_and_stamps_time() {
        let mut clock = new_clock();
        clock.increment_for_testing(5_000);
        let mut state = rate_limit::new(1_000);

        let r = state.consume_or_delay(&clock, 400);
        assert!(r.is_consumed());
        assert!(state.capacity_at_last_tx() == 600);
        assert!(state.last_tx_timestamp() == 5_000);
        teardown(state, clock);
    }

    #[test]
    fun test_consume_exact_capacity_ok() {
        let clock = new_clock();
        let mut state = rate_limit::new(1_000);

        let r = state.consume_or_delay(&clock, 1_000);
        assert!(r.is_consumed());
        assert!(state.capacity_at_last_tx() == 0);
        teardown(state, clock);
    }

    #[test]
    /// A delayed (over-capacity) consume must NOT mutate the limiter counters:
    /// "Transactions that exceeded the capacity do not count, they are just delayed."
    fun test_delay_leaves_counters_untouched() {
        let mut clock = new_clock();
        clock.increment_for_testing(7_000);
        let mut state = rate_limit::new(1_000);

        // Consume some first, so we have a non-default state to detect mutation against.
        // capacity 800, last_tx 7_000
        let r0 = state.consume_or_delay(&clock, 200);
        assert!(r0.is_consumed());

        // t = 8_000
        clock.increment_for_testing(1_000);
        let cap_before = state.capacity_at_last_tx();
        let ts_before = state.last_tx_timestamp();

        // Far over capacity.
        let r = state.consume_or_delay(&clock, 100_000);
        assert!(r.is_delayed());
        assert!(r.delayed_until() == 8_000 + DURATION);

        // Counters untouched by the delayed path.
        assert!(state.capacity_at_last_tx() == cap_before);
        assert!(state.last_tx_timestamp() == ts_before);
        teardown(state, clock);
    }

    #[test]
    /// Capacity recovers proportionally to elapsed time. Choosing limit == DURATION
    /// makes the refill rate exactly 1 unit/ms, so after half the window exactly
    /// half the limit is back.
    fun test_partial_time_refill_is_proportional() {
        let mut clock = new_clock();
        let mut state = rate_limit::new(DURATION);

        // Drain fully at t=0.
        let r = state.consume_or_delay(&clock, DURATION);
        assert!(r.is_consumed());
        assert!(state.capacity_at(0) == 0);

        clock.increment_for_testing(DURATION / 2);
        assert!(state.capacity_at(DURATION / 2) == DURATION / 2);
        teardown(state, clock);
    }

    #[test]
    /// Time-based refill saturates at `limit` — it never exceeds it no matter how
    /// much time passes.
    fun test_time_refill_caps_at_limit() {
        let mut clock = new_clock();
        let mut state = rate_limit::new(DURATION);

        let r = state.consume_or_delay(&clock, DURATION);
        assert!(r.is_consumed());

        // Exactly back to limit after one full window.
        clock.increment_for_testing(DURATION);
        assert!(state.capacity_at(DURATION) == DURATION);

        // Still capped after additional time.
        clock.increment_for_testing(2 * DURATION);
        assert!(state.capacity_at(3 * DURATION) == DURATION);
        teardown(state, clock);
    }

    #[test]
    fun test_refill_adds_within_headroom() {
        let clock = new_clock();
        let mut state = rate_limit::new(1_000);

        // capacity 400 at t=0
        let r = state.consume_or_delay(&clock, 600);
        assert!(r.is_consumed());

        // 400 + 300 = 700, under limit
        state.refill(&clock, 300);
        assert!(state.capacity_at_last_tx() == 700);
        assert!(state.last_tx_timestamp() == 0);
        teardown(state, clock);
    }

    #[test]
    fun test_refill_saturates_at_limit() {
        let clock = new_clock();
        let mut state = rate_limit::new(1_000);

        // capacity 400
        let r = state.consume_or_delay(&clock, 600);
        assert!(r.is_consumed());

        // Would overshoot the limit; must be capped.
        state.refill(&clock, 10_000);
        assert!(state.capacity_at_last_tx() == 1_000);
        teardown(state, clock);
    }

    #[test]
    /// Lowering the limit reduces current capacity by the same delta.
    fun test_set_limit_decrease_reduces_capacity() {
        let clock = new_clock();
        // full: capacity 1_000
        let mut state = rate_limit::new(1_000);

        state.set_limit(600, &clock);
        assert!(state.limit() == 600);
        // 1_000 - 400
        assert!(state.capacity_at_last_tx() == 600);
        teardown(state, clock);
    }

    #[test]
    /// If the limit decrease exceeds current capacity, capacity floors at 0.
    fun test_set_limit_decrease_floors_at_zero() {
        let clock = new_clock();
        let mut state = rate_limit::new(1_000);

        // capacity 50
        let r = state.consume_or_delay(&clock, 950);
        assert!(r.is_consumed());

        // Decrease of 200 > capacity 50.
        state.set_limit(800, &clock);
        assert!(state.capacity_at_last_tx() == 0);
        teardown(state, clock);
    }

    #[test]
    /// Raising the limit increases current capacity by the same delta.
    fun test_set_limit_increase_raises_capacity() {
        let clock = new_clock();
        // full: capacity 1_000
        let mut state = rate_limit::new(1_000);

        state.set_limit(1_500, &clock);
        assert!(state.limit() == 1_500);
        // 1_000 + 500
        assert!(state.capacity_at_last_tx() == 1_500);
        teardown(state, clock);
    }

    #[test, expected_failure]
    /// `capacity_at` requires `last_tx_timestamp <= now`; querying the past aborts.
    fun test_capacity_at_before_last_tx_aborts() {
        let mut clock = new_clock();
        clock.increment_for_testing(5_000);
        let mut state = rate_limit::new(1_000);

        // last_tx = 5_000
        let r = state.consume_or_delay(&clock, 100);
        assert!(r.is_consumed());

        // now < last_tx -> abort
        let _ = state.capacity_at(4_000);
        teardown(state, clock);
    }
}
