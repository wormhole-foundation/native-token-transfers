use anchor_lang::{prelude::*, InstructionData};
use solana_program::instruction::Instruction;

use crate::sdk::{
    accounts::NTT,
    transceivers::accounts::{wormhole_accounts, NTTTransceiver},
};

pub struct BroadcastId {
    pub payer: Pubkey,
    pub mint: Pubkey,
}

pub fn broadcast_id(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    accounts: BroadcastId,
) -> Instruction {
    let data = ntt_transceiver::instruction::BroadcastWormholeId {};

    let accounts = ntt_transceiver::accounts::BroadcastId {
        payer: accounts.payer,
        config: ntt.config(),
        mint: accounts.mint,
        wormhole_message: ntt_transceiver.wormhole_message(),
        emitter: ntt_transceiver.emitter(),
        wormhole: wormhole_accounts(ntt, ntt_transceiver),
    };

    Instruction {
        program_id: ntt_transceiver.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
