use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;

cfg_if::cfg_if! {
    if #[cfg(feature = "bridge-address-from-env")] {
        use wormhole_svm_definitions::env_pubkey;
        pub const WORMHOLE_GOVERNANCE_ID_ARRAY: [u8; 32] = env_pubkey!("GOVERNANCE_PROGRAM_ID");
    } else {
        use const_crypto::bs58;
        pub const WORMHOLE_GOVERNANCE_ID_ARRAY: [u8; 32] = bs58::decode_pubkey("NGoD1yTeq5KaURrZo7MnCTFzTA4g62ygakJCnzMLCfm");
    }
}

declare_id!(solana_program::pubkey::Pubkey::new_from_array(WORMHOLE_GOVERNANCE_ID_ARRAY));

use instructions::*;

#[program]
pub mod wormhole_governance {
    use super::*;

    pub fn governance<'info>(ctx: Context<'_, '_, '_, 'info, Governance<'info>>) -> Result<()> {
        instructions::governance(ctx)
    }
}
