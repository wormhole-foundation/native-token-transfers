use anchor_lang::prelude::Clock;
use example_native_token_transfers::queue::{inbox::InboxRateLimit, outbox::OutboxRateLimit};
use solana_program_test::ProgramTestContext;

use crate::{
    common::{fixtures::OTHER_CHAIN, query::GetAccountDataAnchor},
    sdk::accounts::NTT,
};

pub async fn outbound_capacity(ntt: &NTT, ctx: &mut ProgramTestContext) -> u64 {
    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let rate_limit: OutboxRateLimit = ctx.get_account_data_anchor(ntt.outbox_rate_limit()).await;

    rate_limit.rate_limit.capacity_at(clock.unix_timestamp)
}

pub async fn inbound_capacity(ntt: &NTT, ctx: &mut ProgramTestContext) -> u64 {
    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let rate_limit: InboxRateLimit = ctx
        .get_account_data_anchor(ntt.inbox_rate_limit(OTHER_CHAIN))
        .await;

    rate_limit.rate_limit.capacity_at(clock.unix_timestamp)
}
