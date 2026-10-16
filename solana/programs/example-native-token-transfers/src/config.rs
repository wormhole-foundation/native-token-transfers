use anchor_lang::prelude::*;
use ntt_messages::{chain_id::ChainId, mode::Mode};
use std::ops::{Deref, DerefMut};

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

// TODO(v4-rename): consider renaming `Config` → `Instance` to reflect the v4
// semantics — there can be many of these per program; each is the on-the-wire
// "manager identity" for one NTT deployment. Held off for now to keep the v4
// diff small and reviewable.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Owner of this instance. Distinct from the program's upgrade authority —
    /// instance ownership transfers are pure data mutations and never touch the
    /// BPF loader (v4 trust model).
    pub owner: Pubkey,
    /// Pending next owner (before claiming ownership).
    pub pending_owner: Option<Pubkey>,
    /// Mint address of the token managed by this instance.
    pub mint: Pubkey,
    /// Address of the token program (token or token22). This could always be queried
    /// from the [`mint`] account's owner, but storing it here avoids an indirection
    /// on the client side.
    pub token_program: Pubkey,
    /// The mode that this instance is running in. This is used to determine
    /// whether the program is burning tokens or locking tokens.
    pub mode: Mode,
    /// The chain id of the chain that this program is running on. We don't
    /// hardcode this so that the program is deployable on any potential SVM
    /// forks.
    pub chain_id: ChainId,
    /// The next transceiver id to use when registering a transceiver under this instance.
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

#[derive(Accounts)]
pub struct NotPausedConfig<'info> {
    #[account(
        constraint = !config.paused @ crate::error::NTTError::Paused,
    )]
    pub config: Account<'info, Config>,
}

impl<'info> NotPausedConfig<'info> {
    /// Pass-through to the inner `Account<Config>`'s key.
    /// Useful in v4 where PDA seeds and signer-seed slices need `config.key()`.
    pub fn key(&self) -> Pubkey {
        self.config.key()
    }
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
