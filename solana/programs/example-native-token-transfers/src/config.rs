use std::ops::{Deref, DerefMut};

use anchor_lang::prelude::*;
use ntt_messages::{chain_id::ChainId, mode::Mode};

use crate::bitmap::Bitmap;

/// This is a hack to re-export some modules that anchor generates as
/// pub(crate), as it's not possible to directly re-export a module with a
/// relaxed visibility.
/// Instead, we define public modules with the *same* name, and pub use all the
/// members of the original.
/// Within this crate, this module should not be used. Outside of this crate,
/// importing `anchor_reexports::*` achieves what we want.
pub mod anchor_reexports {
    pub mod __cpi_client_accounts_not_paused_config {
        pub use super::super::__cpi_client_accounts_not_paused_config::*;
    }

    pub mod __client_accounts_not_paused_config {
        pub use super::super::__client_accounts_not_paused_config::*;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub bump: u8,
    /// Owner of the program.
    pub owner: Pubkey,
    /// Pending next owner (before claiming ownership).
    pub pending_owner: Option<Pubkey>,
    /// Mint address of the token managed by this program.
    pub mint: Pubkey,
    /// Address of the token program (token or token22). This could always be queried
    /// from the [`mint`] account's owner, but storing it here avoids an indirection
    /// on the client side.
    pub token_program: Pubkey,
    /// The mode that this program is running in. This is used to determine
    /// whether the program is burning tokens or locking tokens.
    pub mode: Mode,
    /// The chain id of the chain that this program is running on. We don't
    /// hardcode this so that the program is deployable on any potential SVM
    /// forks.
    pub chain_id: ChainId,
    /// The next transceiver id to use when registering an transceiver.
    pub next_transceiver_id: u8,
    /// The number of transceivers that must attest to a transfer before it is
    /// accepted.
    pub threshold: u8,
    /// Bitmap of enabled transceivers.
    /// The maximum number of transceivers is equal to [`Bitmap::BITS`].
    pub enabled_transceivers: Bitmap,
    /// Pause the program. This is useful for upgrades and other maintenance.
    pub paused: bool,
    /// The custody account that holds tokens in locking mode.
    pub custody: Pubkey,
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";
}

#[derive(Accounts)]
pub struct NotPausedConfig<'info> {
    #[account(
        constraint = !config.paused @ crate::error::NTTError::Paused,
    )]
    pub config: Account<'info, Config>,
}

impl<'info> Deref for NotPausedConfig<'info> {
    type Target = Config;

    fn deref(&self) -> &Self::Target {
        &self.config
    }
}

impl<'info> DerefMut for NotPausedConfig<'info> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.config
    }
}
