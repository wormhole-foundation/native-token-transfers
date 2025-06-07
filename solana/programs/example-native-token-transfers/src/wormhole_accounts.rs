use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole;

use crate::error::NTTError;

/// This is a hack to re-export some modules that anchor generates as
/// pub(crate), as it's not possible to directly re-export a module with a
/// relaxed visibility.
/// Instead, we define public modules with the *same* name, and pub use all the
/// members of the original.
/// Within this crate, this module should not be used. Outside of this crate,
/// importing `anchor_reexports::*` achieves what we want.
pub mod anchor_reexports {
    pub mod __cpi_client_accounts_wormhole_accounts {
        pub use super::super::__cpi_client_accounts_wormhole_accounts::*;
    }

    pub mod __client_accounts_wormhole_accounts {
        pub use super::super::__client_accounts_wormhole_accounts::*;
    }
}

#[derive(Accounts)]
pub struct WormholeAccounts<'info> {
    // wormhole stuff
    #[account(mut)]
    /// CHECK: address will be checked by the wormhole core bridge
    pub bridge: Account<'info, wormhole::BridgeData>,

    #[account(mut)]
    /// CHECK: account will be checked by the wormhole core bridge
    pub fee_collector: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: account will be checked and maybe initialized by the wormhole core bridge
    pub sequence: UncheckedAccount<'info>,

    pub program: Program<'info, wormhole::program::Wormhole>,

    pub system_program: Program<'info, System>,

    // legacy
    pub clock: Sysvar<'info, Clock>,
    pub rent: Sysvar<'info, Rent>,

    // wormhole transceiver
    #[account(
        executable,
        constraint = transceiver.key() != Pubkey::default() @ NTTError::InvalidTransceiverProgram
    )]
    /// CHECK: transceiver is meant to be a transceiver program.
    pub transceiver: UncheckedAccount<'info>,

    #[account(
        seeds = [b"emitter"],
        seeds::program = transceiver.key(),
        bump,
    )]
    /// CHECK: The seeds constraint enforces that this is the correct address
    pub emitter: UncheckedAccount<'info>,
}

pub fn pay_wormhole_fee<'info>(
    wormhole: &WormholeAccounts<'info>,
    payer: &AccountInfo<'info>,
) -> Result<()> {
    if wormhole.bridge.fee() > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                wormhole.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: payer.to_account_info(),
                    to: wormhole.fee_collector.to_account_info(),
                },
            ),
            wormhole.bridge.fee(),
        )?;
    }

    Ok(())
}
