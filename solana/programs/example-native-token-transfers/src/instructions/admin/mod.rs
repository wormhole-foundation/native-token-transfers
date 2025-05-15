use anchor_lang::prelude::*;
use ntt_messages::chain_id::ChainId;

use crate::{
    config::Config,
    error::NTTError,
    peer::NttManagerPeer,
    queue::{inbox::InboxRateLimit, outbox::OutboxRateLimit, rate_limit::RateLimitState},
    registered_transceiver::RegisteredTransceiver,
};

pub mod transfer_ownership;
pub mod transfer_token_authority;

pub use transfer_ownership::*;
pub use transfer_token_authority::*;

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

    // if rate limit is uninitialized/unused, set new rate limit
    if ctx.accounts.inbox_rate_limit.rate_limit.last_tx_timestamp == 0 {
        ctx.accounts.inbox_rate_limit.set_inner(InboxRateLimit {
            bump: ctx.bumps.inbox_rate_limit,
            rate_limit: RateLimitState::new(args.limit),
        });
    }
    // else update rate limit
    else {
        ctx.accounts.inbox_rate_limit.set_limit(args.limit);
    }

    Ok(())
}

// * Transceiver registration

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

    #[account(
        executable,
        constraint = transceiver.key() != Pubkey::default() @ NTTError::InvalidTransceiverProgram
    )]
    /// CHECK: transceiver is meant to be a transceiver program. Arguably a `Program` constraint could be
    /// used here that wraps the Transceiver account type.
    pub transceiver: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        space = 8 + RegisteredTransceiver::INIT_SPACE,
        payer = payer,
        seeds = [RegisteredTransceiver::SEED_PREFIX, transceiver.key().as_ref()],
        bump
    )]
    pub registered_transceiver: Account<'info, RegisteredTransceiver>,

    pub system_program: Program<'info, System>,
}

pub fn register_transceiver(ctx: Context<RegisterTransceiver>) -> Result<()> {
    // initialize registered transceiver with new id on init
    if ctx.accounts.registered_transceiver.transceiver_address == Pubkey::default() {
        let id = ctx.accounts.config.next_transceiver_id;
        ctx.accounts.config.next_transceiver_id += 1;
        ctx.accounts
            .registered_transceiver
            .set_inner(RegisteredTransceiver {
                bump: ctx.bumps.registered_transceiver,
                id,
                transceiver_address: ctx.accounts.transceiver.key(),
            });
    }

    ctx.accounts
        .config
        .enabled_transceivers
        .set(ctx.accounts.registered_transceiver.id, true)?;
    Ok(())
}

#[derive(Accounts)]
pub struct DeregisterTransceiver<'info> {
    #[account(
        mut,
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    #[account(
        seeds = [RegisteredTransceiver::SEED_PREFIX, registered_transceiver.transceiver_address.as_ref()],
        bump,
        constraint = config.enabled_transceivers.get(registered_transceiver.id)? @ NTTError::DisabledTransceiver,
    )]
    pub registered_transceiver: Account<'info, RegisteredTransceiver>,
}

pub fn deregister_transceiver(ctx: Context<DeregisterTransceiver>) -> Result<()> {
    ctx.accounts
        .config
        .enabled_transceivers
        .set(ctx.accounts.registered_transceiver.id, false)?;

    // decrement threshold if too high
    let num_enabled_transceivers = ctx.accounts.config.enabled_transceivers.len();
    if num_enabled_transceivers < ctx.accounts.config.threshold {
        // threshold should be at least 1
        ctx.accounts.config.threshold = num_enabled_transceivers.max(1);
    }
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

// * Set Threshold

#[derive(Accounts)]
#[instruction(threshold: u8)]
pub struct SetThreshold<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner,
        constraint = threshold <= config.enabled_transceivers.len() @ NTTError::ThresholdTooHigh
    )]
    pub config: Account<'info, Config>,
}

pub fn set_threshold(ctx: Context<SetThreshold>, threshold: u8) -> Result<()> {
    if threshold == 0 {
        return Err(NTTError::ZeroThreshold.into());
    }
    ctx.accounts.config.threshold = threshold;
    Ok(())
}
