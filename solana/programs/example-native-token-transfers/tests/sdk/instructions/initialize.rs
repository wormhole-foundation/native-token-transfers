use crate::sdk::accounts::NTT;
use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token::AssociatedToken, token::Token};
use example_native_token_transfers::instructions::InitializeArgs;
use solana_sdk::instruction::Instruction;
use wormhole_solana_utils::cpi::bpf_loader_upgradeable::BpfLoaderUpgradeable;

pub struct Initialize {
    pub payer: Pubkey,
    pub deployer: Pubkey,
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

    let bpf_loader_upgradeable_program = BpfLoaderUpgradeable::id();
    let accounts = example_native_token_transfers::accounts::Initialize {
        payer: accounts.payer,
        deployer: accounts.deployer,
        program_data: ntt.program_data(),
        config: ntt.config(),
        mint: accounts.mint,
        rate_limit: ntt.outbox_rate_limit(),
        token_authority: ntt.token_authority(),
        multisig_token_authority: accounts.multisig_token_authority,
        custody: ntt.custody_with_token_program_id(&accounts.mint, token_program_id),
        token_program: *token_program_id,
        associated_token_program: AssociatedToken::id(),
        bpf_loader_upgradeable_program,
        system_program: System::id(),
    };

    // fetch account
    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
