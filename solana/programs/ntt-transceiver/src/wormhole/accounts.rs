use anchor_lang::prelude::*;
use example_native_token_transfers::wormhole_accounts::{pay_wormhole_fee, WormholeAccounts};
use wormhole_anchor_sdk::wormhole;
use wormhole_io::TypePrefixedPayload;

pub fn post_message<'info, A: TypePrefixedPayload>(
    wormhole: &WormholeAccounts<'info>,
    payer: AccountInfo<'info>,
    message: AccountInfo<'info>,
    emitter_bump: u8,
    payload: &A,
    additional_seeds: &[&[&[u8]]],
) -> Result<()> {
    let batch_id = 0;

    pay_wormhole_fee(wormhole, &payer)?;

    let ix = wormhole::PostMessage {
        config: wormhole.bridge.to_account_info(),
        message,
        emitter: wormhole.emitter.to_account_info(),
        sequence: wormhole.sequence.to_account_info(),
        payer: payer.to_account_info(),
        fee_collector: wormhole.fee_collector.to_account_info(),
        clock: wormhole.clock.to_account_info(),
        rent: wormhole.rent.to_account_info(),
        system_program: wormhole.system_program.to_account_info(),
    };

    let seeds: &[&[&[&[u8]]]] = &[
        &[&[b"emitter".as_slice(), &[emitter_bump]]],
        additional_seeds,
    ];

    wormhole::post_message(
        CpiContext::new_with_signer(wormhole.program.to_account_info(), ix, &seeds.concat()),
        batch_id,
        TypePrefixedPayload::to_vec_payload(payload),
        wormhole::Finality::Finalized,
    )?;

    Ok(())
}
