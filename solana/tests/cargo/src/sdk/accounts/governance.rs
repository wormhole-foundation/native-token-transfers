use anchor_lang::prelude::Pubkey;

pub struct Governance {
    pub program: Pubkey,
}

impl Governance {
    pub fn governance(&self) -> Pubkey {
        let (gov, _) = Pubkey::find_program_address(&[b"governance"], &self.program);
        gov
    }
}
