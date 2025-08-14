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

pub struct PostMessageShimMessageData {
    pub nonce: u32,
    pub consistency_level: u8,
    pub payload: Vec<u8>,
    pub emitter_address: Address,
    pub sequence: u64,
    pub submission_time: u32,
}

pub async fn get_message_data(
    wh: &Wormhole,
    ntt_transceiver: &NTTTransceiver,
    ctx: &mut ProgramTestContext,
    ix: Instruction,
) -> Option<PostMessageShimMessageData> {
    // find index of post_message_shim program in accounts
    let is_post_message_shim_program =
        |meta: &AccountMeta| meta.pubkey == ntt_transceiver.post_message_shim().program;
    let post_message_shim_index = ix
        .accounts
        .iter()
        .position(is_post_message_shim_program)
        .unwrap() as u8;

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

    let ix_data = details.return_data.unwrap().data;
    // 8-byte instruction discriminator
    let nonce = u32::from_le_bytes(ix_data[8..12].try_into().unwrap());
    let consistency_level: u8 = ix_data[12];
    // 4-byte Vec length
    let payload = ix_data[17..].to_vec();

    // verify inner ixs
    let inner_instructions = details.inner_instructions;
    // TODO: `inner_instructions` is always `None` even though CPIs happen. This limits the
    // testing that can be done as we can no longer parse the VAA message to verify it.
    // Figure out how to get instruction data that can be parsed to re-create the VAA message.
    if inner_instructions.is_none() {
        return Some(PostMessageShimMessageData {
            nonce,
            consistency_level,
            payload,
            emitter_address: Address([0u8; 32]),
            sequence: 0,
            submission_time: 0,
        });
    }
    // NOTE: the following code is untested as `inner_instructions` is always `None`
    {
        assert!(inner_instructions.is_some());
        let post_message_shim_filter = |inner_ix: &&InnerInstruction| {
            inner_ix.instruction.program_id_index == post_message_shim_index
        };
        let flattened_ixs: Vec<InnerInstruction> =
            inner_instructions.unwrap().into_iter().flatten().collect();
        let post_message_shim_ixs: Vec<&InnerInstruction> = flattened_ixs
            .iter()
            .filter(post_message_shim_filter)
            .collect();
        assert_eq!(post_message_shim_ixs.len(), 2);

        // parse instruction data
        let ix_data = &post_message_shim_ixs[0].instruction.data;
        let nonce = u32::from_be_bytes(ix_data[..4].try_into().unwrap());
        let consistency_level: u8 = ix_data[5];
        let payload = ix_data[6..].to_vec();

        // parse cpi event
        let event_data = &post_message_shim_ixs[1].instruction.data;
        let emitter_address = Address(event_data[16..48].try_into().unwrap());
        let sequence = u64::from_be_bytes(event_data[48..56].try_into().unwrap());
        let submission_time = u32::from_be_bytes(event_data[56..60].try_into().unwrap());

        Some(PostMessageShimMessageData {
            nonce,
            consistency_level,
            payload,
            emitter_address,
            sequence,
            submission_time,
        })
    }
}
