use anchor_lang::prelude::Pubkey;
use example_native_token_transfers::{
    config::Config, registered_transceiver::RegisteredTransceiver,
};
use solana_program_test::ProgramTestContext;

use crate::{common::query::GetAccountDataAnchor, sdk::accounts::NTT};

pub async fn assert_threshold(ntt: &NTT, ctx: &mut ProgramTestContext, expected_threshold: u8) {
    let config_account: Config = ctx.get_account_data_anchor(ntt.config()).await;
    assert_eq!(config_account.threshold, expected_threshold);
}

pub async fn assert_transceiver_id(
    ntt: &NTT,
    ctx: &mut ProgramTestContext,
    transceiver: &Pubkey,
    expected_id: u8,
) {
    let registered_transceiver_account: RegisteredTransceiver = ctx
        .get_account_data_anchor(ntt.registered_transceiver(transceiver))
        .await;
    assert_eq!(
        registered_transceiver_account.transceiver_address,
        *transceiver
    );
    assert_eq!(registered_transceiver_account.id, expected_id);
}
