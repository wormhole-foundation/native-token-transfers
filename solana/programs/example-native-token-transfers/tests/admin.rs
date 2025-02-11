#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use example_native_token_transfers::{config::Config, error::NTTError};
use ntt_messages::mode::Mode;
use solana_program_test::*;
use solana_sdk::{instruction::InstructionError, signer::Signer, transaction::TransactionError};

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

#[tokio::test]
async fn test_reregister_all_transceivers() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    // register ntt_transceiver
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

    // set threshold to 2
    set_threshold(
        &test_data.ntt,
        SetThreshold {
            owner: test_data.program_owner.pubkey(),
        },
        2,
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();

    // deregister ntt_transceiver
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

    // deregister baked-in transceiver
    deregister_transceiver(
        &test_data.ntt,
        DeregisterTransceiver {
            owner: test_data.program_owner.pubkey(),
            transceiver: example_native_token_transfers::ID,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();
    assert_threshold(&mut ctx, &test_data, 1).await;

    // reregister ntt_transceiver
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
    assert_threshold(&mut ctx, &test_data, 1).await;

    // reregister baked-in transceiver
    register_transceiver(
        &test_data.ntt,
        RegisterTransceiver {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
            transceiver: example_native_token_transfers::ID,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();
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
