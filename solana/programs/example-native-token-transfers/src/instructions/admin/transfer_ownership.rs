use anchor_lang::prelude::*;
use wormhole_solana_utils::cpi::bpf_loader_upgradeable::{self, BpfLoaderUpgradeable};

#[cfg(feature = "idl-build")]
use crate::messages::Hack;

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
#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    #[account(
        mut,
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    /// CHECK: This account will be the signer in the [claim_ownership] instruction.
    new_owner: UncheckedAccount<'info>,

    #[account(
        seeds = [b"upgrade_lock"],
        bump,
    )]
    /// CHECK: The seeds constraint enforces that this is the correct address
    upgrade_lock: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable_program,
    )]
    program_data: Account<'info, ProgramData>,

    bpf_loader_upgradeable_program: Program<'info, BpfLoaderUpgradeable>,
}

pub fn transfer_ownership(ctx: Context<TransferOwnership>) -> Result<()> {
    ctx.accounts.config.pending_owner = Some(ctx.accounts.new_owner.key());

    // only transfer authority when the authority is not already the upgrade lock
    if ctx.accounts.program_data.upgrade_authority_address != Some(ctx.accounts.upgrade_lock.key())
    {
        bpf_loader_upgradeable::set_upgrade_authority_checked(
            CpiContext::new_with_signer(
                ctx.accounts
                    .bpf_loader_upgradeable_program
                    .to_account_info(),
                bpf_loader_upgradeable::SetUpgradeAuthorityChecked {
                    program_data: ctx.accounts.program_data.to_account_info(),
                    current_authority: ctx.accounts.owner.to_account_info(),
                    new_authority: ctx.accounts.upgrade_lock.to_account_info(),
                },
                &[&[b"upgrade_lock", &[ctx.bumps.upgrade_lock]]],
            ),
            &crate::ID,
        )
    } else {
        Ok(())
    }
}

pub fn transfer_ownership_one_step_unchecked(ctx: Context<TransferOwnership>) -> Result<()> {
    ctx.accounts.config.pending_owner = None;
    ctx.accounts.config.owner = ctx.accounts.new_owner.key();

    // NOTE: unlike in `transfer_ownership`, we use the unchecked version of the
    // `set_upgrade_authority` instruction here. The checked version requires
    // the new owner to be a signer, which is what we want to avoid here.
    bpf_loader_upgradeable::set_upgrade_authority(
        CpiContext::new(
            ctx.accounts
                .bpf_loader_upgradeable_program
                .to_account_info(),
            bpf_loader_upgradeable::SetUpgradeAuthority {
                program_data: ctx.accounts.program_data.to_account_info(),
                current_authority: ctx.accounts.owner.to_account_info(),
                new_authority: Some(ctx.accounts.new_owner.to_account_info()),
            },
        ),
        &crate::ID,
    )
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

    #[account(
        seeds = [b"upgrade_lock"],
        bump,
    )]
    /// CHECK: The seeds constraint enforces that this is the correct address
    upgrade_lock: UncheckedAccount<'info>,

    pub new_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable_program,
    )]
    program_data: Account<'info, ProgramData>,

    bpf_loader_upgradeable_program: Program<'info, BpfLoaderUpgradeable>,
}

pub fn claim_ownership(ctx: Context<ClaimOwnership>) -> Result<()> {
    ctx.accounts.config.pending_owner = None;
    ctx.accounts.config.owner = ctx.accounts.new_owner.key();

    bpf_loader_upgradeable::set_upgrade_authority_checked(
        CpiContext::new_with_signer(
            ctx.accounts
                .bpf_loader_upgradeable_program
                .to_account_info(),
            bpf_loader_upgradeable::SetUpgradeAuthorityChecked {
                program_data: ctx.accounts.program_data.to_account_info(),
                current_authority: ctx.accounts.upgrade_lock.to_account_info(),
                new_authority: ctx.accounts.new_owner.to_account_info(),
            },
            &[&[b"upgrade_lock", &[ctx.bumps.upgrade_lock]]],
        ),
        &crate::ID,
    )
}
