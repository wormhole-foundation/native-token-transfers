use anchor_lang::{prelude::*, InstructionData};
use ntt_transceiver::wormhole::instructions::BroadcastPeerArgs;
use solana_program::instruction::Instruction;

use crate::sdk::{
    accounts::NTT,
    transceivers::accounts::{wormhole_accounts, NTTTransceiver},
};

pub struct BroadcastPeer {
    pub payer: Pubkey,
    pub chain_id: u16,
}

pub fn broadcast_peer(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    accounts: BroadcastPeer,
) -> Instruction {
    let data = ntt_transceiver::instruction::BroadcastWormholePeer {
        args: BroadcastPeerArgs {
            chain_id: accounts.chain_id,
        },
    };

    let accounts = ntt_transceiver::accounts::BroadcastPeer {
        payer: accounts.payer,
        config: ntt.config(),
        peer: ntt_transceiver.transceiver_peer(accounts.chain_id),
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
