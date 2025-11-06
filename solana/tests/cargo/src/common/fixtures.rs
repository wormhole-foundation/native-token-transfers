use anchor_lang::prelude::Pubkey;
use solana_sdk::signature::Keypair;

use crate::sdk::accounts::Governance;

// TODO: maybe make these configurable? I think it's fine like this:
// the mint amount is more than the limits, so we can test the rate limits
pub const MINT_AMOUNT: u64 = 100000;
pub const OUTBOUND_LIMIT: u64 = 10000;
pub const INBOUND_LIMIT: u64 = 50000;

pub const OTHER_TRANSCEIVER: [u8; 32] = [7u8; 32];
pub const ANOTHER_TRANSCEIVER: [u8; 32] = [8u8; 32];
pub const OTHER_MANAGER: [u8; 32] = [9u8; 32];
pub const ANOTHER_MANAGER: [u8; 32] = [5u8; 32];

pub const THIS_CHAIN: u16 = 1;
pub const OTHER_CHAIN: u16 = 2;
pub const ANOTHER_CHAIN: u16 = 3;
pub const UNREGISTERED_CHAIN: u16 = u16::MAX;

pub struct TestData {
    pub governance: Governance,
    pub program_owner: Keypair,
    pub mint_authority: Keypair,
    pub mint: Pubkey,
    pub bad_mint_authority: Keypair,
    pub bad_mint: Pubkey,
    pub user: Keypair,
    pub user_token_account: Pubkey,
    pub bad_user_token_account: Pubkey,
}
