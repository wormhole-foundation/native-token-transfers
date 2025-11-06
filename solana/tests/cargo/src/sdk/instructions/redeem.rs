use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use example_native_token_transfers::instructions::RedeemArgs;
use solana_sdk::instruction::Instruction;

use crate::sdk::accounts::NTT;

#[derive(Debug, Clone)]
pub struct Redeem {
    pub payer: Pubkey,
    pub peer: Pubkey,
    pub transceiver_message: Pubkey,
    pub transceiver: Pubkey,
    pub mint: Pubkey,
    pub inbox_item: Pubkey,
    pub inbox_rate_limit: Pubkey,
}

pub fn redeem(ntt: &NTT, accounts: Redeem, args: RedeemArgs) -> Instruction {
    let data = example_native_token_transfers::instruction::Redeem { args };

    let accounts = example_native_token_transfers::accounts::Redeem {
        payer: accounts.payer,
        config: ntt.config(),
        peer: accounts.peer,
        transceiver_message: accounts.transceiver_message,
        transceiver: ntt.registered_transceiver(&accounts.transceiver),
        mint: accounts.mint,
        inbox_item: accounts.inbox_item,
        inbox_rate_limit: accounts.inbox_rate_limit,
        outbox_rate_limit: ntt.outbox_rate_limit(),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
