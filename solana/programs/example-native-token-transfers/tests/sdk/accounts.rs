use anchor_lang::prelude::Pubkey;
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

    pub fn guardian_set(&self, guardian_set_index: u32) -> Pubkey {
        let (guardian_set, _) = Pubkey::find_program_address(
            &[b"GuardianSet", &guardian_set_index.to_be_bytes()],
            &self.program,
        );
        guardian_set
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

pub struct NTT {
    pub program: Pubkey,
    pub wormhole: Wormhole,
}

impl NTT {
    pub fn config(&self) -> Pubkey {
        let (config, _) = Pubkey::find_program_address(&[Config::SEED_PREFIX], &self.program);
        config
    }

    pub fn outbox_rate_limit(&self) -> Pubkey {
        let (outbox_rate_limit, _) =
            Pubkey::find_program_address(&[OutboxRateLimit::SEED_PREFIX], &self.program);
        outbox_rate_limit
    }

    pub fn inbox_rate_limit(&self, chain: u16) -> Pubkey {
        let (inbox_rate_limit, _) = Pubkey::find_program_address(
            &[InboxRateLimit::SEED_PREFIX, &chain.to_be_bytes()],
            &self.program,
        );
        inbox_rate_limit
    }

    pub fn session_authority(&self, sender: &Pubkey, args: &TransferArgs) -> Pubkey {
        let TransferArgs {
            amount,
            recipient_chain,
            recipient_address,
            should_queue,
        } = args;
        let mut hasher = Keccak256::new();

        hasher.update(&amount.to_be_bytes());
        hasher.update(&recipient_chain.id.to_be_bytes());
        hasher.update(&recipient_address);
        hasher.update(&[*should_queue as u8]);

        let (session_authority, _) = Pubkey::find_program_address(
            &[
                SESSION_AUTHORITY_SEED.as_ref(),
                sender.as_ref(),
                &hasher.finalize(),
            ],
            &self.program,
        );
        session_authority
    }

    pub fn inbox_item(
        &self,
        chain: u16,
        ntt_manager_message: NttManagerMessage<NativeTokenTransfer<Payload>>,
    ) -> Pubkey {
        let mut hasher = Keccak256::new();
        hasher.update(chain.to_be_bytes());
        hasher.update(&TypePrefixedPayload::to_vec_payload(&ntt_manager_message));

        let (inbox_item, _) = Pubkey::find_program_address(
            &[InboxItem::SEED_PREFIX, &hasher.finalize()],
            &self.program,
        );
        inbox_item
    }

    pub fn token_authority(&self) -> Pubkey {
        let (token_authority, _) =
            Pubkey::find_program_address(&[TOKEN_AUTHORITY_SEED.as_ref()], &self.program);
        token_authority
    }

    pub fn registered_transceiver(&self, transceiver: &Pubkey) -> Pubkey {
        let (registered_transceiver, _) = Pubkey::find_program_address(
            &[RegisteredTransceiver::SEED_PREFIX, transceiver.as_ref()],
            &self.program,
        );
        registered_transceiver
    }

    pub fn peer(&self, chain: u16) -> Pubkey {
        let (peer, _) =
            Pubkey::find_program_address(&[b"peer".as_ref(), &chain.to_be_bytes()], &self.program);
        peer
    }

    pub fn custody(&self, mint: &Pubkey) -> Pubkey {
        self.custody_with_token_program_id(mint, &spl_token::ID)
    }

    pub fn custody_with_token_program_id(
        &self,
        mint: &Pubkey,
        token_program_id: &Pubkey,
    ) -> Pubkey {
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            &self.token_authority(),
            mint,
            token_program_id,
        )
    }

    pub fn wormhole_sequence(&self, ntt_transceiver: &NTTTransceiver) -> Pubkey {
        self.wormhole.sequence(&ntt_transceiver.emitter())
    }

    pub fn program_data(&self) -> Pubkey {
        let (addr, _) =
            Pubkey::find_program_address(&[self.program.as_ref()], &bpf_loader_upgradeable::id());
        addr
    }

    pub fn upgrade_lock(&self) -> Pubkey {
        let (addr, _) = Pubkey::find_program_address(&[b"upgrade_lock"], &self.program);
        addr
    }
}

pub struct NTTTransceiver {
    pub program: Pubkey,
}

impl NTTTransceiver {
    pub fn emitter(&self) -> Pubkey {
        let (emitter, _) = Pubkey::find_program_address(&[b"emitter".as_ref()], &self.program);
        emitter
    }

    pub fn outbox_item_signer(&self) -> Pubkey {
        let (outbox_item_signer, _) =
            Pubkey::find_program_address(&[b"outbox_item_signer".as_ref()], &self.program);
        outbox_item_signer
    }

    pub fn wormhole_message(&self, outbox_item: &Pubkey) -> Pubkey {
        let (wormhole_message, _) = Pubkey::find_program_address(
            &[b"message".as_ref(), outbox_item.as_ref()],
            &self.program,
        );
        wormhole_message
    }

    pub fn transceiver_peer(&self, chain: u16) -> Pubkey {
        let (peer, _) = Pubkey::find_program_address(
            &[b"transceiver_peer".as_ref(), &chain.to_be_bytes()],
            &self.program,
        );
        peer
    }

    pub fn transceiver_message(&self, chain: u16, id: [u8; 32]) -> Pubkey {
        let (transceiver_message, _) = Pubkey::find_program_address(
            &[b"transceiver_message".as_ref(), &chain.to_be_bytes(), &id],
            &self.program,
        );
        transceiver_message
    }
}
