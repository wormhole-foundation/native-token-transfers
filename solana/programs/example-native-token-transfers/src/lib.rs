use anchor_lang::prelude::*;

// TODO: is there a more elegant way of checking that these 3 features are mutually exclusive?

#[cfg(all(feature = "mainnet", feature = "solana-devnet"))]
compile_error!("Cannot enable both mainnet and solana-devnet features at the same time");

#[cfg(all(feature = "mainnet", feature = "tilt-devnet"))]
compile_error!("Cannot enable both mainnet and tilt-devnet features at the same time");

#[cfg(all(feature = "solana-devnet", feature = "tilt-devnet"))]
compile_error!("Cannot enable both solana-devnet and tilt-devnet features at the same time");

pub mod bitmap;
pub mod clock;
pub mod config;
pub mod error;
pub mod instructions;
pub mod messages;
pub mod peer;
pub mod pending_token_authority;
pub mod queue;
pub mod registered_transceiver;
pub mod spl_multisig;
pub mod transfer;
pub mod wormhole_accounts;

use instructions::*;

cfg_if::cfg_if! {
    if #[cfg(feature = "tilt-devnet2")] {
        declare_id!("NTTManager222222222222222222222222222222222");
    } else if #[cfg(feature = "tilt-devnet")] {
        declare_id!("NTTManager111111111111111111111111111111111");
    } else {
        declare_id!("nttiK1SepaQt6sZ4WGW5whvc9tEnGXGxuKeptcQPCcS");
    }
}

pub const TOKEN_AUTHORITY_SEED: &[u8] = b"token_authority";

/// The seed for the session authority account.
///
/// These accounts are used in the `transfer_*` instructions. The user first
/// approves the session authority to spend the tokens, and then the session
/// authority burns or locks the tokens.
/// This is to avoid the user having to pass their own authority to the program,
/// which in general is dangerous, especially for upgradeable programs.
///
/// There is a session authority associated with each transfer, and is seeded by
/// the sender's pubkey, and (the hash of) all the transfer arguments.
/// These seeds essentially encode the user's intent when approving the
/// spending.
///
/// In practice, the approve instruction is going to be atomically bundled with
/// the transfer instruction, so this encoding makes no difference.
/// However, it does allow it to be done in a separate transaction without the
/// risk of a malicious actor redirecting the funds by frontrunning the transfer
/// instruction.
/// In other words, the transfer instruction has no degrees of freedom; all the
/// arguments are determined in the approval step. Then transfer can be
/// permissionlessly invoked by anyone (even if in practice it's going to be the
/// user, atomically).
pub const SESSION_AUTHORITY_SEED: &[u8] = b"session_authority";

pub const VERSION: &str = "3.0.0";

