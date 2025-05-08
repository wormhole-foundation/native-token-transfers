#![cfg(feature = "test-sbf")]
#![feature(type_changing_struct_update)]

use std::sync::atomic::AtomicU64;

use crate::{
    common::{query::GetAccountDataAnchor, setup::setup, submit::Submittable},
    sdk::instructions::{
        admin::{set_paused, SetPaused},
        post_vaa::post_vaa,
    },
};
use anchor_lang::{prelude::*, InstructionData};
use example_native_token_transfers::config::Config;
use ntt_messages::mode::Mode;
use sdk::accounts::{Governance, Wormhole};
use solana_program::{
    instruction::{Instruction, InstructionError},
    system_instruction::SystemError,
};
use solana_program_test::*;
use solana_sdk::{signer::Signer, transaction::TransactionError};
use wormhole_governance::{
    error::GovernanceError,
    instructions::{GovernanceMessage, ReplayProtection, OWNER},
};
use wormhole_sdk::{Address, Vaa, GOVERNANCE_EMITTER};
use wormhole_solana_utils::cpi::bpf_loader_upgradeable;

pub mod common;
pub mod sdk;

async fn post_governance_vaa<A: Clone + AnchorSerialize>(
    ctx: &mut ProgramTestContext,
    wormhole: &Wormhole,
    gov_message: A,
    emitter_override: Option<Address>,
    vaa: Option<Vaa<A>>,
) -> (Pubkey, Vaa<A>) {
    let vaa = vaa.unwrap_or({
        static I: AtomicU64 = AtomicU64::new(0);
        let sequence = I.fetch_add(1, std::sync::atomic::Ordering::Acquire);

        Vaa {
            version: 1,
            guardian_set_index: 0,
            signatures: vec![],
            timestamp: 123232,
            nonce: 0,
            emitter_chain: wormhole_sdk::Chain::Solana,
            emitter_address: emitter_override.unwrap_or(GOVERNANCE_EMITTER),
            sequence,
            consistency_level: 0,
            payload: gov_message,
        }
    });

    (post_vaa(wormhole, ctx, vaa.clone()).await, vaa)
}

#[tokio::test]
async fn test_governance() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let governance_pda = test_data.governance.governance();

    // step 1. transfer ownership to governance
    let ix = example_native_token_transfers::instruction::TransferOwnership;

    let accs = example_native_token_transfers::accounts::TransferOwnership {
        config: test_data.ntt.config(),
        owner: test_data.program_owner.pubkey(),
        new_owner: governance_pda,
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    Instruction {
        program_id: test_data.ntt.program,
        accounts: accs.to_account_metas(None),
        data: ix.data(),
    }
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();

    // step 2. claim ownership
    let inner_ix_data = example_native_token_transfers::instruction::ClaimOwnership {};
    let inner_ix_accs = example_native_token_transfers::accounts::ClaimOwnership {
        new_owner: OWNER,
        config: test_data.ntt.config(),
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    let inner_ix: Instruction = Instruction {
        program_id: test_data.ntt.program,
        accounts: inner_ix_accs.to_account_metas(None),
        data: inner_ix_data.data(),
    };

    let config_account: Config = ctx.get_account_data_anchor(test_data.ntt.config()).await;
    assert!(!config_account.paused); // make sure not paused before

    wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        inner_ix,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // step 3. set paused
    wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        set_paused(&test_data.ntt, SetPaused { owner: OWNER }, true),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let config_account: Config = ctx.get_account_data_anchor(test_data.ntt.config()).await;
    assert!(config_account.paused);
}

#[tokio::test]
async fn test_governance_one_step_transfer() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let governance_pda = test_data.governance.governance();

    // step 1. transfer ownership to governance (1 step)
    let ix = example_native_token_transfers::instruction::TransferOwnershipOneStepUnchecked;

    let accs = example_native_token_transfers::accounts::TransferOwnership {
        config: test_data.ntt.config(),
        owner: test_data.program_owner.pubkey(),
        new_owner: governance_pda,
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    Instruction {
        program_id: test_data.ntt.program,
        accounts: accs.to_account_metas(None),
        data: ix.data(),
    }
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();

    let config_account: Config = ctx.get_account_data_anchor(test_data.ntt.config()).await;
    assert!(!config_account.paused); // make sure not paused before

    // step 2. set paused
    wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        set_paused(&test_data.ntt, SetPaused { owner: OWNER }, true),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let config_account: Config = ctx.get_account_data_anchor(test_data.ntt.config()).await;
    assert!(config_account.paused);
}

#[tokio::test]
async fn test_governance_bad_emitter() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let err = wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        set_paused(&test_data.ntt, SetPaused { owner: OWNER }, true),
        Some(Address::default()),
        None,
        None,
    )
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(GovernanceError::InvalidGovernanceEmitter.into())
        )
    );
}

