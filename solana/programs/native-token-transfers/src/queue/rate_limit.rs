use anchor_lang::{prelude::*, solana_program::clock::UnixTimestamp};

use crate::clock::current_timestamp;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, PartialEq, Eq, Debug)]
pub struct RateLimitState {
    /// The maximum capacity of the rate limiter.
    pub limit: u64,
    /// The capacity of the rate limiter at `last_tx_timestamp`.
    /// The actual current capacity is calculated in `capacity_at`, by
    /// accounting for the time that has passed since `last_tx_timestamp` and
    /// the refill rate.
    pub capacity_at_last_tx: u64,
    /// The timestamp of the last transaction that counted towards the current
    /// capacity. Transactions that exceeded the capacity do not count, they are
    /// just delayed.
    pub last_tx_timestamp: i64,
}

/// The result of attempting to consume from a rate limiter.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RateLimitResult {
    /// If the rate limit is not exceeded, the transfer is immediate,
    /// and the capacity is reduced.
    Consumed(UnixTimestamp),
    /// If the rate limit is exceeded, the transfer is delayed until the
    /// given timestamp.
    Delayed(UnixTimestamp),
}

impl RateLimitState {
    pub fn new(limit: u64) -> Self {
        Self {
            limit,
            capacity_at_last_tx: limit,
            last_tx_timestamp: 0,
        }
    }

    pub const RATE_LIMIT_DURATION: i64 = 60 * 60 * 24; // 24 hours

    pub fn capacity(&self) -> u64 {
        self.capacity_at(current_timestamp())
    }

    /// Returns the capacity of the rate limiter.
    /// On-chain programs and unit tests should always use [`capacity`].
    /// This function is useful in solana-program-test, where the clock sysvar
    // SECURITY: Integer division is OK here. We are not that concerned with precision. Removing
    // the remainder in this case is arguably more secure as it reduces the available capacity.
    // SECURITY: Sign loss is OK here. It is a conversion performed on a timestamp that must always be
    // positive.
    // SECURITY: Truncation is allowed here. Clippy warns about the final returned expression, but it is
    // safe.
    #[allow(clippy::integer_division)]
    #[allow(clippy::cast_sign_loss)]
    #[allow(clippy::cast_possible_truncation)]
    pub fn capacity_at(&self, now: UnixTimestamp) -> u64 {
        assert!(self.last_tx_timestamp <= now);

        let limit = u128::from(self.limit);

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
            u128::from(capacity_at_last_tx)
                + time_passed as u128 * limit / (Self::RATE_LIMIT_DURATION as u128)
        };

        // The use of `min` here prevents truncation.
        // The value of `limit` is u64 in reality. If both `calculated_capacity` and `limit` are at
        // their maxiumum possible values (u128::MAX and u64::MAX), then u64::MAX will be chosen by
        // `min`. So truncation is not possible.
        calculated_capacity.min(limit) as u64
    }

    /// Computes the timestamp at which the given amount can be consumed.
    /// If it fits within the current capacity, the current timestamp is
    /// returned, and the remaining capacity is reduced.
    /// Otherwise, the timestamp at which the capacity will be available is
    /// returned.
    pub fn consume_or_delay(&mut self, amount: u64) -> RateLimitResult {
        let now = current_timestamp();
        let capacity = self.capacity_at(now);
        if capacity >= amount {
            self.capacity_at_last_tx = capacity - amount;
            self.last_tx_timestamp = now;
            RateLimitResult::Consumed(now)
        } else {
            RateLimitResult::Delayed(now + Self::RATE_LIMIT_DURATION)
        }
    }

    /// Refills the capacity by the given amount.
    /// This is used to replenish the capacity via backflows.
    pub fn refill(&mut self, now: UnixTimestamp, amount: u64) {
        self.capacity_at_last_tx = self.capacity_at(now).saturating_add(amount).min(self.limit);
        self.last_tx_timestamp = now;
    }

    pub fn set_limit(&mut self, limit: u64) {
        let old_limit = self.limit;
        let now = current_timestamp();
        let current_capacity = self.capacity_at(now);

        self.limit = limit;

        let new_capacity: u64 = if old_limit > limit {
            // decrease in limit,
            let diff = old_limit - limit;
            current_capacity.saturating_sub(diff)
        } else {
            // increase in limit
            let diff = limit - old_limit;
            current_capacity.saturating_add(diff)
        };

        self.capacity_at_last_tx = new_capacity.min(limit);
        self.last_tx_timestamp = now;
    }
}

#[cfg(test)]
mod tests {
    use crate::clock::set_test_timestamp;

    use super::*;

    #[test]
    #[allow(clippy::integer_division)]
    fn test_rate_limit() {
        let now = current_timestamp();
        let mut rate_limit_state = RateLimitState {
            limit: 100_000,
            capacity_at_last_tx: 100_000,
            last_tx_timestamp: now,
        };

        // consume 30k. should be immediate
        let immediately = rate_limit_state.consume_or_delay(30_000);

        assert_eq!(immediately, RateLimitResult::Consumed(now));
        assert_eq!(rate_limit_state.capacity(), 70_000);
        assert_eq!(rate_limit_state.limit, 100_000); // unchanged
        assert_eq!(rate_limit_state.last_tx_timestamp, current_timestamp());

        // replenish 1/4 of the limit, i.e. 25k
        set_test_timestamp(current_timestamp() + RateLimitState::RATE_LIMIT_DURATION / 4);
        let now = current_timestamp();

        assert_eq!(rate_limit_state.capacity(), 70_000 + 25_000);

        // now consume 150k. should be delayed
        let tomorrow = rate_limit_state.consume_or_delay(150_000);
        assert_eq!(
            tomorrow,
            RateLimitResult::Delayed(now + RateLimitState::RATE_LIMIT_DURATION)
        );

        // the limit is not changed, since the tx was delayed
        assert_eq!(rate_limit_state.capacity(), 70_000 + 25_000);

        // now set the limit to 50k
        rate_limit_state.set_limit(50_000);

        // this decreases the capacity by 50k, to 45k
        assert_eq!(rate_limit_state.capacity(), 45_000);

        // now set the limit to 100k
        rate_limit_state.set_limit(100_000);

        assert_eq!(rate_limit_state.capacity(), 95_000);

        // now refill 2k
        rate_limit_state.refill(now, 2_000);
        assert_eq!(rate_limit_state.capacity(), 97_000);

        // now refill 50k
        rate_limit_state.refill(now, 50_000);
        assert_eq!(rate_limit_state.capacity(), 100_000);
    }
}
