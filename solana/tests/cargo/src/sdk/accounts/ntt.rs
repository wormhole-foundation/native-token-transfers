use anchor_lang::{prelude::Pubkey, Id};
use example_native_token_transfers::{
    config::Config,
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
use wormhole_solana_utils::cpi::bpf_loader_upgradeable;

use crate::sdk::transceivers::accounts::ntt_transceiver::NTTTransceiver;

use super::wormhole::Wormhole;

pub type NTT = dyn NTTAccounts;

pub trait NTTAccounts {
    fn program(&self) -> Pubkey {
        example_native_token_transfers::ID
    }

    fn wormhole(&self) -> Wormhole {
        Wormhole {
            program: wormhole_anchor_sdk::wormhole::program::Wormhole::id(),
        }
    }

    fn config(&self) -> Pubkey {
        let (config, _) = Pubkey::find_program_address(&[Config::SEED_PREFIX], &self.program());
        config
    }

    fn outbox_rate_limit(&self) -> Pubkey {
        let (outbox_rate_limit, _) =
            Pubkey::find_program_address(&[OutboxRateLimit::SEED_PREFIX], &self.program());
        outbox_rate_limit
    }

    fn inbox_rate_limit(&self, chain: u16) -> Pubkey {
        let (inbox_rate_limit, _) = Pubkey::find_program_address(
            &[InboxRateLimit::SEED_PREFIX, &chain.to_be_bytes()],
            &self.program(),
        );
        inbox_rate_limit
    }

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
            &[SESSION_AUTHORITY_SEED, sender.as_ref(), &hasher.finalize()],
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
            &[InboxItem::SEED_PREFIX, &hasher.finalize()],
            &self.program(),
        );
        inbox_item
    }

    fn token_authority(&self) -> Pubkey {
        let (token_authority, _) =
            Pubkey::find_program_address(&[TOKEN_AUTHORITY_SEED], &self.program());
        token_authority
    }

    fn registered_transceiver(&self, transceiver: &Pubkey) -> Pubkey {
        let (registered_transceiver, _) = Pubkey::find_program_address(
            &[RegisteredTransceiver::SEED_PREFIX, transceiver.as_ref()],
            &self.program(),
        );
        registered_transceiver
    }

    fn peer(&self, chain: u16) -> Pubkey {
        let (peer, _) = Pubkey::find_program_address(
            &[b"peer".as_ref(), &chain.to_be_bytes()],
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
        self.wormhole().sequence(&ntt_transceiver.emitter())
    }

    fn program_data(&self) -> Pubkey {
        let (addr, _) =
            Pubkey::find_program_address(&[self.program().as_ref()], &bpf_loader_upgradeable::id());
        addr
    }

    fn upgrade_lock(&self) -> Pubkey {
        let (addr, _) = Pubkey::find_program_address(&[b"upgrade_lock"], &self.program());
        addr
    }
}

/// This implements the account derivations correctly. For negative tests, other
/// implementations will implement them incorrectly.
pub struct GoodNTT {}

#[allow(non_upper_case_globals)]
pub const good_ntt: GoodNTT = GoodNTT {};

impl NTTAccounts for GoodNTT {}
