use example_native_token_transfers::transfer::Payload;
use ntt_messages::{ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage};
use solana_program_test::ProgramTestContext;
use solana_sdk::signer::Signer;

use crate::{
    common::fixtures::TestData,
    sdk::{accounts::NTT, instructions::redeem::Redeem, transceivers::accounts::NTTTransceiver},
};

pub fn init_redeem_accs(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    chain_id: u16,
    ntt_manager_message: NttManagerMessage<NativeTokenTransfer<Payload>>,
) -> Redeem {
    Redeem {
        payer: ctx.payer.pubkey(),
        peer: ntt.peer(chain_id),
        transceiver: ntt_transceiver.program(),
        transceiver_message: ntt_transceiver.transceiver_message(chain_id, ntt_manager_message.id),
        inbox_item: ntt.inbox_item(chain_id, ntt_manager_message),
        inbox_rate_limit: ntt.inbox_rate_limit(chain_id),
        mint: test_data.mint,
    }
}
