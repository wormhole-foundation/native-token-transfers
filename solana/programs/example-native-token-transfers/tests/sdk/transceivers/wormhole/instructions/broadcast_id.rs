use anchor_lang::{prelude::*, InstructionData};
use solana_program::instruction::Instruction;

use crate::sdk::{
    accounts::{NTTTransceiver, NTT},
    wormhole_accounts::wormhole_accounts,
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
        wormhole_message: ntt_transceiver.wormhole_message(),
        wormhole: wormhole_accounts(ntt, ntt_transceiver),
        mint: accounts.mint,
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
