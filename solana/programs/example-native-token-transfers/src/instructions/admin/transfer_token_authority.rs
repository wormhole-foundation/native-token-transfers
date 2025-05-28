use anchor_lang::prelude::*;
use anchor_spl::{token_2022::spl_token_2022::instruction::AuthorityType, token_interface};

use crate::{
    config::Config, error::NTTError, pending_token_authority::PendingTokenAuthority,
    spl_multisig::SplMultisig,
};

// * Accept token authority

#[derive(Accounts)]
pub struct AcceptTokenAuthorityBase<'info> {
    #[account(
        has_one = mint,
        constraint = config.paused @ NTTError::NotPaused,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK: The constraints enforce this is valid mint authority
    pub token_authority: UncheckedAccount<'info>,

    #[account(
        constraint = multisig_token_authority.m == 1
            && multisig_token_authority.signers.contains(&token_authority.key())
            @ NTTError::InvalidMultisig,
    )]
    pub multisig_token_authority: Option<InterfaceAccount<'info, SplMultisig>>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

#[derive(Accounts)]
pub struct AcceptTokenAuthority<'info> {
    pub common: AcceptTokenAuthorityBase<'info>,

    pub current_authority: Signer<'info>,
}

pub fn accept_token_authority(ctx: Context<AcceptTokenAuthority>) -> Result<()> {
    token_interface::set_authority(
        CpiContext::new(
            ctx.accounts.common.token_program.to_account_info(),
            token_interface::SetAuthority {
                account_or_mint: ctx.accounts.common.mint.to_account_info(),
                current_authority: ctx.accounts.current_authority.to_account_info(),
            },
        ),
        AuthorityType::MintTokens,
        Some(match &ctx.accounts.common.multisig_token_authority {
            Some(multisig_token_authority) => multisig_token_authority.key(),
            None => ctx.accounts.common.token_authority.key(),
        }),
    )
}

#[derive(Accounts)]
pub struct AcceptTokenAuthorityFromMultisig<'info> {
    pub common: AcceptTokenAuthorityBase<'info>,

    /// CHECK: The remaining accounts are treated as required signers for the multisig
    pub current_multisig_authority: InterfaceAccount<'info, SplMultisig>,
}

pub fn accept_token_authority_from_multisig<'info>(
    ctx: Context<'_, '_, '_, 'info, AcceptTokenAuthorityFromMultisig<'info>>,
) -> Result<()> {
    let new_authority = match &ctx.accounts.common.multisig_token_authority {
        Some(multisig_token_authority) => multisig_token_authority.to_account_info(),
        None => ctx.accounts.common.token_authority.to_account_info(),
    };

    let mut signer_pubkeys: Vec<&Pubkey> = Vec::new();
    let mut account_infos = vec![
        ctx.accounts.common.mint.to_account_info(),
        new_authority.clone(),
        ctx.accounts.current_multisig_authority.to_account_info(),
    ];

    // pass ctx.remaining_accounts as required signers
    {
        signer_pubkeys.extend(ctx.remaining_accounts.iter().map(|x| x.key));
        account_infos.extend_from_slice(ctx.remaining_accounts);
    }

    solana_program::program::invoke(
        &spl_token_2022::instruction::set_authority(
            &ctx.accounts.common.token_program.key(),
            &ctx.accounts.common.mint.key(),
            Some(&new_authority.key()),
            spl_token_2022::instruction::AuthorityType::MintTokens,
            &ctx.accounts.current_multisig_authority.key(),
            &signer_pubkeys,
        )?,
        account_infos.as_slice(),
    )?;
    Ok(())
}

// * Set token authority

#[derive(Accounts)]
pub struct SetTokenAuthority<'info> {
    #[account(
        has_one = owner,
        has_one = mint,
        constraint = config.paused @ NTTError::NotPaused,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK: The constraints enforce this is valid mint authority
    pub token_authority: UncheckedAccount<'info>,

    #[account(
        constraint = multisig_token_authority.m == 1
            && multisig_token_authority.signers.contains(&token_authority.key())
            @ NTTError::InvalidMultisig,
    )]
    pub multisig_token_authority: Option<InterfaceAccount<'info, SplMultisig>>,

    /// CHECK: This account will be the signer in the [claim_token_authority] instruction.
    pub new_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetTokenAuthorityUnchecked<'info> {
    pub common: SetTokenAuthority<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

pub fn set_token_authority_one_step_unchecked(
    ctx: Context<SetTokenAuthorityUnchecked>,
) -> Result<()> {
    match &ctx.accounts.common.multisig_token_authority {
        Some(multisig_token_authority) => claim_from_multisig_token_authority(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            multisig_token_authority.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.bumps.common.token_authority,
            ctx.accounts.common.new_authority.key(),
        ),
        None => claim_from_token_authority(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.bumps.common.token_authority,
            ctx.accounts.common.new_authority.key(),
        ),
    }
}

#[derive(Accounts)]
pub struct SetTokenAuthorityChecked<'info> {
    #[account(
        constraint =
            common.mint.mint_authority.unwrap() == common.multisig_token_authority.as_ref().map_or(
                common.token_authority.key(),
                |multisig_token_authority| multisig_token_authority.key()
            )
            @ NTTError::InvalidMintAuthority
    )]
    pub common: SetTokenAuthority<'info>,

    #[account(mut)]
    pub rent_payer: Signer<'info>,

    #[account(
        init_if_needed,
        space = 8 + PendingTokenAuthority::INIT_SPACE,
        payer = rent_payer,
        seeds = [PendingTokenAuthority::SEED_PREFIX],
        bump
     )]
    pub pending_token_authority: Account<'info, PendingTokenAuthority>,

    pub system_program: Program<'info, System>,
}

