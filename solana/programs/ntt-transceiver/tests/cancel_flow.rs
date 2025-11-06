#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use example_native_token_transfers::instructions::RedeemArgs;
use ntt_messages::mode::Mode;
use ntt_transceiver::vaa_body::VaaBodyData;
use solana_program_test::*;
use solana_sdk::{signature::Keypair, signer::Signer};
use test_utils::{
    common::{
        fixtures::{OTHER_CHAIN, OTHER_TRANSCEIVER},
        submit::Submittable,
    },
    helpers::{
        inbound_capacity, init_receive_message_accs, init_redeem_accs, init_transfer_accs_args,
        make_transfer_message, outbound_capacity, post_vaa_helper, setup,
    },
    sdk::{
        accounts::good_ntt,
        instructions::{
            post_vaa::close_signatures,
            redeem::redeem,
            transfer::{approve_token_authority, transfer},
        },
        transceivers::{
            accounts::good_ntt_transceiver,
            instructions::receive_message::receive_message_instruction_data,
        },
    },
};
use wormhole_sdk::Address;

#[tokio::test]
async fn test_cancel() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let msg0 = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());
    let msg1 = make_transfer_message(&good_ntt, [1u8; 32], 2000, &recipient.pubkey());
    let (guardian_signatures0, guardian_set_index0, span0) = post_vaa_helper(
        &good_ntt_transceiver,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg0.clone(),
        &mut ctx,
    )
    .await;
    let (guardian_signatures1, guardian_set_index1, span1) = post_vaa_helper(
        &good_ntt_transceiver,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg1.clone(),
        &mut ctx,
    )
    .await;

    let inbound_limit_before = inbound_capacity(&good_ntt, &mut ctx).await;
    let outbound_limit_before = outbound_capacity(&good_ntt, &mut ctx).await;

    receive_message_instruction_data(
        &good_ntt,
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt,
            &good_ntt_transceiver,
            &mut ctx,
            OTHER_CHAIN,
            [0u8; 32],
            guardian_set_index0,
            guardian_signatures0,
        ),
        VaaBodyData { span: span0 },
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    close_signatures(&good_ntt_transceiver, &mut ctx, &guardian_signatures0).await;

    redeem(
        &good_ntt,
        init_redeem_accs(
            &good_ntt,
            &good_ntt_transceiver,
            &mut ctx,
            &test_data,
            OTHER_CHAIN,
            msg0.ntt_manager_payload.clone(),
        ),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    assert_eq!(
        outbound_limit_before,
        outbound_capacity(&good_ntt, &mut ctx).await
    );

    assert_eq!(
        inbound_limit_before - 1000,
        inbound_capacity(&good_ntt, &mut ctx).await
    );

    let outbox_item = Keypair::new();

    let (accs, args) = init_transfer_accs_args(
        &good_ntt,
        &mut ctx,
        &test_data,
        outbox_item.pubkey(),
        7000,
        true,
    );

    approve_token_authority(
        &good_ntt,
        &test_data.user_token_account,
        &test_data.user.pubkey(),
        &args,
    )
    .submit_with_signers(&[&test_data.user], &mut ctx)
    .await
    .unwrap();
    transfer(&good_ntt, accs, args, Mode::Locking)
        .submit_with_signers(&[&outbox_item], &mut ctx)
        .await
        .unwrap();

    assert_eq!(
        outbound_limit_before - 7000,
        outbound_capacity(&good_ntt, &mut ctx).await
    );

    // fully replenished
    assert_eq!(
        inbound_limit_before,
        inbound_capacity(&good_ntt, &mut ctx).await
    );

    receive_message_instruction_data(
        &good_ntt,
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt,
            &good_ntt_transceiver,
            &mut ctx,
            OTHER_CHAIN,
            [1u8; 32],
            guardian_set_index1,
            guardian_signatures1,
        ),
        VaaBodyData { span: span1 },
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    close_signatures(&good_ntt_transceiver, &mut ctx, &guardian_signatures1).await;

    redeem(
        &good_ntt,
        init_redeem_accs(
            &good_ntt,
            &good_ntt_transceiver,
            &mut ctx,
            &test_data,
            OTHER_CHAIN,
            msg1.ntt_manager_payload.clone(),
        ),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    assert_eq!(
        outbound_limit_before - 5000,
        outbound_capacity(&good_ntt, &mut ctx).await
    );

    assert_eq!(
        inbound_limit_before - 2000,
        inbound_capacity(&good_ntt, &mut ctx).await
    );
}
