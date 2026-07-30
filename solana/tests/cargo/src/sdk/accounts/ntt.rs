use anchor_lang::{prelude::Pubkey, Id};
use example_native_token_transfers::{
    instructions::TransferArgs,
    queue::{
        inbox::{InboxItem, InboxRateLimit},
        outbox::OutboxRateLimit,
    },
    registered_transceiver::RegisteredTransceiver,
    transfer::Payload,
    SESSION_AUTHORITY_SEED, TOKEN_AUTHORITY_SEED,
};
use ntt_messages::{ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage};
use sha3::{Digest, Keccak256};
use wormhole_io::TypePrefixedPayload;

use crate::sdk::transceivers::accounts::ntt_transceiver::NTTTransceiver;

use super::wormhole::Wormhole;

pub type NTT = dyn NTTAccounts;

/// v4 test SDK: every per-instance PDA derivation flows through `config()`,
/// which returns the keypair-created Instance account pubkey for the
/// deployment under test. Implementors hold the pubkey on themselves; the
/// trait abstraction is preserved so negative tests can swap in a `BadNTT`
/// that returns intentionally-wrong addresses.
pub trait NTTAccounts {
    fn program(&self) -> Pubkey {
        example_native_token_transfers::ID
    }

    fn wormhole(&self) -> Wormhole {
        Wormhole {
            program: wormhole_anchor_sdk::wormhole::program::Wormhole::id(),
        }
    }

    /// The instance pubkey for this NTT deployment. In v4 this is also the
    /// on-the-wire NTT manager identity, and the seed scope for every other
    /// per-instance PDA.
    fn config(&self) -> Pubkey;

    fn outbox_rate_limit(&self) -> Pubkey {
        let (outbox_rate_limit, _) = Pubkey::find_program_address(
            &[OutboxRateLimit::SEED_PREFIX, self.config().as_ref()],
            &self.program(),
        );
        outbox_rate_limit
    }

    fn inbox_rate_limit(&self, chain: u16) -> Pubkey {
        let (inbox_rate_limit, _) = Pubkey::find_program_address(
            &[
                InboxRateLimit::SEED_PREFIX,
                self.config().as_ref(),
                &chain.to_be_bytes(),
            ],
            &self.program(),
        );
        inbox_rate_limit
    }

    /// session_authority is per-(sender, transfer_args) — already unique
    /// without instance scoping (matches the program-side seeds).
    fn session_authority(&self, sender: &Pubkey, args: &TransferArgs) -> Pubkey {
        let TransferArgs {
            amount,
            recipient_chain,
            recipient_address,
            should_queue,
        } = args;
        let mut hasher = Keccak256::new();

        hasher.update(amount.to_be_bytes());
        hasher.update(recipient_chain.id.to_be_bytes());
        hasher.update(recipient_address);
        hasher.update([*should_queue as u8]);

        let (session_authority, _) = Pubkey::find_program_address(
            &[
                SESSION_AUTHORITY_SEED,
                self.config().as_ref(),
                sender.as_ref(),
                &hasher.finalize(),
            ],
            &self.program(),
        );
        session_authority
    }

    fn inbox_item(
        &self,
        chain: u16,
        ntt_manager_message: NttManagerMessage<NativeTokenTransfer<Payload>>,
    ) -> Pubkey {
        let mut hasher = Keccak256::new();
        hasher.update(chain.to_be_bytes());
        hasher.update(&TypePrefixedPayload::to_vec_payload(&ntt_manager_message));

        let (inbox_item, _) = Pubkey::find_program_address(
            &[
                InboxItem::SEED_PREFIX,
                self.config().as_ref(),
                &hasher.finalize(),
            ],
            &self.program(),
        );
        inbox_item
    }

    fn token_authority(&self) -> Pubkey {
        let (token_authority, _) = Pubkey::find_program_address(
            &[TOKEN_AUTHORITY_SEED, self.config().as_ref()],
            &self.program(),
        );
        token_authority
    }

    fn registered_transceiver(&self, transceiver: &Pubkey) -> Pubkey {
        let (registered_transceiver, _) = Pubkey::find_program_address(
            &[
                RegisteredTransceiver::SEED_PREFIX,
                self.config().as_ref(),
                transceiver.as_ref(),
            ],
            &self.program(),
        );
        registered_transceiver
    }

    fn peer(&self, chain: u16) -> Pubkey {
        let (peer, _) = Pubkey::find_program_address(
            &[
                b"peer".as_ref(),
                self.config().as_ref(),
                &chain.to_be_bytes(),
            ],
            &self.program(),
        );
        peer
    }

    fn custody(&self, mint: &Pubkey) -> Pubkey {
        self.custody_with_token_program_id(mint, &anchor_spl::token::spl_token::ID)
    }

    fn custody_with_token_program_id(&self, mint: &Pubkey, token_program_id: &Pubkey) -> Pubkey {
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            &self.token_authority(),
            mint,
            token_program_id,
        )
    }

    fn wormhole_sequence(&self, ntt_transceiver: &NTTTransceiver) -> Pubkey {
        // ntt_transceiver carries its own instance binding internally.
        self.wormhole().sequence(&ntt_transceiver.emitter())
    }
}

/// Implements the account derivations correctly for tests. Holds the instance
/// pubkey for this deployment.
pub struct GoodNTT {
    pub instance: Pubkey,
}

impl NTTAccounts for GoodNTT {
    fn config(&self) -> Pubkey {
        self.instance
    }
}

/// Construct a [`GoodNTT`] bound to `instance`. Tests use it like
/// `let ntt = good_ntt(test_data.instance.pubkey());` and then pass `&ntt`
/// to SDK helpers.
pub fn good_ntt(instance: Pubkey) -> GoodNTT {
    GoodNTT { instance }
}
