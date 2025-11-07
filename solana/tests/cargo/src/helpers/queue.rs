use anchor_lang::prelude::{Clock, Pubkey};
use example_native_token_transfers::queue::outbox::OutboxItem;
use solana_program_test::ProgramTestContext;

use crate::common::query::GetAccountDataAnchor;

pub async fn assert_queued(ctx: &mut ProgramTestContext, outbox_item: Pubkey) {
    let outbox_item_account: OutboxItem = ctx.get_account_data_anchor(outbox_item).await;

    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();

    assert!(!outbox_item_account.released.get(0).unwrap());
    assert!(outbox_item_account.release_timestamp > clock.unix_timestamp);
}
