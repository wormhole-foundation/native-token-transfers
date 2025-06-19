use crate::sdk::accounts::NTT;
use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use example_native_token_transfers::instructions::RedeemArgs;
use solana_sdk::instruction::Instruction;

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

pub fn redeem(ntt: &NTT, accs: Redeem, args: RedeemArgs) -> Instruction {
    let data = example_native_token_transfers::instruction::Redeem { args };

    let accounts = example_native_token_transfers::accounts::Redeem {
        payer: accs.payer,
        config: ntt.config(),
        peer: accs.peer,
        transceiver_message: accs.transceiver_message,
        transceiver: ntt.registered_transceiver(&accs.transceiver),
        mint: accs.mint,
        inbox_item: accs.inbox_item,
        inbox_rate_limit: accs.inbox_rate_limit,
        outbox_rate_limit: ntt.outbox_rate_limit(),
        system_program: System::id(),
    };

    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
