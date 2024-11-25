use anchor_lang::{prelude::*, InstructionData};
use example_native_token_transfers::transceivers::wormhole::BroadcastPeerArgs;
use solana_program::instruction::Instruction;

use crate::sdk::{accounts::NTT, transceivers::wormhole::accounts::wormhole::wormhole_accounts};

pub struct BroadcastPeer {
    pub payer: Pubkey,
    pub wormhole_message: Pubkey,
    pub chain_id: u16,
}

pub fn broadcast_peer(ntt: &NTT, accs: BroadcastPeer) -> Instruction {
    let data = example_native_token_transfers::instruction::BroadcastWormholePeer {
        args: BroadcastPeerArgs {
            chain_id: accs.chain_id,
        },
    };

    let accounts = example_native_token_transfers::accounts::BroadcastPeer {
        payer: accs.payer,
        config: ntt.config(),
        peer: ntt.transceiver_peer(accs.chain_id),
        wormhole_message: accs.wormhole_message,
        emitter: ntt.emitter(),
        wormhole: wormhole_accounts(ntt),
    };

    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
