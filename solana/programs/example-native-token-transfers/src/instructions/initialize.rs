use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token_interface};
use ntt_messages::{chain_id::ChainId, mode::Mode};
use wormhole_solana_utils::cpi::bpf_loader_upgradeable::BpfLoaderUpgradeable;

#[cfg(feature = "idl-build")]
use crate::messages::Hack;

use crate::{
    bitmap::Bitmap,
    config::Config,
    error::NTTError,
    queue::{outbox::OutboxRateLimit, rate_limit::RateLimitState},
    spl_multisig::SplMultisig,
};

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(address = program_data.upgrade_authority_address.unwrap_or_default())]
    pub deployer: Signer<'info>,

    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable_program,
    )]
    program_data: Account<'info, ProgramData>,

    #[account(
        init,
        space = 8 + Config::INIT_SPACE,
        payer = payer,
        seeds = [Config::SEED_PREFIX],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        constraint = args.mode == Mode::Locking
            || mint.mint_authority.unwrap() == multisig_token_authority.as_ref().map_or(
                token_authority.key(),
                |multisig_token_authority| multisig_token_authority.key()
            ) @ NTTError::InvalidMintAuthority
    )]
    pub mint: Box<InterfaceAccount<'info, token_interface::Mint>>,

    #[account(
        init,
        payer = payer,
        space = 8 + OutboxRateLimit::INIT_SPACE,
        seeds = [OutboxRateLimit::SEED_PREFIX],
        bump,
    )]
    pub rate_limit: Account<'info, OutboxRateLimit>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK: [`token_authority`] is checked against the custody account and the [`mint`]'s mint_authority
    /// In any case, this function is used to set the Config and initialize the program so we
    /// assume the caller of this function will have total control over the program.
    ///
    /// TODO: Using `UncheckedAccount` here leads to "Access violation in stack frame ...".
    /// Could refactor code to use `Box<_>` to reduce stack size.
    pub token_authority: AccountInfo<'info>,

    #[account(
        constraint = multisig_token_authority.m == 1
            && multisig_token_authority.signers.contains(&token_authority.key())
            @ NTTError::InvalidMultisig,
    )]
    pub multisig_token_authority: Option<Box<InterfaceAccount<'info, SplMultisig>>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = token_authority,
        associated_token::token_program = token_program,
    )]
    /// The custody account that holds tokens in locking mode and temporarily
    /// holds tokens in burning mode.
    /// CHECK: Use init_if_needed here to prevent a denial-of-service of the [`initialize`]
    /// function if the token account has already been created.
    pub custody: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// CHECK: checked to be the appropriate token program when initialising the
    /// associated token account for the given mint.
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    bpf_loader_upgradeable_program: Program<'info, BpfLoaderUpgradeable>,

    system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeArgs {
    pub chain_id: u16,
    pub limit: u64,
    pub mode: ntt_messages::mode::Mode,
}

pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    initialize_config_and_rate_limit(
        ctx.accounts,
        ctx.bumps.config,
        args.chain_id,
        args.limit,
        args.mode,
    )
}

fn initialize_config_and_rate_limit(
    common: &mut Initialize<'_>,
    config_bump: u8,
    chain_id: u16,
    limit: u64,
    mode: ntt_messages::mode::Mode,
) -> Result<()> {
    common.config.set_inner(crate::config::Config {
        bump: config_bump,
        mint: common.mint.key(),
        token_program: common.token_program.key(),
        mode,
        chain_id: ChainId { id: chain_id },
        owner: common.deployer.key(),
        pending_owner: None,
        paused: false,
        next_transceiver_id: 0,
        // NOTE: can be changed via `set_threshold` ix
        threshold: 1,
        enabled_transceivers: Bitmap::new(),
        custody: common.custody.key(),
    });

    common.rate_limit.set_inner(OutboxRateLimit {
        rate_limit: RateLimitState::new(limit),
    });

    Ok(())
}
