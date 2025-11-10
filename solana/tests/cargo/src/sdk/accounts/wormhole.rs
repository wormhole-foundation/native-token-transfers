use anchor_lang::prelude::Pubkey;
use wormhole_anchor_sdk::wormhole;

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
