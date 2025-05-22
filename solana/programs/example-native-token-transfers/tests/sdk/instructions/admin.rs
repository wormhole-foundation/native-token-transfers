use anchor_lang::{prelude::Pubkey, system_program::System, Id, InstructionData, ToAccountMetas};
use example_native_token_transfers::instructions::SetPeerArgs;
use solana_sdk::instruction::Instruction;

use crate::sdk::accounts::NTT;

pub struct SetPeer {
    pub payer: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
}

pub fn set_peer(ntt: &NTT, accounts: SetPeer, args: SetPeerArgs) -> Instruction {
    let chain_id = args.chain_id.id;
    let data = example_native_token_transfers::instruction::SetPeer { args };

    let accounts = example_native_token_transfers::accounts::SetPeer {
        config: ntt.config(),
        owner: accounts.owner,
        payer: accounts.payer,
        peer: ntt.peer(chain_id),
        inbox_rate_limit: ntt.inbox_rate_limit(chain_id),
        system_program: System::id(),
    };

    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub struct SetPaused {
    pub owner: Pubkey,
}

pub fn set_paused(ntt: &NTT, accounts: SetPaused, pause: bool) -> Instruction {
    let data = example_native_token_transfers::instruction::SetPaused { pause };

    let accounts = example_native_token_transfers::accounts::SetPaused {
        owner: accounts.owner,
        config: ntt.config(),
    };

    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub struct RegisterTransceiver {
    pub payer: Pubkey,
    pub owner: Pubkey,
    pub transceiver: Pubkey,
}

pub fn register_transceiver(ntt: &NTT, accounts: RegisterTransceiver) -> Instruction {
    let data = example_native_token_transfers::instruction::RegisterTransceiver {};

    let accounts = example_native_token_transfers::accounts::RegisterTransceiver {
        config: ntt.config(),
        owner: accounts.owner,
        payer: accounts.payer,
        transceiver: accounts.transceiver,
        registered_transceiver: ntt.registered_transceiver(&accounts.transceiver),
        system_program: System::id(),
    };

    Instruction {
        program_id: ntt.program,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub struct DeregisterTransceiver {
    pub owner: Pubkey,
    pub transceiver: Pubkey,
}

pub fn deregister_transceiver(ntt: &NTT, accounts: DeregisterTransceiver) -> Instruction {
    let data = example_native_token_transfers::instruction::DeregisterTransceiver {};

    let accounts = example_native_token_transfers::accounts::DeregisterTransceiver {
        config: ntt.config(),
        owner: accounts.owner,
        registered_transceiver: ntt.registered_transceiver(&accounts.transceiver),
    };

    Instruction {
        program_id: ntt.program,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub struct SetThreshold {
    pub owner: Pubkey,
}

pub fn set_threshold(ntt: &NTT, accounts: SetThreshold, threshold: u8) -> Instruction {
    let data = example_native_token_transfers::instruction::SetThreshold { threshold };

    let accounts = example_native_token_transfers::accounts::SetThreshold {
        config: ntt.config(),
        owner: accounts.owner,
    };

    Instruction {
        program_id: example_native_token_transfers::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
