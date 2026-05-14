use anchor_lang::prelude::*;

use crate::{
    config::NotPausedConfig,
    queue::{inbox::InboxRateLimit, outbox::OutboxRateLimit},
};

#[derive(Accounts)]
pub struct SetRateLimitDuration<'info> {
    #[account(
        has_one = owner,
    )]
    pub config: NotPausedConfig<'info>,

    pub owner: Signer<'info>,

    #[account(mut)]
    pub outbox_rate_limit: Account<'info, OutboxRateLimit>,
}

/// Sets the rate limit duration (in seconds) for the outbound rate limiter.
/// This controls how long it takes for the rate limit capacity to fully replenish.
/// Default: 86400 (24 hours), matching EVM and Sui defaults.
///
/// To align rate limit durations across chains, set this to match the EVM
/// deployment's configured duration.
pub fn set_rate_limit_duration(ctx: Context<SetRateLimitDuration>, duration: i64) -> Result<()> {
    ctx.accounts.outbox_rate_limit.set_duration(duration);
    Ok(())
}
