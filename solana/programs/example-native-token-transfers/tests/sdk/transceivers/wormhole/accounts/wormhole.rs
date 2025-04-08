use crate::sdk::accounts::{NTTTransceiver, NTT};
use anchor_lang::prelude::*;
use ntt_transceiver::accounts::WormholeAccounts;
use solana_sdk::sysvar::SysvarId;

pub fn wormhole_accounts(ntt: &NTT, ntt_transceiver: &NTTTransceiver) -> WormholeAccounts {
    WormholeAccounts {
        bridge: ntt.wormhole.bridge(),
        fee_collector: ntt.wormhole.fee_collector(),
        sequence: ntt.wormhole_sequence(ntt_transceiver),
        program: ntt.wormhole.program,
        system_program: System::id(),
        clock: Clock::id(),
        rent: Rent::id(),
        transceiver: ntt_transceiver.program,
        emitter: ntt_transceiver.emitter(),
    }
}
