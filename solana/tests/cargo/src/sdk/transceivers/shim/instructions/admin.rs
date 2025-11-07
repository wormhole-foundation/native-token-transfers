use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
pub use ntt_transceiver::wormhole::instructions::SetTransceiverPeerArgs;
use solana_sdk::instruction::Instruction;

use crate::sdk::{accounts::NTT, transceivers::accounts::NTTTransceiver};

pub struct SetTransceiverPeer {
    pub payer: Pubkey,
    pub owner: Pubkey,
}

pub fn set_transceiver_peer(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    accounts: SetTransceiverPeer,
    args: SetTransceiverPeerArgs,
) -> Instruction {
    let chain_id = args.chain_id.id;
    let data = ntt_transceiver::instruction::SetWormholePeer { args };

    let accounts = ntt_transceiver::accounts::SetTransceiverPeer {
        config: ntt.config(),
        owner: accounts.owner,
        payer: accounts.payer,
        peer: ntt_transceiver.transceiver_peer(chain_id),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt_transceiver.program(),
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
