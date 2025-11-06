use anchor_lang::prelude::Pubkey;
use wormhole_svm_definitions::EVENT_AUTHORITY_SEED;

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
