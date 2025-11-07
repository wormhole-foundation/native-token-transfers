use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use solana_sdk::instruction::Instruction;

use crate::sdk::{accounts::NTT, transceivers::accounts::NTTTransceiver};

#[derive(Debug, Clone)]
pub struct ReceiveMessage {
    pub payer: Pubkey,
    pub peer: Pubkey,
    pub vaa: Pubkey,
    pub chain_id: u16,
    pub id: [u8; 32],
}

pub fn receive_message(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    accs: ReceiveMessage,
) -> Instruction {
    let data = example_native_token_transfers::instruction::ReceiveWormholeMessage {};

    let accounts = example_native_token_transfers::accounts::ReceiveMessage {
        payer: accs.payer,
        config: example_native_token_transfers::accounts::NotPausedConfig {
            config: ntt.config(),
        },
        peer: accs.peer,
        vaa: accs.vaa,
        transceiver_message: ntt_transceiver.transceiver_message(accs.chain_id, accs.id),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt_transceiver.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
