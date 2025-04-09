use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use ntt_messages::mode::Mode;
use spl_token_2022::onchain;

use crate::{
    config::*,
    error::NTTError,
    queue::inbox::{InboxItem, ReleaseStatus},
    spl_multisig::SplMultisig,
};

#[derive(Accounts)]
pub struct ReleaseInbound<'info> {
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
pub struct ReleaseInboundArgs {
    pub revert_when_not_ready: bool,
}

// Burn/mint

#[derive(Accounts)]
pub struct ReleaseInboundMint<'info> {
    #[account(
        constraint = common.config.mode == Mode::Burning @ NTTError::InvalidMode,
    )]
    common: ReleaseInbound<'info>,

    #[account(
        constraint = multisig_token_authority.m == 1
            && multisig_token_authority.signers.contains(&common.token_authority.key())
            @ NTTError::InvalidMultisig,
    )]
    pub multisig_token_authority: Option<InterfaceAccount<'info, SplMultisig>>,
}

/// Release an inbound transfer and mint the tokens to the recipient.
/// When `revert_when_not_ready` is true, the transaction will revert if the
/// release timestamp has not been reached. When `revert_when_not_ready` is false, the
/// transaction succeeds, but the minting is not performed.
/// Setting this flag to `false` is useful when bundling this instruction
/// together with [`crate::instructions::redeem`] in a transaction, so that the minting
/// is attempted optimistically.
pub fn release_inbound_mint<'info>(
    ctx: Context<'_, '_, '_, 'info, ReleaseInboundMint<'info>>,
    args: ReleaseInboundArgs,
) -> Result<()> {
    let inbox_item = release_inbox_item(
        &mut ctx.accounts.common.inbox_item,
        args.revert_when_not_ready,
    )?;
    if inbox_item.is_none() {
        return Ok(());
    }
    let inbox_item = inbox_item.unwrap();
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

    let token_authority_sig: &[&[&[u8]]] = &[&[
        crate::TOKEN_AUTHORITY_SEED,
        &[ctx.bumps.common.token_authority],
    ]];

    // Step 1: mint tokens to the custody account
    match &ctx.accounts.multisig_token_authority {
        Some(multisig_token_authority) => mint_to_custody_from_multisig_token_authority(
            ctx.accounts.common.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            ctx.accounts.common.custody.to_account_info(),
            multisig_token_authority.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            token_authority_sig,
            inbox_item.amount,
        )?,
        None => mint_to_custody_from_token_authority(
            ctx.accounts.common.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            ctx.accounts.common.custody.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            token_authority_sig,
            inbox_item.amount,
        )?,
    };

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
        token_authority_sig,
    )?;
    Ok(())
}

fn mint_to_custody_from_token_authority<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    custody: AccountInfo<'info>,
    token_authority: AccountInfo<'info>,
    token_authority_signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token_interface::mint_to(
        CpiContext::new_with_signer(
            token_program,
            token_interface::MintTo {
                mint,
                to: custody,
                authority: token_authority,
            },
            token_authority_signer_seeds,
        ),
        amount,
    )?;
    Ok(())
}

fn mint_to_custody_from_multisig_token_authority<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    custody: AccountInfo<'info>,
    multisig_token_authority: AccountInfo<'info>,
    token_authority: AccountInfo<'info>,
    token_authority_signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    solana_program::program::invoke_signed(
        &spl_token_2022::instruction::mint_to(
            &token_program.key(),
            &mint.key(),
            &custody.key(),
            &multisig_token_authority.key(),
            &[&token_authority.key()],
            amount,
        )?,
        &[custody, mint, token_authority, multisig_token_authority],
        token_authority_signer_seeds,
    )?;
    Ok(())
}

// Lock/unlock

#[derive(Accounts)]
pub struct ReleaseInboundUnlock<'info> {
    #[account(
        constraint = common.config.mode == Mode::Locking @ NTTError::InvalidMode,
    )]
    common: ReleaseInbound<'info>,
}

/// Release an inbound transfer and unlock the tokens to the recipient.
/// When `revert_when_not_ready` is true, the transaction will revert if the
/// release timestamp has not been reached. When `revert_when_not_ready` is false, the
/// transaction succeeds, but the unlocking is not performed.
/// Setting this flag to `false` is useful when bundling this instruction
/// together with [`crate::instructions::redeem`], so that the unlocking
/// is attempted optimistically.
pub fn release_inbound_unlock<'info>(
    ctx: Context<'_, '_, '_, 'info, ReleaseInboundUnlock<'info>>,
    args: ReleaseInboundArgs,
) -> Result<()> {
    let inbox_item = release_inbox_item(
        &mut ctx.accounts.common.inbox_item,
        args.revert_when_not_ready,
    )?;
    if inbox_item.is_none() {
        return Ok(());
    }
    let inbox_item = inbox_item.unwrap();
    assert!(inbox_item.release_status == ReleaseStatus::Released);

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

fn release_inbox_item(
    inbox_item: &mut InboxItem,
    revert_when_not_ready: bool,
) -> Result<Option<&mut InboxItem>> {
    if inbox_item.try_release()? {
        Ok(Some(inbox_item))
    } else if revert_when_not_ready {
        match inbox_item.release_status {
            ReleaseStatus::NotApproved => Err(NTTError::TransferNotApproved.into()),
            ReleaseStatus::ReleaseAfter(_) => Err(NTTError::CantReleaseYet.into()),
            // Unreachable: if released, [`InboxItem::try_release`] will return an Error immediately
            // rather than Ok(bool).
            ReleaseStatus::Released => Err(NTTError::TransferAlreadyRedeemed.into()),
        }
    } else {
        Ok(None)
    }
}
