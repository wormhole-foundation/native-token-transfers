use crate::sdk::{
    accounts::{NTTTransceiver, NTT},
    transceivers::wormhole::accounts::wormhole::wormhole_accounts,
};
use anchor_lang::{prelude::*, InstructionData};
use ntt_transceiver::wormhole::instructions::BroadcastPeerArgs;
use solana_program::instruction::Instruction;

pub struct BroadcastPeer {
    pub payer: Pubkey,
    pub wormhole_message: Pubkey,
    pub chain_id: u16,
}

pub fn broadcast_peer(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    accs: BroadcastPeer,
) -> Instruction {
    let data = ntt_transceiver::instruction::BroadcastWormholePeer {
        args: BroadcastPeerArgs {
            chain_id: accs.chain_id,
        },
    };

    let accounts = ntt_transceiver::accounts::BroadcastPeer {
        payer: accs.payer,
        config: ntt.config(),
        peer: ntt_transceiver.transceiver_peer(accs.chain_id),
        wormhole_message: accs.wormhole_message,
        wormhole: wormhole_accounts(ntt, ntt_transceiver),
    };

    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
