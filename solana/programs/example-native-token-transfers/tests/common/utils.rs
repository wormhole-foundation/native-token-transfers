use std::sync::atomic::AtomicU64;

use anchor_lang::AnchorSerialize;
use example_native_token_transfers::transfer::Payload;
use ntt_messages::{
    chain_id::ChainId, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage,
    transceiver::TransceiverMessage, transceivers::wormhole::WormholeTransceiver,
    trimmed_amount::TrimmedAmount,
};
use solana_program::pubkey::Pubkey;
use solana_program_test::ProgramTestContext;
use wormhole_sdk::{Address, Chain, Vaa};

use crate::sdk::accounts::NTT;

use super::setup::{OTHER_MANAGER, THIS_CHAIN};
use crate::sdk::instructions::post_vaa::post_vaa;

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

pub async fn post_vaa_helper<A: AnchorSerialize + Clone>(
    ntt: &NTT,
    emitter_chain: Chain,
    emitter_address: Address,
    msg: A,
    ctx: &mut ProgramTestContext,
) -> Pubkey {
    static I: AtomicU64 = AtomicU64::new(0);

    let sequence = I.fetch_add(1, std::sync::atomic::Ordering::Acquire);

    let vaa = Vaa {
        version: 1,
        guardian_set_index: 0,
        signatures: vec![],
        timestamp: 123232,
        nonce: 0,
        emitter_chain,
        emitter_address,
        sequence,
        consistency_level: 0,
        payload: msg,
    };

    post_vaa(&ntt.wormhole(), ctx, vaa).await
}
