use anchor_lang::prelude::*;
use example_native_token_transfers::accounts::WormholeAccounts;
use solana_sdk::sysvar::SysvarId;

use crate::sdk::accounts::ntt::NTT;

use super::ntt_transceiver::NTTTransceiver;

pub fn wormhole_accounts(ntt: &NTT, ntt_transceiver: &NTTTransceiver) -> WormholeAccounts {
    WormholeAccounts {
        bridge: ntt.wormhole().bridge(),
        fee_collector: ntt.wormhole().fee_collector(),
        sequence: ntt.wormhole_sequence(ntt_transceiver),
        program: ntt.wormhole().program,
        system_program: System::id(),
        clock: Clock::id(),
        rent: Rent::id(),
    }
}
