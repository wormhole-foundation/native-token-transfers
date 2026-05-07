use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token::AssociatedToken, token::Token};
use example_native_token_transfers::instructions::InitializeArgs;
use solana_sdk::instruction::Instruction;

use crate::sdk::accounts::NTT;

/// v4 initialize accounts. The Instance account is keypair-allocated at
/// `ntt.config()`; the caller is responsible for adding that keypair as a
/// signer on the transaction.
pub struct Initialize {
    pub payer: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub multisig_token_authority: Option<Pubkey>,
}

pub fn initialize(ntt: &NTT, accounts: Initialize, args: InitializeArgs) -> Instruction {
    initialize_with_token_program_id(ntt, accounts, args, &Token::id())
}

pub fn initialize_with_token_program_id(
    ntt: &NTT,
    accounts: Initialize,
    args: InitializeArgs,
    token_program_id: &Pubkey,
) -> Instruction {
    let data = example_native_token_transfers::instruction::Initialize { args };

    let accounts = example_native_token_transfers::accounts::Initialize {
        payer: accounts.payer,
        owner: accounts.owner,
        config: ntt.config(),
        mint: accounts.mint,
        rate_limit: ntt.outbox_rate_limit(),
        token_authority: ntt.token_authority(),
        multisig_token_authority: accounts.multisig_token_authority,
        custody: ntt.custody_with_token_program_id(&accounts.mint, token_program_id),
        token_program: *token_program_id,
        associated_token_program: AssociatedToken::id(),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
