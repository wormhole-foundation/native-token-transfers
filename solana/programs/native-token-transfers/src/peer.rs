use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
/// A peer on another chain. Stored in a PDA seeded by the chain id.
pub struct NttManagerPeer {
    pub bump: u8,
    pub address: [u8; 32],
    pub token_decimals: u8,
}

impl NttManagerPeer {
    pub const SEED_PREFIX: &'static [u8] = b"peer";
}
