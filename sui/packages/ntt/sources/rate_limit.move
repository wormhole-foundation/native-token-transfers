module ntt::rate_limit {
    use sui::clock::Clock;

    const RATE_LIMIT_DURATION: u64 = 24 * 60 * 60 * 1000; // 24 hours in ms

    #[error]
    const EInvalidRateLimitResult: vector<u8>
        = b"Invalid RateLimitResult";

    public enum RateLimitResult has drop {
        Consumed,
        Delayed(u64),
    }

    public fun is_consumed(result: &RateLimitResult): bool {
        match (result) {
            RateLimitResult::Consumed => true,
            _ => false,
        }
    }

    public fun is_delayed(result: &RateLimitResult): bool {
        match (result) {
            RateLimitResult::Delayed(_) => true,
            _ => false,
        }
    }

    public fun delayed_until(result: &RateLimitResult): u64 {
        match (result) {
            RateLimitResult::Delayed(until) => *until,
            _ => abort EInvalidRateLimitResult,
        }
    }

    public struct RateLimitState has store {
        /// The maximum capacity of the rate limiter.
        limit: u64,
        /// The capacity of the rate limiter at `last_tx_timestamp`.
        /// The actual current capacity is calculated in `capacity_at`, by
        /// accounting for the time that has passed since `last_tx_timestamp` and
        /// the refill rate.
        capacity_at_last_tx: u64,
        /// The timestamp (in ms) of the last transaction that counted towards the current
        /// capacity. Transactions that exceeded the capacity do not count, they are
        /// just delayed.
        last_tx_timestamp: u64,
    }

    public fun new(limit: u64): RateLimitState {
        RateLimitState {
            limit: limit,
            capacity_at_last_tx: limit,
            last_tx_timestamp: 0,
        }
    }

    public fun capacity_at(self: &RateLimitState, now: u64): u64 {
        assert!(self.last_tx_timestamp <= now);

        let limit = (self.limit as u128);

        // morally this is
        // capacity = old_capacity + (limit / rate_limit_duration) * time_passed
        //
        // but we instead write it as
        // capacity = old_capacity + (limit * time_passed) / rate_limit_duration
        // as it has better numerical stability.
        //
        // This can overflow u64 (if limit is close to u64 max), so we use u128
        // for the intermediate calculations. Theoretically it could also overflow u128
        // if limit == time_passed == u64 max, but that will take a very long time.

        let capacity_at_last_tx = self.capacity_at_last_tx;

        let calculated_capacity = {
            let time_passed = now - self.last_tx_timestamp;
            (capacity_at_last_tx as u128)
                + (time_passed as u128) * limit / (Self::RATE_LIMIT_DURATION as u128)
        };

        // The use of `min` here prevents truncation.
        // The value of `limit` is u64 in reality. If both `calculated_capacity` and `limit` are at
        // their maxiumum possible values (u128::MAX and u64::MAX), then u64::MAX will be chosen by
        // `min`. So truncation is not possible.
        min!(calculated_capacity, limit) as u64
    }

    macro fun min($x: _, $y: _): _ {
        let x = $x;
        let y = $y;
        if (x < y) x
        else y
    }

    public fun consume_or_delay(self: &mut RateLimitState, clock: &Clock, amount: u64): RateLimitResult {
        let now = clock.timestamp_ms();
        let capacity = self.capacity_at(now);
        if (capacity >= amount) {
            self.capacity_at_last_tx = capacity - amount;
            self.last_tx_timestamp = now;
            RateLimitResult::Consumed
        } else {
            RateLimitResult::Delayed(now + Self::RATE_LIMIT_DURATION)
        }
    }

    public fun refill(self: &mut RateLimitState, clock: &Clock, amount: u64) {
        // saturating add
        let new_amount: u128 = (self.capacity_at(clock.timestamp_ms()) as u128) + (amount as u128);
        let new_amount = min!(new_amount, 0xFFFF_FFFF_FFFF_FFFF) as u64;

        self.capacity_at_last_tx = min!(new_amount, self.limit);
    }

    public fun set_limit(self: &mut RateLimitState, limit: u64, clock: &Clock) {
        let old_limit = self.limit;
        let now = clock.timestamp_ms();
        let current_capacity = self.capacity_at(now);

        self.limit = limit;

        let new_capacity: u64 = if (old_limit > limit) {
            // decrease in limit,
            let diff = old_limit - limit;
            if (diff > current_capacity) {
                0
            } else {
                current_capacity - diff
            }
        } else {
            // increase in limit
            let diff = limit - old_limit;
            let new_capacity: u128 = (current_capacity as u128) + (diff as u128);
            // saturating add
            min!(new_capacity, 0xFFFF_FFFF_FFFF_FFFF) as u64
        };

        self.capacity_at_last_tx = new_capacity.min(limit);
        self.last_tx_timestamp = now;
    }
}
