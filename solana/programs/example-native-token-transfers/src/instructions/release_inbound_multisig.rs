use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use ntt_messages::mode::Mode;
use spl_token_2022::onchain;

use crate::{
    config::*,
    error::NTTError,
    queue::inbox::{InboxItem, ReleaseStatus},
};

#[derive(Accounts)]
pub struct ReleaseInboundMultisig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: NotPausedConfig<'info>,

    #[account(mut)]
    pub inbox_item: Account<'info, InboxItem>,

    #[account(
        mut,
        associated_token::authority = inbox_item.recipient_address,
        associated_token::mint = mint,
        associated_token::token_program = token_program,
    )]
    pub recipient: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// CHECK: multisig account should be mint authority
    #[account(constraint = mint.mint_authority.unwrap() == multisig.key())]
    pub multisig: UncheckedAccount<'info>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK The seeds constraint ensures that this is the correct address
    pub token_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = config.mint,
    )]
    /// CHECK: the mint address matches the config
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,

    /// CHECK: the token program checks if this indeed the right authority for the mint
    #[account(
        mut,
        address = config.custody
    )]
    pub custody: InterfaceAccount<'info, token_interface::TokenAccount>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct ReleaseInboundMultisigArgs {
    pub revert_on_delay: bool,
}

// Burn/mint

#[derive(Accounts)]
pub struct ReleaseInboundMultisigMint<'info> {
    #[account(
        constraint = common.config.mode == Mode::Burning @ NTTError::InvalidMode,
    )]
    common: ReleaseInboundMultisig<'info>,
}

/// Release an inbound transfer and mint the tokens to the recipient.
/// When `revert_on_error` is true, the transaction will revert if the
/// release timestamp has not been reached. When `revert_on_error` is false, the
/// transaction succeeds, but the minting is not performed.
/// Setting this flag to `false` is useful when bundling this instruction
/// together with [`crate::instructions::redeem`] in a transaction, so that the minting
/// is attempted optimistically.
pub fn release_inbound_multisig_mint<'info>(
    ctx: Context<'_, '_, '_, 'info, ReleaseInboundMultisigMint<'info>>,
    args: ReleaseInboundMultisigArgs,
) -> Result<()> {
    let inbox_item = &mut ctx.accounts.common.inbox_item;

    let released = inbox_item.try_release()?;

    if !released {
        if args.revert_on_delay {
            return Err(NTTError::CantReleaseYet.into());
        } else {
            return Ok(());
        }
    }

    assert!(inbox_item.release_status == ReleaseStatus::Released);

    // NOTE: minting tokens is a two-step process:
    // 1. Mint tokens to the custody account
    // 2. Transfer the tokens from the custody account to the recipient
    //
    // This is done to ensure that if the token has a transfer hook defined, it
    // will be called after the tokens are minted.
    // Unfortunately the Token2022 program doesn't trigger transfer hooks when
    // minting tokens, so we have to do it "manually" via a transfer.
    //
    // If we didn't do this, transfer hooks could be bypassed by transferring
    // the tokens out through NTT first, then back in to the intended recipient.
    //
    // The [`transfer_burn`] function operates in a similar way
    // (transfer to custody from sender, *then* burn).

    // Step 1: mint tokens to the custody account
    let ix = spl_token_2022::instruction::mint_to(
        &ctx.accounts.common.token_program.key(),
        &ctx.accounts.common.mint.key(),
        &ctx.accounts.common.custody.key(),
        &ctx.accounts.common.multisig.key(),
        &[&ctx.accounts.common.token_authority.key()],
        inbox_item.amount,
    )?;
    solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.common.custody.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.accounts.common.multisig.to_account_info(),
        ],
        &[&[
            crate::TOKEN_AUTHORITY_SEED,
            &[ctx.bumps.common.token_authority],
        ]],
    )?;

    // Step 2: transfer the tokens from the custody account to the recipient
    onchain::invoke_transfer_checked(
        &ctx.accounts.common.token_program.key(),
        ctx.accounts.common.custody.to_account_info(),
        ctx.accounts.common.mint.to_account_info(),
        ctx.accounts.common.recipient.to_account_info(),
        ctx.accounts.common.token_authority.to_account_info(),
        ctx.remaining_accounts,
        inbox_item.amount,
        ctx.accounts.common.mint.decimals,
        &[&[
            crate::TOKEN_AUTHORITY_SEED,
            &[ctx.bumps.common.token_authority],
        ]],
    )?;
    Ok(())
}
