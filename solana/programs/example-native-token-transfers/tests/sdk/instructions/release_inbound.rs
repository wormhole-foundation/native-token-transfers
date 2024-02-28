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
    release_inbound: ReleaseInbound,
    args: ReleaseInboundArgs,
) -> Instruction {
    let data = example_native_token_transfers::instruction::ReleaseInboundUnlock { args };
    let accounts = example_native_token_transfers::accounts::ReleaseInboundUnlock {
        common: example_native_token_transfers::accounts::ReleaseInbound {
            payer: release_inbound.payer,
            config: NotPausedConfig {
                config: ntt.config(),
            },
            inbox_item: release_inbound.inbox_item,
            recipient: release_inbound.recipient,
            token_authority: ntt.token_authority(),
            mint: release_inbound.mint,
            token_program: Token::id(),
        },
        custody: ntt.custody(&release_inbound.mint),
    };
    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
