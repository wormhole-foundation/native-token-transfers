use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use ntt_messages::{mode::Mode, trimmed_amount::TrimmedAmount};
use spl_token_2022::onchain;

use crate::{
    config::*,
    error::NTTError,
    queue::outbox::OutboxItem,
};

#[derive(Accounts)]
pub struct CancelOutboundTransfer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: NotPausedConfig<'info>,

    #[account(
        mut,
        close = payer,
        constraint = outbox_item.sender == payer.key() @ NTTError::CancellerNotSender,
    )]
    pub outbox_item: Account<'info, OutboxItem>,

    #[account(
        mut,
        address = config.mint,
    )]
    /// CHECK: the mint address matches the config
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(
        mut,
        address = config.custody,
    )]
    pub custody: InterfaceAccount<'info, token_interface::TokenAccount>,

    #[account(
        mut,
        associated_token::authority = payer,
        associated_token::mint = mint,
        associated_token::token_program = token_program,
    )]
    pub sender_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK: The seeds constraint ensures this is the correct address
    pub token_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,

    pub system_program: Program<'info, System>,
}

/// Cancel a queued outbound transfer and refund tokens to the sender.
///
/// Only the original sender can cancel their transfer. Transfers that have
/// already been picked up by a transceiver (i.e. `released` is non-empty)
/// cannot be cancelled.
///
/// In BURNING mode: mints new tokens to custody, then transfers to sender.
/// In LOCKING mode: transfers tokens from custody back to sender.
///
/// This closes the outbox_item account and returns rent to the payer.
pub fn cancel_outbound_transfer<'info>(
    ctx: Context<'_, '_, '_, 'info, CancelOutboundTransfer<'info>>,
) -> Result<()> {
    let accs = ctx.accounts;

    // Verify no transceiver has released this item yet.
    // Once a transceiver has picked it up, cancel is not possible.
    if accs.outbox_item.released.count_enabled_votes(&accs.config.enabled_transceivers) > 0 {
        return Err(NTTError::MessageAlreadySent.into());
    }

    let amount = accs.outbox_item.amount.untrim(accs.mint.decimals)
        .map_err(NTTError::from)?;

    let token_authority_signer: &[&[&[u8]]] = &[&[
        crate::TOKEN_AUTHORITY_SEED,
        &[ctx.bumps.token_authority],
    ]];

    if accs.config.mode == Mode::Burning {
        // Step 1: mint tokens to the custody account
        token_interface::mint_to(
            CpiContext::new_with_signer(
                accs.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: accs.mint.to_account_info(),
                    to: accs.custody.to_account_info(),
                    authority: accs.token_authority.to_account_info(),
                },
                token_authority_signer,
            ),
            amount,
        )?;

        // Step 2: transfer tokens from custody to sender's ATA
        onchain::invoke_transfer_checked(
            &accs.token_program.key(),
            accs.custody.to_account_info(),
            accs.mint.to_account_info(),
            accs.sender_ata.to_account_info(),
            accs.token_authority.to_account_info(),
            ctx.remaining_accounts,
            amount,
            accs.mint.decimals,
            token_authority_signer,
        )?;
    } else {
        // LOCKING mode: transfer tokens from custody to sender's ATA
        onchain::invoke_transfer_checked(
            &accs.token_program.key(),
            accs.custody.to_account_info(),
            accs.mint.to_account_info(),
            accs.sender_ata.to_account_info(),
            accs.token_authority.to_account_info(),
            ctx.remaining_accounts,
            amount,
            accs.mint.decimals,
            token_authority_signer,
        )?;
    }

    Ok(())
}
