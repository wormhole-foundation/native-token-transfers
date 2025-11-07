use anchor_lang::{prelude::*, InstructionData};
use anchor_spl::token::Token;
use example_native_token_transfers::{accounts::NotPausedConfig, instructions::ReleaseInboundArgs};
use solana_sdk::instruction::Instruction;

use crate::sdk::accounts::NTT;

pub struct ReleaseInbound {
    pub payer: Pubkey,
    pub inbox_item: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
}

pub fn release_inbound_unlock(
    ntt: &NTT,
    accounts: ReleaseInbound,
    args: ReleaseInboundArgs,
) -> Instruction {
    let data = example_native_token_transfers::instruction::ReleaseInboundUnlock { args };
    let accounts = example_native_token_transfers::accounts::ReleaseInboundUnlock {
        common: example_native_token_transfers::accounts::ReleaseInbound {
            payer: accounts.payer,
            config: NotPausedConfig {
                config: ntt.config(),
            },
            inbox_item: accounts.inbox_item,
            recipient: accounts.recipient,
            token_authority: ntt.token_authority(),
            mint: accounts.mint,
            token_program: Token::id(),
            custody: ntt.custody(&accounts.mint),
        },
    };
    Instruction {
        program_id: ntt.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
