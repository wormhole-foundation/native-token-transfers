use anchor_lang::prelude::*;

use crate::{config::Config, error::NTTError};

// * Transfer ownership

/// For safety reasons, transferring ownership is a 2-step process. The first step is to set the
/// new owner, and the second step is for the new owner to claim the ownership.
/// This is to prevent a situation where the ownership is transferred to an
/// address that is not able to claim the ownership (by mistake).
///
/// The transfer can be cancelled by the existing owner invoking the [`claim_ownership`]
/// instruction.
///
/// Alternatively, the ownership can be transferred in a single step by calling the
/// [`transfer_ownership_one_step_unchecked`] instruction. This can be dangerous because if the new owner
/// cannot actually sign transactions (due to setting the wrong address), the program will be
/// permanently locked. If the intention is to transfer ownership to a program using this instruction,
/// take extra care to ensure that the owner is a PDA, not the program address itself.
///
/// v4 trust model: instance ownership is decoupled from the program upgrade
/// authority. Transferring instance ownership is a pure data mutation; the BPF
/// loader is never touched. Operators are expected to manage the program
/// upgrade authority separately (typically null'd or held by a multisig).
#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    #[account(
        mut,
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    /// CHECK: This account will be the signer in the [claim_ownership] instruction.
    // new_owner is not expected to interact with this instruction. Instead, they call [`claim_ownership`].
    // The intention of new_owner is that it could be an arbitrary account so no constraints are
    // required here.
    new_owner: UncheckedAccount<'info>,
}

pub fn transfer_ownership(ctx: Context<TransferOwnership>) -> Result<()> {
    ctx.accounts.config.pending_owner = Some(ctx.accounts.new_owner.key());
    Ok(())
}

pub fn transfer_ownership_one_step_unchecked(ctx: Context<TransferOwnership>) -> Result<()> {
    ctx.accounts.config.pending_owner = None;
    ctx.accounts.config.owner = ctx.accounts.new_owner.key();
    Ok(())
}

// * Claim ownership

#[derive(Accounts)]
pub struct ClaimOwnership<'info> {
    #[account(
        mut,
        constraint = (
            config.pending_owner == Some(new_owner.key())
            || config.owner == new_owner.key()
        ) @ NTTError::InvalidPendingOwner
    )]
    pub config: Account<'info, Config>,

    pub new_owner: Signer<'info>,
}

pub fn claim_ownership(ctx: Context<ClaimOwnership>) -> Result<()> {
    ctx.accounts.config.pending_owner = None;
    ctx.accounts.config.owner = ctx.accounts.new_owner.key();
    Ok(())
}
