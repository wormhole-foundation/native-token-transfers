#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use anchor_lang::AnchorDeserialize;
use ntt_messages::{
    chain_id::ChainId,
    mode::Mode,
    transceivers::wormhole::{WormholeTransceiverInfo, WormholeTransceiverRegistration},
};
use solana_program_test::*;
use solana_sdk::signer::Signer;
use test_utils::{
    common::{
        fixtures::{OTHER_CHAIN, OTHER_TRANSCEIVER},
        submit::Submittable,
    },
    helpers::{get_message_data, setup},
    sdk::{
        accounts::{good_ntt, NTTAccounts},
        transceivers::{
            accounts::good_ntt_transceiver,
            instructions::{
                broadcast_id::{broadcast_id, BroadcastId},
                broadcast_peer::{broadcast_peer, BroadcastPeer},
            },
        },
    },
};
use wormhole_svm_definitions::{solana::Finality::Finalized, EncodeFinality};

#[tokio::test]
async fn test_broadcast_peer() {
    let (mut ctx, _test_data) = setup(Mode::Locking).await;

    let ix = broadcast_peer(
        &good_ntt,
        &good_ntt_transceiver,
        BroadcastPeer {
            payer: ctx.payer.pubkey(),
            chain_id: OTHER_CHAIN,
        },
    );

    // simulate to fetch data before submitting ix
    let msg = get_message_data(
        &good_ntt.wormhole(),
        &good_ntt_transceiver,
        &mut ctx,
        ix.clone(),
    )
    .await;
    ix.submit(&mut ctx).await.unwrap();

    assert_eq!(msg.nonce, 0); // hardcoded
    assert_eq!(msg.consistency_level, Finalized.encode()); // hardcoded
    assert_eq!(
        WormholeTransceiverRegistration::deserialize(&mut &msg.payload[..]).unwrap(),
        WormholeTransceiverRegistration {
            chain_id: ChainId { id: OTHER_CHAIN },
            transceiver_address: OTHER_TRANSCEIVER
        }
    );
}

#[tokio::test]
async fn test_broadcast_id() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let ix = broadcast_id(
        &good_ntt,
        &good_ntt_transceiver,
        BroadcastId {
            payer: ctx.payer.pubkey(),
            mint: test_data.mint,
        },
    );

    // simulate to fetch data before submitting ix
    let msg = get_message_data(
        &good_ntt.wormhole(),
        &good_ntt_transceiver,
        &mut ctx,
        ix.clone(),
    )
    .await;
    ix.submit(&mut ctx).await.unwrap();

    assert_eq!(msg.nonce, 0); // hardcoded
    assert_eq!(msg.consistency_level, Finalized.encode()); // hardcoded
    assert_eq!(
        WormholeTransceiverInfo::deserialize(&mut &msg.payload[..]).unwrap(),
        WormholeTransceiverInfo {
            manager_address: good_ntt.program().to_bytes(),
            manager_mode: Mode::Locking,
            token_address: test_data.mint.to_bytes(),
            token_decimals: 9,
        }
    );
}
