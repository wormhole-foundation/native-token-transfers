use anchor_lang::prelude::*;
use example_native_token_transfers::wormhole_accounts::{pay_wormhole_fee, WormholeAccounts};
use wormhole_io::TypePrefixedPayload;
use wormhole_post_message_shim_interface::Finality;

/// SECURITY: Owner checks are disabled. Each of [`WormholeAccounts::bridge`], [`WormholeAccounts::fee_collector`],
/// and [`WormholeAccounts::sequence`] must be checked by the Wormhole core bridge.
/// SECURITY: Signer checks are disabled. The only valid sender is the
/// [`wormhole::PostMessage::emitter`], enforced by the [`CpiContext`] below.
pub fn post_message<'info, A: TypePrefixedPayload>(
    wormhole: &WormholeAccounts<'info>,
    payer: AccountInfo<'info>,
    message: AccountInfo<'info>,
    emitter_bump: u8,
    payload: &A,
) -> Result<()> {
    let batch_id = 0;

    pay_wormhole_fee(wormhole, &payer)?;

    wormhole_post_message_shim_interface::cpi::post_message(
        CpiContext::new_with_signer(
            wormhole.post_message_shim.to_account_info(),
            wormhole_post_message_shim_interface::cpi::accounts::PostMessage {
                payer,
                bridge: wormhole.bridge.to_account_info(),
                message,
                emitter: wormhole.emitter.to_account_info(),
                sequence: wormhole.sequence.to_account_info(),
                fee_collector: wormhole.fee_collector.to_account_info(),
                clock: wormhole.clock.to_account_info(),
                system_program: wormhole.system_program.to_account_info(),
                wormhole_program: wormhole.program.to_account_info(),
                program: wormhole.post_message_shim.to_account_info(),
                event_authority: wormhole.wormhole_post_message_shim_ea.to_account_info(),
            },
            &[&[b"emitter", &[emitter_bump]]],
        ),
        batch_id,
        Finality::Finalized,
        TypePrefixedPayload::to_vec_payload(payload),
    )?;

    // Instruction data passed onto the Post Message Shim program is used to recreate the VAA.
    // Cargo tests, however, do not expose a way to fetch inner instructions. As a workaround during
    // testing, we build with this feature enabled and set the instruction data as the return data.
    // The test first simulates this instruction to fetch the return data before submitting it.
    #[cfg(feature = "testing")]
    {
        use anchor_lang::InstructionData;

        let ix_data = wormhole_post_message_shim_interface::instruction::PostMessage {
            nonce: batch_id,
            consistency_level: Finality::Finalized,
            payload: TypePrefixedPayload::to_vec_payload(payload),
        }
        .data();
        solana_program::program::set_return_data(&ix_data);
    }

    Ok(())
}
