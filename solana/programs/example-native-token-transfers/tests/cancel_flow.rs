#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use anchor_lang::prelude::*;
use common::setup::{TestData, OTHER_CHAIN};
use example_native_token_transfers::{
    instructions::{RedeemArgs, TransferArgs},
    queue::{inbox::InboxRateLimit, outbox::OutboxRateLimit},
    transfer::Payload,
};
use ntt_messages::{
    chain_id::ChainId, mode::Mode, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage,
};
use sdk::{
    accounts::{good_ntt, NTTAccounts},
    transceivers::wormhole::instructions::receive_message::ReceiveMessage,
};
use solana_program_test::*;
use solana_sdk::{signature::Keypair, signer::Signer};
use wormhole_sdk::Address;

use crate::{
    common::{
        query::GetAccountDataAnchor,
        setup::{setup, OTHER_TRANSCEIVER},
        utils::make_transfer_message,
    },
    sdk::{
        instructions::{
            redeem::{redeem, Redeem},
            transfer::Transfer,
        },
        transceivers::wormhole::instructions::receive_message::receive_message,
    },
};
use crate::{
    common::{submit::Submittable, utils::post_vaa_helper},
    sdk::instructions::transfer::{approve_token_authority, transfer},
};

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
        peer: good_ntt.peer(OTHER_CHAIN),
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
        peer: good_ntt.peer(chain_id),
        transceiver: good_ntt.program(),
        transceiver_message: good_ntt.transceiver_message(chain_id, ntt_manager_message.id),
        inbox_item: good_ntt.inbox_item(chain_id, ntt_manager_message),
        inbox_rate_limit: good_ntt.inbox_rate_limit(chain_id),
        mint: test_data.mint,
    }
}

fn init_receive_message_accs(
    ctx: &mut ProgramTestContext,
    vaa: Pubkey,
    chain_id: u16,
    id: [u8; 32],
) -> ReceiveMessage {
    ReceiveMessage {
        payer: ctx.payer.pubkey(),
        peer: good_ntt.transceiver_peer(chain_id),
        vaa,
        chain_id,
        id,
    }
}

async fn outbound_capacity(ctx: &mut ProgramTestContext) -> u64 {
    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let rate_limit: OutboxRateLimit = ctx
        .get_account_data_anchor(good_ntt.outbox_rate_limit())
        .await;

    rate_limit.rate_limit.capacity_at(clock.unix_timestamp)
}

async fn inbound_capacity(ctx: &mut ProgramTestContext) -> u64 {
    let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let rate_limit: InboxRateLimit = ctx
        .get_account_data_anchor(good_ntt.inbox_rate_limit(OTHER_CHAIN))
        .await;

    rate_limit.rate_limit.capacity_at(clock.unix_timestamp)
}

#[tokio::test]
async fn test_cancel() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let msg0 = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());
    let msg1 = make_transfer_message(&good_ntt, [1u8; 32], 2000, &recipient.pubkey());
    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg0.clone(),
        &mut ctx,
    )
    .await;
    let vaa1 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg1.clone(),
        &mut ctx,
    )
    .await;

    let inbound_limit_before = inbound_capacity(&mut ctx).await;
    let outbound_limit_before = outbound_capacity(&mut ctx).await;

    receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    redeem(
        &good_ntt,
        init_redeem_accs(
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

    assert_eq!(outbound_limit_before, outbound_capacity(&mut ctx).await);

    assert_eq!(
        inbound_limit_before - 1000,
        inbound_capacity(&mut ctx).await
    );

    let outbox_item = Keypair::new();

    let (accs, args) =
        init_transfer_accs_args(&mut ctx, &test_data, outbox_item.pubkey(), 7000, true);

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
        outbound_capacity(&mut ctx).await
    );

    // fully replenished
    assert_eq!(inbound_limit_before, inbound_capacity(&mut ctx).await);

    receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa1, OTHER_CHAIN, [1u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    redeem(
        &good_ntt,
        init_redeem_accs(
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
        outbound_capacity(&mut ctx).await
    );

    assert_eq!(
        inbound_limit_before - 2000,
        inbound_capacity(&mut ctx).await
    );
}
