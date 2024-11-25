//! This module provides a function to get the current Unix timestamp.
//! During testing, the timestamp can be overridden using the [`set_test_timestamp`] function.
//! When not testing, the timestamp is retrieved from the Solana runtime.
//! This makes it easy to unit test functions that depend on the current time
//! without having to instantiate a Solana runtime.

#[cfg(not(test))]
use anchor_lang::prelude::*;

use anchor_lang::solana_program::clock::UnixTimestamp;

#[cfg(test)]
static TEST_TIMESTAMP: std::sync::Mutex<i64> = std::sync::Mutex::new(0);

pub fn current_timestamp() -> UnixTimestamp {
    #[cfg(not(test))]
    return anchor_lang::solana_program::clock::Clock::get()
        .unwrap()
        .unix_timestamp;
    #[cfg(test)]
    return *TEST_TIMESTAMP.lock().unwrap();
}

#[cfg(test)]
pub fn set_test_timestamp(timestamp: UnixTimestamp) {
    *TEST_TIMESTAMP.lock().unwrap() = timestamp;
}
