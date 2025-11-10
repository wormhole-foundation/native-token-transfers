#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use anchor_lang::{prelude::Clock, AnchorDeserialize};
use example_native_token_transfers::{
    bitmap::Bitmap, error::NTTError, queue::outbox::OutboxItem, transfer::Payload,
};
use ntt_messages::{
    chain_id::ChainId, mode::Mode, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage,
    transceiver::TransceiverMessage, transceivers::wormhole::WormholeTransceiver,
    trimmed_amount::TrimmedAmount,
};
use ntt_transceiver::wormhole::instructions::release_outbound::ReleaseOutboundArgs;
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError, signature::Keypair, signer::Signer,
    transaction::TransactionError,
};
use test_utils::{
    common::{
        fixtures::{TestData, OTHER_MANAGER, OUTBOUND_LIMIT},
        query::GetAccountDataAnchor,
        submit::Submittable,
    },
    helpers::{assert_queued, get_message_data, init_transfer_accs_args, setup},
    sdk::{
        accounts::{good_ntt, NTTAccounts},
        instructions::transfer::{approve_token_authority, transfer},
        transceivers::{
            accounts::good_ntt_transceiver,
            instructions::release_outbound::{release_outbound, ReleaseOutbound},
        },
    },
};
use wormhole_svm_definitions::{solana::Finality::Finalized, EncodeFinality};

#[tokio::test]
pub async fn test_transfer_locking() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;
    test_transfer(&mut ctx, &test_data, Mode::Locking).await;
}

#[tokio::test]
pub async fn test_transfer_burning() {
    let (mut ctx, test_data) = setup(Mode::Burning).await;
    test_transfer(&mut ctx, &test_data, Mode::Burning).await;
}

/// This tests the happy path of a transfer, with all the relevant account checks.
/// Written as a helper function so both modes can be tested.
async fn test_transfer(ctx: &mut ProgramTestContext, test_data: &TestData, mode: Mode) {
    let outbox_item = Keypair::new();

    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();

    let (accs, args) =
        init_transfer_accs_args(&good_ntt, ctx, test_data, outbox_item.pubkey(), 154, false);

    approve_token_authority(
        &good_ntt,
        &test_data.user_token_account,
        &test_data.user.pubkey(),
        &args,
    )
    .submit_with_signers(&[&test_data.user], ctx)
    .await
    .unwrap();
    transfer(&good_ntt, accs, args, mode)
        .submit_with_signers(&[&outbox_item], ctx)
        .await
        .unwrap();

    let outbox_item_account: OutboxItem = ctx.get_account_data_anchor(outbox_item.pubkey()).await;

    assert_eq!(
        outbox_item_account,
        OutboxItem {
            amount: TrimmedAmount {
                amount: 1,
                decimals: 7
            },
            sender: test_data.user.pubkey(),
            recipient_chain: ChainId { id: 2 },
            recipient_ntt_manager: OTHER_MANAGER,
            recipient_address: [1u8; 32],
            release_timestamp: clock.unix_timestamp,
            released: Bitmap::new(),
        }
    );

    let ix = release_outbound(
        &good_ntt,
        &good_ntt_transceiver,
        ReleaseOutbound {
            payer: ctx.payer.pubkey(),
            outbox_item: outbox_item.pubkey(),
        },
        ReleaseOutboundArgs {
            revert_on_delay: true,
        },
    );

    // simulate to fetch data before submitting ix
    let msg = get_message_data(&good_ntt.wormhole(), &good_ntt_transceiver, ctx, ix.clone()).await;
    ix.submit(ctx).await.unwrap();

    // make sure the outbox item is now released, but nothing else has changed
    let outbox_item_account_after: OutboxItem =
        ctx.get_account_data_anchor(outbox_item.pubkey()).await;
    assert_eq!(
        OutboxItem {
            released: Bitmap::from_value(1),
            ..outbox_item_account
        },
        outbox_item_account_after,
    );

    assert_eq!(msg.nonce, 0); // hardcoded
    assert_eq!(msg.consistency_level, Finalized.encode()); // hardcoded
    assert_eq!(
        TransceiverMessage::<WormholeTransceiver, NativeTokenTransfer<Payload>>::deserialize(
            &mut &msg.payload[..],
        )
        .unwrap(),
        TransceiverMessage::new(
            example_native_token_transfers::ID.to_bytes(),
            OTHER_MANAGER,
            NttManagerMessage {
                id: outbox_item.pubkey().to_bytes(),
                sender: test_data.user.pubkey().to_bytes(),
                payload: NativeTokenTransfer {
                    amount: TrimmedAmount {
                        amount: 1,
                        decimals: 7
                    },
                    source_token: test_data.mint.to_bytes(),
                    to: [1u8; 32],
                    to_chain: ChainId { id: 2 },
                    additional_payload: Payload {}
                }
            },
            vec![]
        )
    );
}

#[tokio::test]
async fn test_cant_release_queued() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let outbox_item = Keypair::new();

    let too_much = OUTBOUND_LIMIT + 1000;
    let (accs, args) = init_transfer_accs_args(
        &good_ntt,
        &mut ctx,
        &test_data,
        outbox_item.pubkey(),
        too_much,
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

    assert_queued(&mut ctx, outbox_item.pubkey()).await;

    // check that 'revert_on_delay = true' returns correct error
    let err = release_outbound(
        &good_ntt,
        &good_ntt_transceiver,
        ReleaseOutbound {
            payer: ctx.payer.pubkey(),
            outbox_item: outbox_item.pubkey(),
        },
        ReleaseOutboundArgs {
            revert_on_delay: true,
        },
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::CantReleaseYet.into())
        )
    );

    // check that 'revert_on_delay = false' succeeds but does not release
    release_outbound(
        &good_ntt,
        &good_ntt_transceiver,
        ReleaseOutbound {
            payer: ctx.payer.pubkey(),
            outbox_item: outbox_item.pubkey(),
        },
        ReleaseOutboundArgs {
            revert_on_delay: false,
        },
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    assert_queued(&mut ctx, outbox_item.pubkey()).await;
}

#[tokio::test]
async fn test_cant_release_twice() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let outbox_item = Keypair::new();

    let (accs, args) = init_transfer_accs_args(
        &good_ntt,
        &mut ctx,
        &test_data,
        outbox_item.pubkey(),
        100,
        false,
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

    release_outbound(
        &good_ntt,
        &good_ntt_transceiver,
        ReleaseOutbound {
            payer: ctx.payer.pubkey(),
            outbox_item: outbox_item.pubkey(),
        },
        ReleaseOutboundArgs {
            revert_on_delay: true,
        },
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    // make sure we can't release again
    let err = release_outbound(
        &good_ntt,
        &good_ntt_transceiver,
        ReleaseOutbound {
            payer: ctx.payer.pubkey(),
            outbox_item: outbox_item.pubkey(),
        },
        ReleaseOutboundArgs {
            revert_on_delay: true,
        },
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::MessageAlreadySent.into())
        )
    );
}
