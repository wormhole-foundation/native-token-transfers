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
use wormhole_anchor_sdk::wormhole;
use wormhole_io::TypePrefixedPayload;
use wormhole_solana_utils::cpi::bpf_loader_upgradeable;
use wormhole_svm_definitions::{
    solana::{POST_MESSAGE_SHIM_PROGRAM_ID, VERIFY_VAA_SHIM_PROGRAM_ID},
    EVENT_AUTHORITY_SEED,
};

pub struct Wormhole {
    pub program: Pubkey,
}

impl Wormhole {
    pub fn bridge(&self) -> Pubkey {
        let (bridge, _) =
            Pubkey::find_program_address(&[wormhole::BridgeData::SEED_PREFIX], &self.program);
        bridge
    }

    pub fn fee_collector(&self) -> Pubkey {
        let (fee_collector, _) =
            Pubkey::find_program_address(&[wormhole::FeeCollector::SEED_PREFIX], &self.program);
        fee_collector
    }

    pub fn sequence(&self, emitter: &Pubkey) -> Pubkey {
        let (sequence, _) = Pubkey::find_program_address(
            &[wormhole::SequenceTracker::SEED_PREFIX, emitter.as_ref()],
            &self.program,
        );
        sequence
    }

    pub fn guardian_set_with_bump(&self, guardian_set_index: u32) -> (Pubkey, u8) {
        let (guardian_set, guardian_set_bump) = Pubkey::find_program_address(
            &[b"GuardianSet", &guardian_set_index.to_be_bytes()],
            &self.program,
        );
        (guardian_set, guardian_set_bump)
    }

    pub fn guardian_set(&self, guardian_set_index: u32) -> Pubkey {
        self.guardian_set_with_bump(guardian_set_index).0
    }

    pub fn posted_vaa(&self, vaa_hash: &[u8]) -> Pubkey {
        let (posted_vaa, _) =
            Pubkey::find_program_address(&[b"PostedVAA", vaa_hash], &self.program);
        posted_vaa
    }
}

pub struct Governance {
    pub program: Pubkey,
}

impl Governance {
    pub fn governance(&self) -> Pubkey {
        let (gov, _) = Pubkey::find_program_address(&[b"governance"], &self.program);
        gov
    }
}

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
        self.custody_with_token_program_id(mint, &spl_token::ID)
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

pub struct PostMessageShim {
    pub program: Pubkey,
}

impl PostMessageShim {
    pub fn event_authority(&self) -> Pubkey {
        let (event_authority, _) =
            Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], &self.program);
        event_authority
    }
}

impl NTTAccounts for GoodNTT {}

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

    fn wormhole_message_with_shim(&self) -> Pubkey {
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

    fn unverified_message_account(&self, payer: &Pubkey) -> Pubkey {
        let (unverified_message_account, _) =
            Pubkey::find_program_address(&[b"vaa_body".as_ref(), payer.as_ref()], &self.program());
        unverified_message_account
    }
}

/// This implements the account derivations correctly. For negative tests, other
/// implementations will implement them incorrectly.
pub struct GoodNTTTransceiver {}

#[allow(non_upper_case_globals)]
pub const good_ntt_transceiver: GoodNTTTransceiver = GoodNTTTransceiver {};

impl NTTTransceiverAccounts for GoodNTTTransceiver {}
