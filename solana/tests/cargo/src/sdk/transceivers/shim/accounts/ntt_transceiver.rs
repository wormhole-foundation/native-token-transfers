use anchor_lang::prelude::Pubkey;
use wormhole_svm_definitions::solana::{POST_MESSAGE_SHIM_PROGRAM_ID, VERIFY_VAA_SHIM_PROGRAM_ID};

use super::post_message_shim::PostMessageShim;

pub type NTTTransceiver = dyn NTTTransceiverAccounts;

pub trait NTTTransceiverAccounts {
    fn program(&self) -> Pubkey {
        ntt_transceiver::ID
    }

    fn post_message_shim(&self) -> PostMessageShim {
        PostMessageShim {
            program: POST_MESSAGE_SHIM_PROGRAM_ID,
        }
    }

    fn verify_vaa_shim_shim(&self) -> Pubkey {
        VERIFY_VAA_SHIM_PROGRAM_ID
    }

    fn emitter(&self) -> Pubkey {
        let (emitter, _) = Pubkey::find_program_address(&[b"emitter".as_ref()], &self.program());
        emitter
    }

    fn outbox_item_signer(&self) -> Pubkey {
        let (outbox_item_signer, _) =
            Pubkey::find_program_address(&[b"outbox_item_signer".as_ref()], &self.program());
        outbox_item_signer
    }

    fn wormhole_message(&self) -> Pubkey {
        let (wormhole_message, _) = Pubkey::find_program_address(
            &[self.emitter().as_ref()],
            &self.post_message_shim().program,
        );
        wormhole_message
    }

    fn transceiver_peer(&self, chain: u16) -> Pubkey {
        let (peer, _) = Pubkey::find_program_address(
            &[b"transceiver_peer".as_ref(), &chain.to_be_bytes()],
            &self.program(),
        );
        peer
    }

    fn transceiver_message(&self, chain: u16, id: [u8; 32]) -> Pubkey {
        let (transceiver_message, _) = Pubkey::find_program_address(
            &[b"transceiver_message".as_ref(), &chain.to_be_bytes(), &id],
            &self.program(),
        );
        transceiver_message
    }

    fn unverified_message_account(&self, payer: &Pubkey, seed: u64) -> Pubkey {
        let (unverified_message_account, _) = Pubkey::find_program_address(
            &[b"vaa_body".as_ref(), payer.as_ref(), &seed.to_be_bytes()],
            &self.program(),
        );
        unverified_message_account
    }
}

/// This implements the account derivations correctly. For negative tests, other
/// implementations will implement them incorrectly.
pub struct GoodNTTTransceiver {}

#[allow(non_upper_case_globals)]
pub const good_ntt_transceiver: GoodNTTTransceiver = GoodNTTTransceiver {};

impl NTTTransceiverAccounts for GoodNTTTransceiver {}
