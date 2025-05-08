#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use crate::{
    common::{
        query::GetAccountDataAnchor,
        setup::{setup, TestData, OTHER_CHAIN, OTHER_MANAGER, OTHER_TRANSCEIVER, THIS_CHAIN},
        submit::Submittable,
    },
    sdk::{
        instructions::{
            post_vaa::post_vaa,
            redeem::{redeem, Redeem},
            transfer::{approve_token_authority, transfer, Transfer},
        },
        transceivers::wormhole::instructions::receive_message::{receive_message, ReceiveMessage},
    },
};
use anchor_lang::prelude::*;
use example_native_token_transfers::{
    error::NTTError,
    instructions::{RedeemArgs, TransferArgs},
    queue::{inbox::InboxRateLimit, outbox::OutboxRateLimit},
    transfer::Payload,
};
use ntt_messages::{
    chain_id::ChainId, mode::Mode, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage,
    transceiver::TransceiverMessage, transceivers::wormhole::WormholeTransceiver,
    trimmed_amount::TrimmedAmount,
};
use solana_program::instruction::InstructionError;
use solana_program_test::*;
use solana_sdk::{signature::Keypair, signer::Signer, transaction::TransactionError};
use wormhole_sdk::{Address, Vaa};

pub mod common;
pub mod sdk;

fn init_transfer_accs_args(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    outbox_item: Pubkey,
    amount: u64,
    should_queue: bool,
) -> (Transfer, TransferArgs) {
    let accs = Transfer {
        payer: ctx.payer.pubkey(),
        peer: test_data.ntt.peer(OTHER_CHAIN),
        mint: test_data.mint,
        from: test_data.user_token_account,
        from_authority: test_data.user.pubkey(),
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

fn init_redeem_accs(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    chain_id: u16,
    ntt_manager_message: NttManagerMessage<NativeTokenTransfer<Payload>>,
) -> Redeem {
    Redeem {
        payer: ctx.payer.pubkey(),
        peer: test_data.ntt.peer(chain_id),
        transceiver: test_data.ntt_transceiver.program,
        transceiver_message: test_data
            .ntt_transceiver
            .transceiver_message(chain_id, ntt_manager_message.id),
        inbox_item: test_data.ntt.inbox_item(chain_id, ntt_manager_message),
        inbox_rate_limit: test_data.ntt.inbox_rate_limit(chain_id),
        mint: test_data.mint,
    }
}

fn init_receive_message_accs(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    vaa: Pubkey,
    chain_id: u16,
    id: [u8; 32],
) -> ReceiveMessage {
    ReceiveMessage {
        payer: ctx.payer.pubkey(),
        peer: test_data.ntt_transceiver.transceiver_peer(chain_id),
        vaa,
        chain_id,
        id,
    }
}

async fn post_transfer_vaa(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    id: [u8; 32],
    amount: u64,
    // TODO: this is used for a negative testing of the recipient ntt_manager
    // address. this should not be done in the cancel flow tests, but instead a
    // dedicated receive transfer test suite
    recipient_ntt_manager: Option<&Pubkey>,
    recipient: &Keypair,
) -> (Pubkey, NttManagerMessage<NativeTokenTransfer<Payload>>) {
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
            to: recipient.pubkey().to_bytes(),
            additional_payload: Payload {},
        },
    };

    let transceiver_message: TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<Payload>> =
        TransceiverMessage::new(
            OTHER_MANAGER,
            recipient_ntt_manager
                .map(|k| k.to_bytes())
                .unwrap_or_else(|| test_data.ntt.program.to_bytes()),
            ntt_manager_message.clone(),
            vec![],
        );

    let vaa = Vaa {
        version: 1,
        guardian_set_index: 0,
        signatures: vec![],
        timestamp: 123232,
        nonce: 0,
        emitter_chain: OTHER_CHAIN.into(),
        emitter_address: Address(OTHER_TRANSCEIVER),
        sequence: 0,
        consistency_level: 0,
        payload: transceiver_message,
    };

    let posted_vaa = post_vaa(&test_data.ntt.wormhole, ctx, vaa).await;

    (posted_vaa, ntt_manager_message)
}

