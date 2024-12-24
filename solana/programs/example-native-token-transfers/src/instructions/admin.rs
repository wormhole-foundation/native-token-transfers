use anchor_lang::prelude::*;
use anchor_spl::{token_2022::spl_token_2022::instruction::AuthorityType, token_interface};
use ntt_messages::chain_id::ChainId;
use wormhole_solana_utils::cpi::bpf_loader_upgradeable::{self, BpfLoaderUpgradeable};

#[cfg(feature = "idl-build")]
use crate::messages::Hack;

use crate::{
    config::Config,
    error::NTTError,
    peer::NttManagerPeer,
    pending_token_authority::PendingTokenAuthority,
    queue::{inbox::InboxRateLimit, outbox::OutboxRateLimit, rate_limit::RateLimitState},
    registered_transceiver::RegisteredTransceiver,
};

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

    // TODO: only transfer authority when the authority is not already the upgrade lock
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

// * Set token authority

#[derive(Accounts)]
pub struct AcceptTokenAuthority<'info> {
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

    pub current_authority: Signer<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

pub fn accept_token_authority(ctx: Context<AcceptTokenAuthority>) -> Result<()> {
    token_interface::set_authority(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token_interface::SetAuthority {
                account_or_mint: ctx.accounts.mint.to_account_info(),
                current_authority: ctx.accounts.current_authority.to_account_info(),
            },
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.token_authority.key()),
    )
}

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

    /// CHECK: This account will be the signer in the [claim_token_authority] instruction.
    pub new_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetTokenAuthorityChecked<'info> {
    #[account(
        constraint = common.token_authority.key() == common.mint.mint_authority.unwrap() @ NTTError::InvalidMintAuthority
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
            rent_payer: ctx.accounts.rent_payer.key(),
        });
    Ok(())
}

#[derive(Accounts)]
pub struct SetTokenAuthorityUnchecked<'info> {
    pub common: SetTokenAuthority<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

pub fn set_token_authority_one_step_unchecked(
    ctx: Context<SetTokenAuthorityUnchecked>,
) -> Result<()> {
    token_interface::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::SetAuthority {
                account_or_mint: ctx.accounts.common.mint.to_account_info(),
                current_authority: ctx.accounts.common.token_authority.to_account_info(),
            },
            &[&[
                crate::TOKEN_AUTHORITY_SEED,
                &[ctx.bumps.common.token_authority],
            ]],
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.common.new_authority.key()),
    )
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
    token_interface::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.common.token_program.to_account_info(),
            token_interface::SetAuthority {
                account_or_mint: ctx.accounts.common.mint.to_account_info(),
                current_authority: ctx.accounts.common.token_authority.to_account_info(),
            },
            &[&[
                crate::TOKEN_AUTHORITY_SEED,
                &[ctx.bumps.common.token_authority],
            ]],
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.new_authority.key()),
    )
}

// * Set peers

#[derive(Accounts)]
#[instruction(args: SetPeerArgs)]
pub struct SetPeer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub owner: Signer<'info>,

    #[account(
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        space = 8 + NttManagerPeer::INIT_SPACE,
        payer = payer,
        seeds = [NttManagerPeer::SEED_PREFIX, args.chain_id.id.to_be_bytes().as_ref()],
        bump
    )]
    pub peer: Account<'info, NttManagerPeer>,

    #[account(
        init_if_needed,
        space = 8 + InboxRateLimit::INIT_SPACE,
        payer = payer,
        seeds = [
            InboxRateLimit::SEED_PREFIX,
            args.chain_id.id.to_be_bytes().as_ref()
        ],
        bump,
    )]
    pub inbox_rate_limit: Account<'info, InboxRateLimit>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct SetPeerArgs {
    pub chain_id: ChainId,
    pub address: [u8; 32],
    pub limit: u64,
    /// The token decimals on the peer chain.
    pub token_decimals: u8,
}

pub fn set_peer(ctx: Context<SetPeer>, args: SetPeerArgs) -> Result<()> {
    ctx.accounts.peer.set_inner(NttManagerPeer {
        bump: ctx.bumps.peer,
        address: args.address,
        token_decimals: args.token_decimals,
    });

    ctx.accounts.inbox_rate_limit.set_inner(InboxRateLimit {
        bump: ctx.bumps.inbox_rate_limit,
        rate_limit: RateLimitState::new(args.limit),
    });
    Ok(())
}

// * Register transceivers

#[derive(Accounts)]
pub struct RegisterTransceiver<'info> {
    #[account(
        mut,
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(executable)]
    /// CHECK: transceiver is meant to be a transceiver program. Arguably a `Program` constraint could be
    /// used here that wraps the Transceiver account type.
    pub transceiver: UncheckedAccount<'info>,

    #[account(
        init,
        space = 8 + RegisteredTransceiver::INIT_SPACE,
        payer = payer,
        seeds = [RegisteredTransceiver::SEED_PREFIX, transceiver.key().as_ref()],
        bump
    )]
    pub registered_transceiver: Account<'info, RegisteredTransceiver>,

    pub system_program: Program<'info, System>,
}

pub fn register_transceiver(ctx: Context<RegisterTransceiver>) -> Result<()> {
    let id = ctx.accounts.config.next_transceiver_id;
    ctx.accounts.config.next_transceiver_id += 1;
    ctx.accounts
        .registered_transceiver
        .set_inner(RegisteredTransceiver {
            bump: ctx.bumps.registered_transceiver,
            id,
            transceiver_address: ctx.accounts.transceiver.key(),
        });

    ctx.accounts.config.enabled_transceivers.set(id, true)?;
    Ok(())
}

// * Limit rate adjustment
#[derive(Accounts)]
pub struct SetOutboundLimit<'info> {
    #[account(
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    #[account(mut)]
    pub rate_limit: Account<'info, OutboxRateLimit>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct SetOutboundLimitArgs {
    pub limit: u64,
}

pub fn set_outbound_limit(
    ctx: Context<SetOutboundLimit>,
    args: SetOutboundLimitArgs,
) -> Result<()> {
    ctx.accounts.rate_limit.set_limit(args.limit);
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: SetInboundLimitArgs)]
pub struct SetInboundLimit<'info> {
    #[account(
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [
            InboxRateLimit::SEED_PREFIX,
            args.chain_id.id.to_be_bytes().as_ref()
        ],
        bump = rate_limit.bump
    )]
    pub rate_limit: Account<'info, InboxRateLimit>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct SetInboundLimitArgs {
    pub limit: u64,
    pub chain_id: ChainId,
}

pub fn set_inbound_limit(ctx: Context<SetInboundLimit>, args: SetInboundLimitArgs) -> Result<()> {
    ctx.accounts.rate_limit.set_limit(args.limit);
    Ok(())
}

// * Pausing
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner,
    )]
    pub config: Account<'info, Config>,
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
