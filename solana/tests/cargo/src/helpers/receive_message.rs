use anchor_lang::prelude::Pubkey;
use solana_program_test::ProgramTestContext;
use solana_sdk::signer::Signer;

use crate::sdk::transceivers::{
    accounts::NTTTransceiver, instructions::receive_message::ReceiveMessage,
};

cfg_if! {
    if #[cfg(feature = "shim")] {
        use crate::sdk::accounts::NTT;

        pub fn init_receive_message_accs(
            ntt: &NTT,
            ntt_transceiver: &NTTTransceiver,
            ctx: &mut ProgramTestContext,
            chain_id: u16,
            id: [u8; 32],
            guardian_set_index: u32,
            guardian_signatures: Pubkey,
        ) -> ReceiveMessage {
            ReceiveMessage {
                payer: ctx.payer.pubkey(),
                peer: ntt_transceiver.transceiver_peer(chain_id),
                chain_id,
                id,
                guardian_set: ntt
                    .wormhole()
                    .guardian_set_with_bump(guardian_set_index),
                guardian_signatures,
            }
        }
    } else {
        pub fn init_receive_message_accs(
            ntt_transceiver: &NTTTransceiver,
            ctx: &mut ProgramTestContext,
            vaa: Pubkey,
            chain_id: u16,
            id: [u8; 32],
        ) -> ReceiveMessage {
            ReceiveMessage {
                payer: ctx.payer.pubkey(),
                peer: ntt_transceiver.transceiver_peer(chain_id),
                vaa,
                chain_id,
                id,
            }
        }
    }
}
