use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PendingTokenAuthority {
    pub bump: u8,
    pub pending_authority: Pubkey,
    pub rent_payer: Pubkey,
}

impl PendingTokenAuthority {
    pub const SEED_PREFIX: &'static [u8] = b"pending_token_authority";
}
