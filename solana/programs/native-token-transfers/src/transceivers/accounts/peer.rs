use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
/// A peer on another chain. Stored in a PDA seeded by the chain id.
pub struct TransceiverPeer {
    pub bump: u8,
    pub address: [u8; 32],
}

impl TransceiverPeer {
    pub const SEED_PREFIX: &'static [u8] = b"transceiver_peer";
}
