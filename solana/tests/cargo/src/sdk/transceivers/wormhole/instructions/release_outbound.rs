use anchor_lang::{prelude::*, InstructionData, ToAccountMetas};
use example_native_token_transfers::accounts::NotPausedConfig;
use ntt_transceiver::wormhole::instructions::ReleaseOutboundArgs;
use solana_sdk::instruction::Instruction;

use crate::sdk::{
    accounts::{NTTTransceiver, NTT},
    transceivers::wormhole::accounts::wormhole::wormhole_accounts,
};

pub struct ReleaseOutbound {
    pub payer: Pubkey,
    pub outbox_item: Pubkey,
}

pub fn release_outbound(
    ntt: &NTT,
    ntt_transceiver: &NTTTransceiver,
    accounts: ReleaseOutbound,
    args: ReleaseOutboundArgs,
) -> Instruction {
    let data = ntt_transceiver::instruction::ReleaseWormholeOutbound { args };
    let accounts = ntt_transceiver::accounts::ReleaseOutbound {
        payer: accounts.payer,
        config: NotPausedConfig {
            config: ntt.config(),
        },
        outbox_item: accounts.outbox_item,
        transceiver: ntt.registered_transceiver(&ntt_transceiver.program()),
        wormhole_message: ntt_transceiver.wormhole_message(),
        emitter: ntt_transceiver.emitter(),
        wormhole: wormhole_accounts(ntt, ntt_transceiver),
        manager: ntt.program(),
        outbox_item_signer: ntt_transceiver.outbox_item_signer(),
    };
    Instruction {
        program_id: ntt_transceiver::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