async fn outbound_capacity(ctx: &mut ProgramTestContext, test_data: &TestData) -> u64 {
    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let rate_limit: OutboxRateLimit = ctx
        .get_account_data_anchor(test_data.ntt.outbox_rate_limit())
        .await;

    rate_limit.rate_limit.capacity_at(clock.unix_timestamp)
}

async fn inbound_capacity(ctx: &mut ProgramTestContext, test_data: &TestData) -> u64 {
    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let rate_limit: InboxRateLimit = ctx
        .get_account_data_anchor(test_data.ntt.inbox_rate_limit(OTHER_CHAIN))
        .await;

    rate_limit.rate_limit.capacity_at(clock.unix_timestamp)
}

#[tokio::test]
async fn test_cancel() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let (vaa0, msg0) =
        post_transfer_vaa(&mut ctx, &test_data, [0u8; 32], 1000, None, &recipient).await;
    let (vaa1, msg1) =
        post_transfer_vaa(&mut ctx, &test_data, [1u8; 32], 2000, None, &recipient).await;

    let inbound_limit_before = inbound_capacity(&mut ctx, &test_data).await;
    let outbound_limit_before = outbound_capacity(&mut ctx, &test_data).await;

    receive_message(
        &test_data.ntt,
        &test_data.ntt_transceiver,
        init_receive_message_accs(&mut ctx, &test_data, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    redeem(
        &test_data.ntt,
        init_redeem_accs(&mut ctx, &test_data, OTHER_CHAIN, msg0),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    assert_eq!(
        outbound_limit_before,
        outbound_capacity(&mut ctx, &test_data).await
    );

    assert_eq!(
        inbound_limit_before - 1000,
        inbound_capacity(&mut ctx, &test_data).await
    );

    let outbox_item = Keypair::new();

    let (accs, args) =
        init_transfer_accs_args(&mut ctx, &test_data, outbox_item.pubkey(), 7000, true);

    approve_token_authority(
        &test_data.ntt,
        &test_data.user_token_account,
        &test_data.user.pubkey(),
        &args,
    )
    .submit_with_signers(&[&test_data.user], &mut ctx)
    .await
    .unwrap();
    transfer(&test_data.ntt, accs, args, Mode::Locking)
        .submit_with_signers(&[&outbox_item], &mut ctx)
        .await
        .unwrap();

    assert_eq!(
        outbound_limit_before - 7000,
        outbound_capacity(&mut ctx, &test_data).await
    );

    // fully replenished
    assert_eq!(
        inbound_limit_before,
        inbound_capacity(&mut ctx, &test_data).await
    );

    receive_message(
        &test_data.ntt,
        &test_data.ntt_transceiver,
        init_receive_message_accs(&mut ctx, &test_data, vaa1, OTHER_CHAIN, [1u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    redeem(
        &test_data.ntt,
        init_redeem_accs(&mut ctx, &test_data, OTHER_CHAIN, msg1),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    assert_eq!(
        outbound_limit_before - 5000,
        outbound_capacity(&mut ctx, &test_data).await
    );

    assert_eq!(
        inbound_limit_before - 2000,
        inbound_capacity(&mut ctx, &test_data).await
    );
}

// TODO: this should not live in this file, move to a dedicated receive test suite
#[tokio::test]
async fn test_wrong_recipient_ntt_manager() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let (vaa0, msg0) = post_transfer_vaa(
        &mut ctx,
        &test_data,
        [0u8; 32],
        1000,
        Some(&Pubkey::default()),
        &recipient,
    )
    .await;

    receive_message(
        &test_data.ntt,
        &test_data.ntt_transceiver,
        init_receive_message_accs(&mut ctx, &test_data, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let err = redeem(
        &test_data.ntt,
        init_redeem_accs(&mut ctx, &test_data, OTHER_CHAIN, msg0),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::InvalidRecipientNttManager.into())
        )
    );
}
