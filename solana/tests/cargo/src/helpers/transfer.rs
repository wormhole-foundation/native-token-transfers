use anchor_lang::prelude::Pubkey;
use example_native_token_transfers::instructions::TransferArgs;
use example_native_token_transfers::transfer::Payload;
use ntt_messages::{
    chain_id::ChainId, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage,
    transceiver::TransceiverMessage, transceivers::wormhole::WormholeTransceiver,
    trimmed_amount::TrimmedAmount,
};
use solana_program_test::ProgramTestContext;
use solana_sdk::signer::Signer;

use crate::{
    common::fixtures::{TestData, OTHER_CHAIN, OTHER_MANAGER, THIS_CHAIN},
    sdk::{accounts::NTT, instructions::transfer::Transfer},
};

/// Helper function for setting up transfer accounts and args.
/// It sets the accounts up properly, so for negative testing we just modify the
/// result.
pub fn init_transfer_accs_args(
    ntt: &NTT,
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    outbox_item: Pubkey,
    amount: u64,
    should_queue: bool,
) -> (Transfer, TransferArgs) {
    let accs = Transfer {
        payer: ctx.payer.pubkey(),
        mint: test_data.mint,
        from: test_data.user_token_account,
        from_authority: test_data.user.pubkey(),
        peer: ntt.peer(OTHER_CHAIN),
        outbox_item,
    };

    let args = TransferArgs {
        amount,
        recipient_chain: ChainId { id: OTHER_CHAIN },
        recipient_address: [1u8; 32],
        should_queue,
    };

    (accs, args)
}

pub fn make_transfer_message(
    ntt: &NTT,
    id: [u8; 32],
    amount: u64,
    recipient: &Pubkey,
) -> TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<Payload>> {
    let ntt_manager_message = NttManagerMessage {
        id,
        sender: [4u8; 32],
        payload: NativeTokenTransfer {
            amount: TrimmedAmount {
                amount,
                decimals: 9,
            },
            source_token: [3u8; 32],
            to_chain: ChainId { id: THIS_CHAIN },
            to: recipient.to_bytes(),
            additional_payload: Payload {},
        },
    };

    TransceiverMessage::new(
        OTHER_MANAGER,
        ntt.program().to_bytes(),
        ntt_manager_message.clone(),
        vec![],
    )
}
