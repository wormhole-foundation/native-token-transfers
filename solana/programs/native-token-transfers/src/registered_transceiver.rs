use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct RegisteredTransceiver {
    pub bump: u8,
    pub id: u8,
    pub transceiver_address: Pubkey,
}

impl RegisteredTransceiver {
    pub const SEED_PREFIX: &'static [u8] = b"registered_transceiver";
}
