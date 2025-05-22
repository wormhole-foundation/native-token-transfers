#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use crate::{
    common::{
        query::GetAccountDataAnchor,
        setup::{setup, TestData},
        submit::Submittable,
    },
    sdk::instructions::admin::{
        deregister_transceiver, register_transceiver, set_threshold, DeregisterTransceiver,
        RegisterTransceiver, SetThreshold,
    },
};
use anchor_lang::{prelude::Pubkey, system_program::System, Id};
use example_native_token_transfers::{
    config::Config, error::NTTError, registered_transceiver::RegisteredTransceiver,
};
use ntt_messages::mode::Mode;
use solana_program_test::*;
use solana_sdk::{instruction::InstructionError, signer::Signer, transaction::TransactionError};

pub mod common;
pub mod sdk;

async fn assert_threshold(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    expected_threshold: u8,
) {
    let config_account: Config = ctx.get_account_data_anchor(test_data.ntt.config()).await;
    assert_eq!(config_account.threshold, expected_threshold);
}

async fn assert_transceiver_id(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    transceiver: &Pubkey,
    expected_id: u8,
) {
    let registered_transceiver_account: RegisteredTransceiver = ctx
        .get_account_data_anchor(test_data.ntt.registered_transceiver(transceiver))
        .await;
    assert_eq!(
        registered_transceiver_account.transceiver_address,
        *transceiver
    );
    assert_eq!(registered_transceiver_account.id, expected_id);
}

#[tokio::test]
async fn test_invalid_transceiver() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    // try registering system program
    let err = register_transceiver(
        &test_data.ntt,
        RegisterTransceiver {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
            transceiver: System::id(),
        },
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap_err();
    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::InvalidTransceiverProgram.into())
        )
    );
}

#[tokio::test]
async fn test_reregister_all_transceivers() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    // Transceivers are expected to be executable which requires them to be added on setup
    // Thus, we pass all available executable program IDs as dummy_transceivers
    let dummy_transceivers = vec![
        example_native_token_transfers::ID,
        wormhole_anchor_sdk::wormhole::program::ID,
        wormhole_governance::ID,
    ];
    let num_dummy_transceivers: u8 = dummy_transceivers.len().try_into().unwrap();

    // register dummy transceivers
    for (idx, transceiver) in dummy_transceivers.iter().enumerate() {
        register_transceiver(
            &test_data.ntt,
            RegisterTransceiver {
                payer: ctx.payer.pubkey(),
                owner: test_data.program_owner.pubkey(),
                transceiver: *transceiver,
            },
        )
        .submit_with_signers(&[&test_data.program_owner], &mut ctx)
        .await
        .unwrap();
        assert_transceiver_id(&mut ctx, &test_data, transceiver, idx as u8 + 1).await;
    }

    // set threshold = 1 (for baked-in transceiver) + num_dummy_transceivers
    set_threshold(
        &test_data.ntt,
        SetThreshold {
            owner: test_data.program_owner.pubkey(),
        },
        1 + num_dummy_transceivers,
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();

    // deregister dummy transceivers
    for (idx, transceiver) in dummy_transceivers.iter().enumerate() {
        deregister_transceiver(
            &test_data.ntt,
            DeregisterTransceiver {
                owner: test_data.program_owner.pubkey(),
                transceiver: *transceiver,
            },
        )
        .submit_with_signers(&[&test_data.program_owner], &mut ctx)
        .await
        .unwrap();
        assert_threshold(&mut ctx, &test_data, num_dummy_transceivers - idx as u8).await;
    }

    // deregister standalone transceiver
    deregister_transceiver(
        &test_data.ntt,
        DeregisterTransceiver {
            owner: test_data.program_owner.pubkey(),
            transceiver: ntt_transceiver::ID,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();
    assert_threshold(&mut ctx, &test_data, 1).await;

    // reregister dummy transceiver
    for (idx, transceiver) in dummy_transceivers.iter().enumerate() {
        register_transceiver(
            &test_data.ntt,
            RegisterTransceiver {
                payer: ctx.payer.pubkey(),
                owner: test_data.program_owner.pubkey(),
                transceiver: *transceiver,
            },
        )
        .submit_with_signers(&[&test_data.program_owner], &mut ctx)
        .await
        .unwrap();
        assert_transceiver_id(&mut ctx, &test_data, transceiver, idx as u8 + 1).await;
        assert_threshold(&mut ctx, &test_data, 1).await;
    }

    // reregister standalone transceiver
    register_transceiver(
        &test_data.ntt,
        RegisterTransceiver {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
            transceiver: ntt_transceiver::ID,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();
    assert_transceiver_id(&mut ctx, &test_data, &ntt_transceiver::ID, 0).await;
    assert_threshold(&mut ctx, &test_data, 1).await;
}

#[tokio::test]
async fn test_zero_threshold() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let err = set_threshold(
        &test_data.ntt,
        SetThreshold {
            owner: test_data.program_owner.pubkey(),
        },
        0,
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap_err();
    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::ZeroThreshold.into())
        )
    );
}

#[tokio::test]
async fn test_threshold_too_high() {
    let (mut ctx, test_data) = setup(Mode::Burning).await;

    let err = set_threshold(
        &test_data.ntt,
        SetThreshold {
            owner: test_data.program_owner.pubkey(),
        },
        2,
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap_err();
    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(NTTError::ThresholdTooHigh.into())
        )
    );
}
