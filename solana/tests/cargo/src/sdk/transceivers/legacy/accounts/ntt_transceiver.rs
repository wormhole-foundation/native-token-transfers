use anchor_lang::prelude::Pubkey;

pub type NTTTransceiver = dyn NTTTransceiverAccounts;

/// v4: emitter, transceiver_peer, transceiver_message PDAs are scoped by the
/// instance pubkey; implementors carry it. wormhole_message and
/// unverified_message_account are content-addressed and don't need instance
/// scoping.
pub trait NTTTransceiverAccounts {
    fn program(&self) -> Pubkey {
        example_native_token_transfers::ID
    }

    fn config(&self) -> Pubkey;

    fn emitter(&self) -> Pubkey {
        let (emitter, _) = Pubkey::find_program_address(
            &[b"emitter".as_ref(), self.config().as_ref()],
            &self.program(),
        );
        emitter
    }

    fn wormhole_message(&self, outbox_item: &Pubkey) -> Pubkey {
        let (wormhole_message, _) = Pubkey::find_program_address(
            &[b"message".as_ref(), outbox_item.as_ref()],
            &self.program(),
        );
        wormhole_message
    }

    fn transceiver_peer(&self, chain: u16) -> Pubkey {
        let (peer, _) = Pubkey::find_program_address(
            &[
                b"transceiver_peer".as_ref(),
                self.config().as_ref(),
                &chain.to_be_bytes(),
            ],
            &self.program(),
        );
        peer
    }

    fn transceiver_message(&self, chain: u16, id: [u8; 32]) -> Pubkey {
        let (transceiver_message, _) = Pubkey::find_program_address(
            &[
                b"transceiver_message".as_ref(),
                self.config().as_ref(),
                &chain.to_be_bytes(),
                &id,
            ],
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

/// Holds the instance pubkey for this deployment. For negative tests, other
/// implementations can return wrong addresses.
pub struct GoodNTTTransceiver {
    pub instance: Pubkey,
}

impl NTTTransceiverAccounts for GoodNTTTransceiver {
    fn config(&self) -> Pubkey {
        self.instance
    }
}

pub fn good_ntt_transceiver(instance: Pubkey) -> GoodNTTTransceiver {
    GoodNTTTransceiver { instance }
}
