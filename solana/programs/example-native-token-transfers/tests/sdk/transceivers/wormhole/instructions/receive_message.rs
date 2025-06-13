use crate::sdk::accounts::{NTTTransceiver, NTT};
use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use solana_sdk::instruction::Instruction;

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
    let data = ntt_transceiver::instruction::ReceiveWormholeMessage {};

    let accounts = ntt_transceiver::accounts::ReceiveMessage {
        payer: accs.payer,
        config: ntt_transceiver::accounts::NotPausedConfig {
            config: ntt.config(),
        },
        peer: accs.peer,
        vaa: accs.vaa,
        transceiver_message: ntt_transceiver.transceiver_message(accs.chain_id, accs.id),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
