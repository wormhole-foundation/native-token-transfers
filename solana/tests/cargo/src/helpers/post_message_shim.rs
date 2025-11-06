use solana_program_test::ProgramTestContext;
use solana_sdk::instruction::Instruction;

use crate::{
    common::submit::Submittable,
    sdk::{accounts::Wormhole, transceivers::accounts::NTTTransceiver},
};

pub struct PostMessageShimInstructionData {
    pub nonce: u32,
    pub consistency_level: u8,
    pub payload: Vec<u8>,
}

// TODO: Figure out how to get CPI event that can be parsed to re-create the VAA message.
// `inner_instructions` is always `None` even though CPIs happen. This limits the
// testing that can be done as we can no longer parse the CPI event from it.
pub async fn get_message_data(
    wh: &Wormhole,
    ntt_transceiver: &NTTTransceiver,
    ctx: &mut ProgramTestContext,
    ix: Instruction,
) -> PostMessageShimInstructionData {
    // simulate ix
    let out = ix.simulate(ctx).await.unwrap();
    assert!(out.result.unwrap().is_ok());

    let details = out.simulation_details.unwrap();

    // verify logs
    let logs = details.logs;
    let is_core_bridge_cpi_log =
        |line: &String| line.contains(format!("Program {} invoke [3]", wh.program).as_str());
    assert_eq!(
        logs.iter()
            .filter(|line| { line.contains("Program log: Sequence: 0") })
            .count(),
        1
    );
    let core_bridge_log_index = logs.iter().position(is_core_bridge_cpi_log).unwrap();
    assert_eq!(
        logs.iter()
            .skip(core_bridge_log_index)
            .filter(|line| {
                line.contains(
                    format!(
                        "Program {} invoke [3]",
                        ntt_transceiver.post_message_shim().program
                    )
                    .as_str(),
                )
            })
            .count(),
        1
    );

    // parse return data
    let ix_data = details.return_data.unwrap().data;
    // 8-byte instruction discriminator
    let nonce = u32::from_le_bytes(ix_data[8..12].try_into().unwrap());
    let consistency_level: u8 = ix_data[12];
    // 4-byte Vec length
    let payload = ix_data[17..].to_vec();

    PostMessageShimInstructionData {
        nonce,
        consistency_level,
        payload,
    }
}