#[program]
pub mod example_native_token_transfers {

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize(ctx, args)
    }

    pub fn initialize_lut(ctx: Context<InitializeLUT>, recent_slot: u64) -> Result<()> {
        instructions::initialize_lut(ctx, recent_slot)
    }

    pub fn version(_ctx: Context<Version>) -> Result<String> {
        Ok(VERSION.to_string())
    }

    pub fn transfer_burn<'info>(
        ctx: Context<'_, '_, '_, 'info, TransferBurn<'info>>,
        args: TransferArgs,
    ) -> Result<()> {
        instructions::transfer_burn(ctx, args)
    }

    pub fn transfer_lock<'info>(
        ctx: Context<'_, '_, '_, 'info, TransferLock<'info>>,
        args: TransferArgs,
    ) -> Result<()> {
        instructions::transfer_lock(ctx, args)
    }

    pub fn redeem(ctx: Context<Redeem>, args: RedeemArgs) -> Result<()> {
        instructions::redeem(ctx, args)
    }

    pub fn release_inbound_mint<'info>(
        ctx: Context<'_, '_, '_, 'info, ReleaseInboundMint<'info>>,
        args: ReleaseInboundArgs,
    ) -> Result<()> {
        instructions::release_inbound_mint(ctx, args)
    }

    pub fn release_inbound_unlock<'info>(
        ctx: Context<'_, '_, '_, 'info, ReleaseInboundUnlock<'info>>,
        args: ReleaseInboundArgs,
    ) -> Result<()> {
        instructions::release_inbound_unlock(ctx, args)
    }

    pub fn transfer_ownership(ctx: Context<TransferOwnership>) -> Result<()> {
        instructions::transfer_ownership(ctx)
    }

    pub fn transfer_ownership_one_step_unchecked(ctx: Context<TransferOwnership>) -> Result<()> {
        instructions::transfer_ownership_one_step_unchecked(ctx)
    }

    pub fn claim_ownership(ctx: Context<ClaimOwnership>) -> Result<()> {
        instructions::claim_ownership(ctx)
    }

    pub fn accept_token_authority(ctx: Context<AcceptTokenAuthority>) -> Result<()> {
        instructions::accept_token_authority(ctx)
    }

    pub fn accept_token_authority_from_multisig<'info>(
        ctx: Context<'_, '_, '_, 'info, AcceptTokenAuthorityFromMultisig<'info>>,
    ) -> Result<()> {
        instructions::accept_token_authority_from_multisig(ctx)
    }

    pub fn set_token_authority_one_step_unchecked(
        ctx: Context<SetTokenAuthorityUnchecked>,
    ) -> Result<()> {
        instructions::set_token_authority_one_step_unchecked(ctx)
    }

    pub fn set_token_authority(ctx: Context<SetTokenAuthorityChecked>) -> Result<()> {
        instructions::set_token_authority(ctx)
    }

    pub fn revert_token_authority(ctx: Context<RevertTokenAuthority>) -> Result<()> {
        instructions::revert_token_authority(ctx)
    }

    pub fn claim_token_authority(ctx: Context<ClaimTokenAuthority>) -> Result<()> {
        instructions::claim_token_authority(ctx)
    }

    pub fn claim_token_authority_to_multisig(
        ctx: Context<ClaimTokenAuthorityToMultisig>,
    ) -> Result<()> {
        instructions::claim_token_authority_to_multisig(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, pause: bool) -> Result<()> {
        instructions::set_paused(ctx, pause)
    }

    pub fn set_peer(ctx: Context<SetPeer>, args: SetPeerArgs) -> Result<()> {
        instructions::set_peer(ctx, args)
    }

    pub fn register_transceiver(ctx: Context<RegisterTransceiver>) -> Result<()> {
        instructions::register_transceiver(ctx)
    }

    pub fn deregister_transceiver(ctx: Context<DeregisterTransceiver>) -> Result<()> {
        instructions::deregister_transceiver(ctx)
    }

    pub fn set_outbound_limit(
        ctx: Context<SetOutboundLimit>,
        args: SetOutboundLimitArgs,
    ) -> Result<()> {
        instructions::set_outbound_limit(ctx, args)
    }

    pub fn set_inbound_limit(
        ctx: Context<SetInboundLimit>,
        args: SetInboundLimitArgs,
    ) -> Result<()> {
        instructions::set_inbound_limit(ctx, args)
    }

    pub fn mark_outbox_item_as_released(ctx: Context<MarkOutboxItemAsReleased>) -> Result<bool> {
        instructions::mark_outbox_item_as_released(ctx)
    }

    pub fn set_threshold(ctx: Context<SetThreshold>, threshold: u8) -> Result<()> {
        instructions::set_threshold(ctx, threshold)
    }
}

// The Version struct is just a dummy type because anchor needs every function
// to have a context. When compiled in CPI mode, anchor generates code that
// assumes that the struct has a lifetime parameter. So in that mode, we bind a
// dummy lifetime parameter (and use it in a dummy account).
// When compiling normally, we don't do this, and just use an empty struct, which anchor is happy with.
#[cfg(feature = "cpi")]
#[derive(Accounts)]
pub struct Version<'info> {
    /// CHECK: refer to comment above
    pub dummy: UncheckedAccount<'info>,
}

#[cfg(not(feature = "cpi"))]
#[derive(Accounts)]
pub struct Version {}
