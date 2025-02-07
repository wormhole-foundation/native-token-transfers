#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use example_native_token_transfers::error::NTTError;
use ntt_messages::mode::Mode;
use solana_program_test::*;
use solana_sdk::{instruction::InstructionError, signer::Signer, transaction::TransactionError};

use crate::{
    common::{setup::setup, submit::Submittable},
    sdk::instructions::admin::{set_threshold, SetThreshold},
};

pub mod common;
pub mod sdk;

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
