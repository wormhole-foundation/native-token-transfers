use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use ntt_transceiver::wormhole::PostUnverifiedMessageAccountArgs;
use solana_sdk::instruction::Instruction;

use crate::sdk::accounts::NTTTransceiver;

#[derive(Debug, Clone)]
pub struct UnverifiedMessageAccount {
    pub payer: Pubkey,
}

pub fn post_unverified_message_account(
    ntt_transceiver: &NTTTransceiver,
    accounts: UnverifiedMessageAccount,
    chunk: Vec<u8>,
) -> Instruction {
    let message_size = u32::try_from(chunk.len()).unwrap();
    let data = ntt_transceiver::instruction::PostUnverifiedWormholeMessageAccount {
        args: PostUnverifiedMessageAccountArgs {
            offset: 0,
            chunk,
            message_size,
        },
    };

    let accounts = ntt_transceiver::accounts::PostUnverifiedMessageAccount {
        payer: accounts.payer,
        message: ntt_transceiver.unverified_message_account(&accounts.payer),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn close_unverified_message_account(
    ntt_transceiver: &NTTTransceiver,
    accounts: UnverifiedMessageAccount,
) -> Instruction {
    let data = ntt_transceiver::instruction::CloseUnverifiedWormholeMessageAccount {};

    let accounts = ntt_transceiver::accounts::CloseUnverifiedMessageAccount {
        payer: accounts.payer,
        message: ntt_transceiver.unverified_message_account(&accounts.payer),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
