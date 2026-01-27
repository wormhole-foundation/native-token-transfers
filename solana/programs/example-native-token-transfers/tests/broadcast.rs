#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use ntt_messages::{
    chain_id::ChainId,
    mode::Mode,
    transceivers::wormhole::{WormholeTransceiverInfo, WormholeTransceiverRegistration},
};
use solana_program_test::*;
use solana_sdk::{signature::Keypair, signer::Signer};
use test_utils::{
    common::{
        fixtures::{OTHER_CHAIN, OTHER_TRANSCEIVER},
        query::GetAccountDataAnchor,
        submit::Submittable,
    },
    helpers::setup,
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
use wormhole_anchor_sdk::wormhole::PostedVaa;

#[tokio::test]
async fn test_broadcast_peer() {
    let (mut ctx, _test_data) = setup(Mode::Locking).await;

    let wh_message = Keypair::new();

    broadcast_peer(
        &good_ntt,
        &good_ntt_transceiver,
        BroadcastPeer {
            payer: ctx.payer.pubkey(),
            wormhole_message: wh_message.pubkey(),
            chain_id: OTHER_CHAIN,
        },
    )
    .submit_with_signers(&[&wh_message], &mut ctx)
    .await
    .unwrap();

    let msg: PostedVaa<WormholeTransceiverRegistration> = ctx
        .get_account_data_anchor_unchecked(wh_message.pubkey())
        .await;

    assert_eq!(
        *msg.data(),
        WormholeTransceiverRegistration {
            chain_id: ChainId { id: OTHER_CHAIN },
            transceiver_address: OTHER_TRANSCEIVER
        }
    );
}

#[tokio::test]
async fn test_broadcast_id() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let wh_message = Keypair::new();

    broadcast_id(
        &good_ntt,
        &good_ntt_transceiver,
        BroadcastId {
            payer: ctx.payer.pubkey(),
            wormhole_message: wh_message.pubkey(),
            mint: test_data.mint,
        },
    )
    .submit_with_signers(&[&wh_message], &mut ctx)
    .await
    .unwrap();

    let msg: PostedVaa<WormholeTransceiverInfo> = ctx
        .get_account_data_anchor_unchecked(wh_message.pubkey())
        .await;

    assert_eq!(
        *msg.data(),
        WormholeTransceiverInfo {
            manager_address: good_ntt.program().to_bytes(),
            manager_mode: Mode::Locking,
            token_address: test_data.mint.to_bytes(),
            token_decimals: 9,
        }
    );
}