pub fn set_token_authority(ctx: Context<SetTokenAuthorityChecked>) -> Result<()> {
    ctx.accounts
        .pending_token_authority
        .set_inner(PendingTokenAuthority {
            bump: ctx.bumps.pending_token_authority,
            pending_authority: ctx.accounts.common.new_authority.key(),
            rent_payer: if ctx.accounts.pending_token_authority.rent_payer != Pubkey::default() {
                // do not update rent_payer if already initialized
                ctx.accounts.pending_token_authority.rent_payer
            } else {
                ctx.accounts.rent_payer.key()
            },
        });
    Ok(())
}

// * Claim token authority

#[derive(Accounts)]
pub struct ClaimTokenAuthorityBase<'info> {
    #[account(
        has_one = mint,
        constraint = config.paused @ NTTError::NotPaused,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK: The seeds constraint enforces that this is the correct address
    pub token_authority: UncheckedAccount<'info>,

    #[account(
        constraint = multisig_token_authority.m == 1
            && multisig_token_authority.signers.contains(&token_authority.key())
            @ NTTError::InvalidMultisig,
    )]
    pub multisig_token_authority: Option<InterfaceAccount<'info, SplMultisig>>,

    #[account(mut)]
    /// CHECK: the `pending_token_authority` constraint enforces that this is the correct address
    pub rent_payer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [PendingTokenAuthority::SEED_PREFIX],
        bump = pending_token_authority.bump,
        has_one = rent_payer @ NTTError::IncorrectRentPayer,
        close = rent_payer
     )]
    pub pending_token_authority: Account<'info, PendingTokenAuthority>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevertTokenAuthority<'info> {
    pub common: ClaimTokenAuthorityBase<'info>,

    #[account(
        // there is no custom error thrown as this is usually checked via `has_one` on the config
        address = common.config.owner
    )]
    pub owner: Signer<'info>,
}

pub fn revert_token_authority(_ctx: Context<RevertTokenAuthority>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimTokenAuthority<'info> {
    pub common: ClaimTokenAuthorityBase<'info>,

    #[account(
        address = common.pending_token_authority.pending_authority @ NTTError::InvalidPendingTokenAuthority
    )]
    pub new_authority: Signer<'info>,
}

pub fn claim_token_authority(ctx: Context<ClaimTokenAuthority>) -> Result<()> {
    match &ctx.accounts.common.multisig_token_authority {
        Some(multisig_token_authority) => claim_from_multisig_token_authority(
            ctx.accounts.common.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            multisig_token_authority.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.bumps.common.token_authority,
            ctx.accounts.new_authority.key(),
        ),
        None => claim_from_token_authority(
            ctx.accounts.common.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.bumps.common.token_authority,
            ctx.accounts.new_authority.key(),
        ),
    }
}

#[derive(Accounts)]
pub struct ClaimTokenAuthorityToMultisig<'info> {
    pub common: ClaimTokenAuthorityBase<'info>,

    #[account(
        address = common.pending_token_authority.pending_authority @ NTTError::InvalidPendingTokenAuthority
    )]
    /// CHECK: The remaining accounts are treated as required signers for the multisig to be validated
    pub new_multisig_authority: InterfaceAccount<'info, SplMultisig>,
}

pub fn claim_token_authority_to_multisig(
    ctx: Context<ClaimTokenAuthorityToMultisig>,
) -> Result<()> {
    // SPL Multisig cannot be a Signer so we simulate multisig signing using ctx.remaining_accounts as
    // required signers to validate it
    {
        let multisig = ctx.accounts.new_multisig_authority.to_account_info();
        token_interface::spl_token_2022::processor::Processor::validate_owner(
            &ctx.accounts.common.token_program.key(),
            &multisig.key(),
            &multisig,
            multisig.data_len(),
            ctx.remaining_accounts,
        )?;
    }

    match &ctx.accounts.common.multisig_token_authority {
        Some(multisig_token_authority) => claim_from_multisig_token_authority(
            ctx.accounts.common.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            multisig_token_authority.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.bumps.common.token_authority,
            ctx.accounts.new_multisig_authority.key(),
        ),
        None => claim_from_token_authority(
            ctx.accounts.common.token_program.to_account_info(),
            ctx.accounts.common.mint.to_account_info(),
            ctx.accounts.common.token_authority.to_account_info(),
            ctx.bumps.common.token_authority,
            ctx.accounts.new_multisig_authority.key(),
        ),
    }
}

fn claim_from_token_authority<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_authority: AccountInfo<'info>,
    token_authority_bump: u8,
    new_authority: Pubkey,
) -> Result<()> {
    token_interface::set_authority(
        CpiContext::new_with_signer(
            token_program,
            token_interface::SetAuthority {
                account_or_mint: mint,
                current_authority: token_authority,
            },
            &[&[crate::TOKEN_AUTHORITY_SEED, &[token_authority_bump]]],
        ),
        AuthorityType::MintTokens,
        Some(new_authority),
    )?;
    Ok(())
}

fn claim_from_multisig_token_authority<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    multisig_token_authority: AccountInfo<'info>,
    token_authority: AccountInfo<'info>,
    token_authority_bump: u8,
    new_authority: Pubkey,
) -> Result<()> {
    solana_program::program::invoke_signed(
        &spl_token_2022::instruction::set_authority(
            &token_program.key(),
            &mint.key(),
            Some(&new_authority),
            spl_token_2022::instruction::AuthorityType::MintTokens,
            &multisig_token_authority.key(),
            &[&token_authority.key()],
        )?,
        &[mint, multisig_token_authority, token_authority],
        &[&[crate::TOKEN_AUTHORITY_SEED, &[token_authority_bump]]],
    )?;
    Ok(())
}
