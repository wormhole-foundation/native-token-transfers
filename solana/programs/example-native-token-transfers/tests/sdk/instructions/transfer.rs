use crate::sdk::accounts::NTT;
use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use anchor_spl::{token::Token, token_2022::spl_token_2022};
use example_native_token_transfers::{accounts::NotPausedConfig, instructions::TransferArgs};
use ntt_messages::mode::Mode;
use solana_sdk::instruction::Instruction;

#[derive(Debug, Clone)]
pub struct Transfer {
    pub payer: Pubkey,
    pub mint: Pubkey,
    pub from: Pubkey,
    pub from_authority: Pubkey,
    pub peer: Pubkey,
    pub outbox_item: Pubkey,
}

pub fn transfer(ntt: &NTT, transfer: Transfer, args: TransferArgs, mode: Mode) -> Instruction {
    transfer_with_token_program_id(ntt, transfer, args, mode, &Token::id())
}

pub fn transfer_with_token_program_id(
    ntt: &NTT,
    transfer: Transfer,
    args: TransferArgs,
    mode: Mode,
    token_program_id: &Pubkey,
) -> Instruction {
    match mode {
        Mode::Burning => transfer_burn_with_token_program_id(ntt, transfer, args, token_program_id),
        Mode::Locking => transfer_lock_with_token_program_id(ntt, transfer, args, token_program_id),
    }
}

pub fn transfer_burn(ntt: &NTT, transfer: Transfer, args: TransferArgs) -> Instruction {
    transfer_burn_with_token_program_id(ntt, transfer, args, &Token::id())
}

pub fn transfer_burn_with_token_program_id(
    ntt: &NTT,
    transfer: Transfer,
    args: TransferArgs,
    token_program_id: &Pubkey,
) -> Instruction {
    let chain_id = args.recipient_chain.id;
    let session_authority = ntt.session_authority(&transfer.from_authority, &args);
    let data = example_native_token_transfers::instruction::TransferBurn { args };

    let accounts = example_native_token_transfers::accounts::TransferBurn {
        common: common_with_token_program_id(ntt, &transfer, token_program_id),
        inbox_rate_limit: ntt.inbox_rate_limit(chain_id),
        peer: transfer.peer,
        session_authority,
        token_authority: ntt.token_authority(),
    };

    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn transfer_lock(ntt: &NTT, transfer: Transfer, args: TransferArgs) -> Instruction {
    transfer_lock_with_token_program_id(ntt, transfer, args, &Token::id())
}

pub fn transfer_lock_with_token_program_id(
    ntt: &NTT,
    transfer: Transfer,
    args: TransferArgs,
    token_program_id: &Pubkey,
) -> Instruction {
    let chain_id = args.recipient_chain.id;
    let session_authority = ntt.session_authority(&transfer.from_authority, &args);
    let data = example_native_token_transfers::instruction::TransferLock { args };

    let accounts = example_native_token_transfers::accounts::TransferLock {
        common: common_with_token_program_id(ntt, &transfer, token_program_id),
        inbox_rate_limit: ntt.inbox_rate_limit(chain_id),
        peer: transfer.peer,
        session_authority,
    };
    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn approve_token_authority(
    ntt: &NTT,
    user_token_account: &Pubkey,
    user: &Pubkey,
    args: &TransferArgs,
) -> Instruction {
    approve_token_authority_with_token_program_id(ntt, user_token_account, user, args, &Token::id())
}

pub fn approve_token_authority_with_token_program_id(
    ntt: &NTT,
    user_token_account: &Pubkey,
    user: &Pubkey,
    args: &TransferArgs,
    token_program_id: &Pubkey,
) -> Instruction {
    spl_token_2022::instruction::approve(
        token_program_id,
        user_token_account,
        &ntt.session_authority(user, args),
        user,
        &[user],
        args.amount,
    )
    .unwrap()
}

fn common_with_token_program_id(
    ntt: &NTT,
    transfer: &Transfer,
    token_program_id: &Pubkey,
) -> example_native_token_transfers::accounts::Transfer {
    example_native_token_transfers::accounts::Transfer {
        payer: transfer.payer,
        config: NotPausedConfig {
            config: ntt.config(),
        },
        mint: transfer.mint,
        from: transfer.from,
        token_program: *token_program_id,
        outbox_item: transfer.outbox_item,
        outbox_rate_limit: ntt.outbox_rate_limit(),
        system_program: System::id(),
        custody: ntt.custody_with_token_program_id(&transfer.mint, token_program_id),
    }
}