#[tokio::test]
async fn test_governance_bad_governance_contract() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let governance_pda = test_data.governance.governance();

    // step 1. transfer ownership to governance
    let ix = example_native_token_transfers::instruction::TransferOwnership;

    let accs = example_native_token_transfers::accounts::TransferOwnership {
        config: test_data.ntt.config(),
        owner: test_data.program_owner.pubkey(),
        new_owner: governance_pda,
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    Instruction {
        program_id: test_data.ntt.program,
        accounts: accs.to_account_metas(None),
        data: ix.data(),
    }
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();

    // step 2. claim ownership
    let inner_ix_data = example_native_token_transfers::instruction::ClaimOwnership {};
    let inner_ix_accs = example_native_token_transfers::accounts::ClaimOwnership {
        new_owner: OWNER,
        config: test_data.ntt.config(),
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    let inner_ix: Instruction = Instruction {
        program_id: test_data.ntt.program,
        accounts: inner_ix_accs.to_account_metas(None),
        data: inner_ix_data.data(),
    };

    let err = wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        inner_ix.clone(),
        None,
        Some(Pubkey::new_unique()),
        None,
    )
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(GovernanceError::InvalidGovernanceProgram.into())
        )
    );
}

#[tokio::test]
async fn test_governance_replay() {
    let (mut ctx, test_data) = setup(Mode::Locking).await;

    let governance_pda = test_data.governance.governance();

    // step 1. transfer ownership to governance
    let ix = example_native_token_transfers::instruction::TransferOwnership;

    let accs = example_native_token_transfers::accounts::TransferOwnership {
        config: test_data.ntt.config(),
        owner: test_data.program_owner.pubkey(),
        new_owner: governance_pda,
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    Instruction {
        program_id: test_data.ntt.program,
        accounts: accs.to_account_metas(None),
        data: ix.data(),
    }
    .submit_with_signers(&[&test_data.program_owner], &mut ctx)
    .await
    .unwrap();

    // step 2. claim ownership
    let inner_ix_data = example_native_token_transfers::instruction::ClaimOwnership {};
    let inner_ix_accs = example_native_token_transfers::accounts::ClaimOwnership {
        new_owner: OWNER,
        config: test_data.ntt.config(),
        upgrade_lock: test_data.ntt.upgrade_lock(),
        program_data: test_data.ntt.program_data(),
        bpf_loader_upgradeable_program: bpf_loader_upgradeable::id(),
    };

    let inner_ix: Instruction = Instruction {
        program_id: test_data.ntt.program,
        accounts: inner_ix_accs.to_account_metas(None),
        data: inner_ix_data.data(),
    };

    let vaa = wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        inner_ix.clone(),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // step 3. replay
    let err = wrap_governance(
        &mut ctx,
        &test_data.governance,
        &test_data.ntt.wormhole,
        inner_ix,
        None,
        None,
        Some(vaa),
    )
    .await
    .unwrap_err();

    assert_eq!(
        err.unwrap(),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(SystemError::AccountAlreadyInUse as u32)
        )
    );
}

// TODO: move (some of) this into the governance library
async fn wrap_governance(
    ctx: &mut ProgramTestContext,
    gov_program: &Governance,
    wormhole: &Wormhole,
    ix: Instruction,
    emitter_override: Option<Address>,
    governance_program_override: Option<Pubkey>,
    vaa: Option<Vaa<GovernanceMessage>>,
) -> core::result::Result<Vaa<GovernanceMessage>, BanksClientError> {
    let program = ix.program_id;
    let data = wormhole_governance::instruction::Governance {};

    let mut gov_message: GovernanceMessage = ix.clone().into();

    if let Some(gov_program) = governance_program_override {
        gov_message.governance_program_id = gov_program;
    }

    let (vaa_key, vaa) =
        post_governance_vaa(ctx, wormhole, gov_message, emitter_override, vaa).await;

    let (replay, _) = Pubkey::find_program_address(
        &[
            &ReplayProtection::SEED_PREFIX,
            &u16::from(vaa.emitter_chain).to_be_bytes(),
            &vaa.emitter_address.0.as_ref(),
            &vaa.sequence.to_be_bytes(),
        ],
        &gov_program.program,
    );

    let gov_accounts = wormhole_governance::accounts::Governance {
        payer: ctx.payer.pubkey(),
        governance: gov_program.governance(),
        vaa: vaa_key,
        program,
        replay,
        system_program: System::id(),
    };

    let mut accounts = gov_accounts.to_account_metas(None);

    let remaining_accounts = ix.accounts.iter().map(|acc| AccountMeta {
        is_signer: false,
        ..acc.clone()
    });

    accounts.extend(remaining_accounts);

    let gov_ix = Instruction {
        program_id: gov_program.program,
        accounts,
        data: data.data(),
    };

    gov_ix.submit(ctx).await?;
    Ok(vaa)
}
