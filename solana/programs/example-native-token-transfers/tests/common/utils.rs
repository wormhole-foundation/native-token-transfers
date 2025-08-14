use anchor_lang::{prelude::AccountMeta, AnchorSerialize};
use example_native_token_transfers::transfer::Payload;
use ntt_messages::{
    chain_id::ChainId, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage,
    transceiver::TransceiverMessage, transceivers::wormhole::WormholeTransceiver,
    trimmed_amount::TrimmedAmount,
};
use solana_program::pubkey::Pubkey;
use solana_program_test::ProgramTestContext;
use solana_sdk::{
    inner_instruction::InnerInstruction, instruction::Instruction, signature::Keypair,
    signer::Signer,
};
use std::sync::atomic::AtomicU64;
use wormhole_sdk::{Address, Chain, Vaa};
use wormhole_svm_shim::post_message;

use crate::{
    common::submit::Submittable,
    sdk::{
        accounts::{NTTTransceiver, Wormhole, NTT},
        instructions::post_vaa::{
            get_guardian_signature, post_signatures, GUARDIAN_INDEX, GUARDIAN_SET_INDEX,
        },
    },
};

use super::setup::{OTHER_MANAGER, THIS_CHAIN};

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
    ntt_transceiver: &NTTTransceiver,
    emitter_chain: Chain,
    emitter_address: Address,
    msg: A,
    ctx: &mut ProgramTestContext,
) -> (Pubkey, u32, Vec<u8>) {
    static I: AtomicU64 = AtomicU64::new(0);

    let sequence = I.fetch_add(1, std::sync::atomic::Ordering::Acquire);

    let mut vaa = Vaa {
        version: 1,
        guardian_set_index: GUARDIAN_SET_INDEX,
        signatures: vec![],
        timestamp: 123232,
        nonce: 0,
        emitter_chain,
        emitter_address,
        sequence,
        consistency_level: 0,
        payload: msg,
    };
    vaa.signatures
        .push(get_guardian_signature(vaa.clone(), GUARDIAN_INDEX));

    let guardian_signatures = Keypair::new();
    post_signatures(ntt_transceiver, ctx, &guardian_signatures, &vaa).await;

    (
        guardian_signatures.pubkey(),
        GUARDIAN_SET_INDEX,
        vaa_body(&vaa),
    )
}

pub fn vaa_body<A: AnchorSerialize + Clone>(vaa: &Vaa<A>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&vaa.timestamp.to_be_bytes());
    bytes.extend_from_slice(&vaa.nonce.to_be_bytes());
    bytes.extend_from_slice(&u16::from(vaa.emitter_chain).to_be_bytes());
    bytes.extend_from_slice(&vaa.emitter_address.0);
    bytes.extend_from_slice(&vaa.sequence.to_be_bytes());
    bytes.push(vaa.consistency_level);
    let payload_bytes = vaa.payload.try_to_vec().unwrap();
    bytes.extend_from_slice(&payload_bytes);
    bytes
}

pub struct PostMessageShimInstructionData {
    pub nonce: u32,
    pub consistency_level: u8,
    pub payload: Vec<u8>,
}

// TODO: Figure out how to get CPI event that can be parsed to re-create the VAA message.
// `inner_instructions` is always `None` even though CPIs happen. This limits the
// testing that can be done as we can no longer parse the CPI event from it.
pub async fn get_message_data(
    wh: &Wormhole,
    ntt_transceiver: &NTTTransceiver,
    ctx: &mut ProgramTestContext,
    ix: Instruction,
) -> PostMessageShimInstructionData {
    // simulate ix
    let out = ix.simulate(ctx).await.unwrap();
    assert!(out.result.unwrap().is_ok());
    dbg!("{:?}", out.simulation_details.clone());

    let details = out.simulation_details.unwrap();

    // verify logs
    let logs = details.logs;
    let is_core_bridge_cpi_log =
        |line: &String| line.contains(format!("Program {} invoke [3]", wh.program).as_str());
    assert_eq!(
        logs.iter()
            .filter(|line| { line.contains("Program log: Sequence: 0") })
            .count(),
        1
    );
    let core_bridge_log_index = logs.iter().position(is_core_bridge_cpi_log).unwrap();
    assert_eq!(
        logs.iter()
            .skip(core_bridge_log_index)
            .filter(|line| {
                line.contains(
                    format!(
                        "Program {} invoke [3]",
                        ntt_transceiver.post_message_shim().program
                    )
                    .as_str(),
                )
            })
            .count(),
        1
    );
    // parse return data
    let ix_data = details.return_data.unwrap().data;
    // 8-byte instruction discriminator
    let nonce = u32::from_le_bytes(ix_data[8..12].try_into().unwrap());
    let consistency_level: u8 = ix_data[12];
    // 4-byte Vec length
    let payload = ix_data[17..].to_vec();

    PostMessageShimInstructionData {
        nonce,
        consistency_level,
        payload,
    }
}
