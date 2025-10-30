use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use ntt_transceiver::vaa_body::VaaBodyData;
use solana_sdk::instruction::Instruction;

use crate::sdk::accounts::{NTTTransceiver, NTT};

#[derive(Debug, Clone)]
pub struct ReceiveMessage {
    pub payer: Pubkey,
    pub peer: Pubkey,
    pub chain_id: u16,
    pub id: [u8; 32],
    pub guardian_set: (Pubkey, u8),
    pub guardian_signatures: Pubkey,
}

pub fn receive_message_instruction_data(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    receive_message: ReceiveMessage,
    vaa_body: VaaBodyData,
) -> Instruction {
    let data = ntt_transceiver::instruction::ReceiveWormholeMessageInstructionData {
        guardian_set_bump: receive_message.guardian_set.1,
        vaa_body,
    };

    let accounts = ntt_transceiver::accounts::ReceiveMessageInstructionData {
        payer: receive_message.payer,
        config: ntt_transceiver::accounts::NotPausedConfig {
            config: ntt.config(),
        },
        peer: receive_message.peer,
        transceiver_message: ntt_transceiver
            .transceiver_message(receive_message.chain_id, receive_message.id),
        guardian_set: receive_message.guardian_set.0,
        guardian_signatures: receive_message.guardian_signatures,
        verify_vaa_shim: ntt_transceiver.verify_vaa_shim_shim(),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn receive_message_account(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    receive_message: ReceiveMessage,
    seed: u64,
) -> Instruction {
    let data = ntt_transceiver::instruction::ReceiveWormholeMessageAccount {
        guardian_set_bump: receive_message.guardian_set.1,
        seed,
    };

    let accounts = ntt_transceiver::accounts::ReceiveMessageAccount {
        payer: receive_message.payer,
        config: ntt_transceiver::accounts::NotPausedConfig {
            config: ntt.config(),
        },
        peer: receive_message.peer,
        transceiver_message: ntt_transceiver
            .transceiver_message(receive_message.chain_id, receive_message.id),
        guardian_set: receive_message.guardian_set.0,
        guardian_signatures: receive_message.guardian_signatures,
        verify_vaa_shim: ntt_transceiver.verify_vaa_shim_shim(),
        system_program: System::id(),
        message: ntt_transceiver.unverified_message_account(&receive_message.payer, seed),
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
