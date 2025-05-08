use crate::sdk::{
    accounts::{NTTTransceiver, NTT},
    transceivers::wormhole::accounts::wormhole::wormhole_accounts,
};
use anchor_lang::{prelude::*, InstructionData};
use solana_program::instruction::Instruction;

pub struct BroadcastId {
    pub payer: Pubkey,
    pub wormhole_message: Pubkey,
    pub mint: Pubkey,
}

pub fn broadcast_id(ntt: &NTT, ntt_transceiver: &NTTTransceiver, accs: BroadcastId) -> Instruction {
    let data = ntt_transceiver::instruction::BroadcastWormholeId {};

    let accounts = ntt_transceiver::accounts::BroadcastId {
        payer: accs.payer,
        config: ntt.config(),
        wormhole_message: accs.wormhole_message,
        wormhole: wormhole_accounts(ntt, ntt_transceiver),
        mint: accs.mint,
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
