use std::ops::{Deref, DerefMut};

use anchor_lang::prelude::*;
use ntt_messages::{chain_id::ChainId, trimmed_amount::TrimmedAmount};

use crate::{bitmap::*, clock::current_timestamp, error::NTTError};

use super::rate_limit::RateLimitState;

#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
// TODO: generalise this to arbitrary outbound messages (via a generic parameter in place of amount and recipient info)
pub struct OutboxItem {
    pub amount: TrimmedAmount,
    pub sender: Pubkey,
    pub recipient_chain: ChainId,
    pub recipient_ntt_manager: [u8; 32],
    pub recipient_address: [u8; 32],
    pub release_timestamp: i64,
    pub released: Bitmap,
}

impl OutboxItem {
    /// Attempt to release the transfer.
    /// Returns true if the transfer was released, false if it was not yet time to release it.
    /// TODO: this is duplicated in inbox.rs. factor out?
    pub fn try_release(&mut self, transceiver_index: u8) -> Result<bool> {
        let now = current_timestamp();

        if self.release_timestamp > now {
            return Ok(false);
        }

        if self.released.get(transceiver_index)? {
            return Err(NTTError::MessageAlreadySent.into());
        }

        self.released.set(transceiver_index, true)?;

        Ok(true)
    }
}

#[account]
#[derive(InitSpace, PartialEq, Eq, Debug)]
pub struct OutboxRateLimit {
    pub rate_limit: RateLimitState,
}

/// Global rate limit for all outbound transfers to all chains.
/// NOTE: only one of this account can exist, so we don't need to check the PDA.
impl OutboxRateLimit {
    pub const SEED_PREFIX: &'static [u8] = b"outbox_rate_limit";
}

impl Deref for OutboxRateLimit {
    type Target = RateLimitState;

    fn deref(&self) -> &Self::Target {
        &self.rate_limit
    }
}

impl DerefMut for OutboxRateLimit {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.rate_limit
    }
}
