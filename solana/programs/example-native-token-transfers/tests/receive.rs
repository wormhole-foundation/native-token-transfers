#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use example_native_token_transfers::{
    error::NTTError,
    instructions::{InitializeArgs, RedeemArgs, ReleaseInboundArgs},
};
use ntt_messages::mode::Mode;
use solana_program::instruction::InstructionError;
use solana_program_test::*;
use solana_sdk::{
    pubkey::Pubkey, signature::Keypair, signer::Signer, transaction::TransactionError,
};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use test_utils::{
    common::{
        fixtures::{ANOTHER_CHAIN, OTHER_CHAIN, OTHER_TRANSCEIVER, OUTBOUND_LIMIT, THIS_CHAIN},
        query::GetAccountDataAnchor,
        submit::Submittable,
    },
    helpers::{
        init_receive_message_accs, init_redeem_accs, make_transfer_message, post_vaa_helper, setup,
    },
    sdk::{
        accounts::{good_ntt, NTTAccounts},
        instructions::{
            initialize::{initialize_with_token_program_id, Initialize},
            redeem::redeem,
            release_inbound::{release_inbound_unlock, ReleaseInbound},
        },
        transceivers::{
            accounts::good_ntt_transceiver, instructions::receive_message::receive_message,
        },
    },
};
use wormhole_sdk::Address;

#[tokio::test]
async fn test_receive() {
    let recipient = Keypair::new();
    let (mut ctx, test_data) = setup(Mode::Locking).await;
    let good_ntt = good_ntt(test_data.instance.pubkey());
    let good_ntt_transceiver = good_ntt_transceiver(test_data.instance.pubkey());

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
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa0,
            OTHER_CHAIN,
            [0u8; 32],
        ),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    redeem(
        &good_ntt,
        init_redeem_accs(
            &good_ntt,
            &good_ntt_transceiver,
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
    let (mut ctx, test_data) = setup(Mode::Locking).await;
    let good_ntt = good_ntt(test_data.instance.pubkey());
    let good_ntt_transceiver = good_ntt_transceiver(test_data.instance.pubkey());

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
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa0,
            OTHER_CHAIN,
            [0u8; 32],
        ),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let err = receive_message(
        &good_ntt,
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa1,
            OTHER_CHAIN,
            [0u8; 32],
        ),
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
    let good_ntt = good_ntt(test_data.instance.pubkey());
    let good_ntt_transceiver = good_ntt_transceiver(test_data.instance.pubkey());

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

    // v4: the recipient_ntt_manager binding is now checked at receive time, so a
    // message addressed to a different instance is rejected before it can create
    // a (mis-scoped) transceiver message — rather than later at redeem.
    let err = receive_message(
        &good_ntt,
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa0,
            OTHER_CHAIN,
            [0u8; 32],
        ),
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
    let (mut ctx, test_data) = setup(Mode::Locking).await;
    let good_ntt = good_ntt(test_data.instance.pubkey());
    let good_ntt_transceiver = good_ntt_transceiver(test_data.instance.pubkey());

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
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa0,
            OTHER_CHAIN,
            [0u8; 32],
        ),
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
    let good_ntt = good_ntt(test_data.instance.pubkey());
    let good_ntt_transceiver = good_ntt_transceiver(test_data.instance.pubkey());

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
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa0,
            OTHER_CHAIN,
            [0u8; 32],
        ),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    let err = redeem(
        &good_ntt,
        init_redeem_accs(
            &good_ntt,
            &good_ntt_transceiver,
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
    let good_ntt = good_ntt(test_data.instance.pubkey());
    let good_ntt_transceiver = good_ntt_transceiver(test_data.instance.pubkey());

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
        &good_ntt_transceiver,
        init_receive_message_accs(
            &good_ntt_transceiver,
            &mut ctx,
            vaa0,
            OTHER_CHAIN,
            [0u8; 32],
        ),
    )
    .submit(&mut ctx)
    .await
    .unwrap();

    // use 'ANOTHER_CHAIN' inbox item account here
    let mut redeem_accs = init_redeem_accs(
        &good_ntt,
        &good_ntt_transceiver,
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

/// An inbox item is content-addressed and seeded by the *instance* it was
/// redeemed under, but `release_inbound` receives it as an already-allocated
/// account with no way to re-derive those seeds. Without an explicit binding,
/// instance A's released-ready inbox item could be released against a second
/// instance B — minting/unlocking B's tokens for a transfer B never received.
/// (Instance creation is permissionless, so the attacker can supply their own
/// instance A.) This test pins the binding: releasing A's inbox item against B
/// must fail with `InvalidInboxItem`.
#[tokio::test]
async fn test_release_inbound_rejects_cross_instance_inbox_item() {
    let recipient = Keypair::new();
    // Instance A: the deployment `setup` stands up, in locking mode.
    let (mut ctx, test_data) = setup(Mode::Locking).await;
    let ntt_a = good_ntt(test_data.instance.pubkey());
    let xcvr_a = good_ntt_transceiver(test_data.instance.pubkey());

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

    // Validate an inbound transfer under instance A. This creates (and, at
    // threshold 1, approves) `inbox_item_A`, ready to be released.
    let msg = make_transfer_message(&ntt_a, [0u8; 32], 1000, &recipient.pubkey());
    let vaa = post_vaa_helper(
        &ntt_a,
        OTHER_CHAIN.into(),
        Address(OTHER_TRANSCEIVER),
        msg.clone(),
        &mut ctx,
    )
    .await;
    receive_message(
        &ntt_a,
        &xcvr_a,
        init_receive_message_accs(&xcvr_a, &mut ctx, vaa, OTHER_CHAIN, [0u8; 32]),
    )
    .submit(&mut ctx)
    .await
    .unwrap();
    redeem(
        &ntt_a,
        init_redeem_accs(
            &ntt_a,
            &xcvr_a,
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

    // Instance B: a second, independent instance sharing the same mint. Its
    // `config`/`token_authority`/`custody` are all distinct from A's, and
    // `initialize` allocates B's custody, so every account in the release below
    // is valid — only the inbox item belongs to the wrong instance.
    let instance_b = Keypair::new();
    let ntt_b = good_ntt(instance_b.pubkey());
    initialize_with_token_program_id(
        &ntt_b,
        Initialize {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
            mint: test_data.mint,
            multisig_token_authority: None,
        },
        InitializeArgs {
            chain_id: THIS_CHAIN,
            limit: OUTBOUND_LIMIT,
            mode: Mode::Locking,
        },
        &Token::id(),
    )
    .submit_with_signers(&[&test_data.program_owner, &instance_b], &mut ctx)
    .await
    .unwrap();

    // Attack: release instance A's inbox item against instance B.
    let err = release_inbound_unlock(
        &ntt_b,
        ReleaseInbound {
            payer: ctx.payer.pubkey(),
            inbox_item: ntt_a.inbox_item(OTHER_CHAIN, msg.ntt_manager_payload.clone()),
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
            InstructionError::Custom(NTTError::InvalidInboxItem.into())
        )
    );
}
