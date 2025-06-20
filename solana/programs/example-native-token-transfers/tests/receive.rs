#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use common::{
    setup::{TestData, ANOTHER_CHAIN, OTHER_CHAIN},
    utils::make_transfer_message,
};
use example_native_token_transfers::{
    error::NTTError,
    instructions::{RedeemArgs, ReleaseInboundArgs},
    transfer::Payload,
};
use ntt_messages::{mode::Mode, ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage};
use sdk::{
    accounts::NTTAccounts, transceivers::wormhole::instructions::receive_message::ReceiveMessage,
};
use solana_program::instruction::InstructionError;
use solana_program_test::*;
use solana_sdk::{
    pubkey::Pubkey, signature::Keypair, signer::Signer, transaction::TransactionError,
};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use wormhole_sdk::Address;

use crate::{
    common::{
        query::GetAccountDataAnchor,
        setup::{setup, OTHER_TRANSCEIVER},
    },
    sdk::{
        accounts::good_ntt,
        instructions::redeem::{redeem, Redeem},
        transceivers::wormhole::instructions::receive_message::receive_message,
    },
};
use crate::{
    common::{submit::Submittable, utils::post_vaa_helper},
    sdk::instructions::release_inbound::{release_inbound_unlock, ReleaseInbound},
};

pub mod common;
pub mod sdk;

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

#[tokio::test]
async fn test_receive() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    // transfer tokens to custody account
    spl_token::instruction::transfer_checked(
        &Token::id(),
        &test_data.user_token_account,
        &test_data.mint,
        &good_ntt.custody(&test_data.mint),
        &test_data.user.pubkey(),
        &[],
        1000,
        9,
    )
    .unwrap()
    .submit_with_signers(&[&test_data.user], &mut ctx)
    .await
    .unwrap();

    spl_associated_token_account::instruction::create_associated_token_account(
        &ctx.payer.pubkey(),
        &recipient.pubkey(),
        &test_data.mint,
        &Token::id(),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let recipient_token_account = get_associated_token_address_with_program_id(
        &recipient.pubkey(),
        &test_data.mint,
        &Token::id(),
    );

    let msg = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());

    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg.clone(),
        &mut ctx,
    )
    .await;

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
            msg.ntt_manager_payload.clone(),
        ),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let token_account: TokenAccount = ctx.get_account_data_anchor(recipient_token_account).await;

    assert_eq!(token_account.amount, 0);

    release_inbound_unlock(
        &good_ntt,
        ReleaseInbound {
            payer: ctx.payer.pubkey(),
            inbox_item: good_ntt.inbox_item(OTHER_CHAIN, msg.ntt_manager_payload.clone()),
            mint: test_data.mint,
            recipient: recipient_token_account,
        },
        ReleaseInboundArgs {
            revert_when_not_ready: false,
        },
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let token_account: TokenAccount = ctx.get_account_data_anchor(recipient_token_account).await;
    assert_eq!(token_account.amount, 1000);

    // let's make sure we can't redeem again.
    let err = release_inbound_unlock(
        &good_ntt,
        ReleaseInbound {
            payer: ctx.payer.pubkey(),
            inbox_item: good_ntt.inbox_item(OTHER_CHAIN, msg.ntt_manager_payload.clone()),
            mint: test_data.mint,
            recipient: recipient_token_account,
        },
        ReleaseInboundArgs {
            revert_when_not_ready: false,
        },
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::TransferAlreadyRedeemed.into())
        )
    );
}

#[tokio::test]
async fn test_double_receive() {
    let recipient = Keypair::new();
    let (mut ctx, _test_data) = setup(Mode::Locking).await;

    let msg = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());

    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg.clone(),
        &mut ctx,
    )
    .await;
    let vaa1 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg,
        &mut ctx,
    )
    .await;

    receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let err = receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa1, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        // AccountAlreadyInUse
        TransactionError::InstructionError(0, InstructionError::Custom(0))
    );
}

#[tokio::test]
async fn test_wrong_recipient_ntt_manager() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let mut msg = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());

    msg.recipient_ntt_manager = Pubkey::new_unique().to_bytes();

    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg.clone(),
        &mut ctx,
    )
    .await;

    receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let err = redeem(
        &good_ntt,
        init_redeem_accs(
            &mut ctx,
            &test_data,
            OTHER_CHAIN,
            msg.ntt_manager_payload.clone(),
        ),
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

#[tokio::test]
async fn test_wrong_transceiver_peer() {
    let recipient = Keypair::new();
    let (mut ctx, _test_data) = setup(Mode::Locking).await;

    let msg = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());

    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(Pubkey::new_unique().to_bytes()), // not the expected transceiver
        msg.clone(),
        &mut ctx,
    )
    .await;

    let err = receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::InvalidTransceiverPeer.into())
        )
    );
}

#[tokio::test]
async fn test_wrong_manager_peer() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let mut msg = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());

    msg.source_ntt_manager = Pubkey::new_unique().to_bytes(); // not the expected source manager

    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg.clone(),
        &mut ctx,
    )
    .await;

    receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let err = redeem(
        &good_ntt,
        init_redeem_accs(
            &mut ctx,
            &test_data,
            OTHER_CHAIN,
            msg.ntt_manager_payload.clone(),
        ),
        RedeemArgs {},
    )
    .submit(&mut ctx)
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::InvalidNttManagerPeer.into())
        )
    );
}

#[tokio::test]
async fn test_wrong_inbox_item() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let msg = make_transfer_message(&good_ntt, [0u8; 32], 1000, &recipient.pubkey());

    let vaa0 = post_vaa_helper(
        &good_ntt,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg.clone(),
        &mut ctx,
    )
    .await;

    receive_message(
        &good_ntt,
        init_receive_message_accs(&mut ctx, vaa0, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    // use 'ANOTHER_CHAIN' inbox item account here
    let mut redeem_accs = init_redeem_accs(
        &mut ctx,
        &test_data,
        OTHER_CHAIN,
        msg.ntt_manager_payload.clone(),
    );
    redeem_accs.inbox_item = good_ntt.inbox_item(ANOTHER_CHAIN, msg.ntt_manager_payload.clone());

    let err = redeem(&good_ntt, redeem_accs, RedeemArgs {})
        .submit(&mut ctx)
        .await
        .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(ErrorCode::ConstraintSeeds.into())
        )
    );
}
