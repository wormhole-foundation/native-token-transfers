use anchor_lang::{prelude::*, InstructionData};
use solana_program::instruction::Instruction;

use crate::sdk::{
    accounts::NTT,
    transceivers::accounts::{wormhole_accounts, NTTTransceiver},
};

pub struct BroadcastId {
    pub payer: Pubkey,
    pub wormhole_message: Pubkey,
    pub mint: Pubkey,
}

pub fn broadcast_id(ntt: &NTT, ntt_transceiver: &NTTTransceiver, accs: BroadcastId) -> Instruction {
    let data = example_native_token_transfers::instruction::BroadcastWormholeId {};

    let accounts = example_native_token_transfers::accounts::BroadcastId {
        payer: accs.payer,
        config: ntt.config(),
        wormhole_message: accs.wormhole_message,
        emitter: ntt_transceiver.emitter(),
        wormhole: wormhole_accounts(ntt, ntt_transceiver),
        mint: accs.mint,
    };

    Instruction {
        program_id: ntt_transceiver.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
