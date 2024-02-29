use anchor_lang::prelude::*;

use wormhole_anchor_sdk::wormhole;
use wormhole_io::TypePrefixedPayload;

cfg_if::cfg_if! {
    if #[cfg(feature = "tilt-devnet2")] {
        const FINALITY: wormhole::Finality = wormhole::Finality::Confirmed;
    } else if #[cfg(feature = "tilt-devnet")] {
        const FINALITY: wormhole::Finality = wormhole::Finality::Confirmed;
    } else {
        const FINALITY: wormhole::Finality = wormhole::Finality::Finalized;
    }
}

// TODO: should we add emitter in here too?
#[derive(Accounts)]
pub struct WormholeAccounts<'info> {
    // wormhole stuff
    #[account(mut)]
    /// CHECK: address will be checked by the wormhole core bridge
    pub bridge: Account<'info, wormhole::BridgeData>,

    #[account(mut)]
    /// CHECK: account will be checked by the wormhole core bridge
    pub fee_collector: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: account will be checked and maybe initialized by the wormhole core bridge
    pub sequence: UncheckedAccount<'info>,

    pub program: Program<'info, wormhole::program::Wormhole>,

    pub system_program: Program<'info, System>,

    // legacy
    pub clock: Sysvar<'info, Clock>,
    pub rent: Sysvar<'info, Rent>,
}

/// SECURITY: Owner checks are disabled. Each of [`WormholeAccounts::bridge`], [`WormholeAccounts::fee_collector`],
/// and [`WormholeAccounts::sequence`] must be checked by the Wormhole core bridge.
/// SECURITY: Signer checks are disabled. The only valid sender is the
/// [`wormhole::PostMessage::emitter`], enforced by the [`CpiContext`] below.
pub fn post_message<'info, A: TypePrefixedPayload>(
    wormhole: &WormholeAccounts<'info>,
    payer: AccountInfo<'info>,
    message: AccountInfo<'info>,
    emitter: AccountInfo<'info>,
    emitter_bump: u8,
    payload: &A,
    additional_seeds: &[&[&[u8]]],
) -> Result<()> {
    let batch_id = 0;

    pay_wormhole_fee(wormhole, &payer)?;

    let ix = wormhole::PostMessage {
        config: wormhole.bridge.to_account_info(),
        message,
        emitter,
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
        FINALITY,
    )?;

    Ok(())
}

/// SECURITY: Owner and signer checks are not performed here as this private function is used only by
/// [`post_message`].
fn pay_wormhole_fee<'info>(
    wormhole: &WormholeAccounts<'info>,
    payer: &AccountInfo<'info>,
) -> Result<()> {
    if wormhole.bridge.fee() > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                wormhole.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: payer.to_account_info(),
                    to: wormhole.fee_collector.to_account_info(),
                },
            ),
            wormhole.bridge.fee(),
        )?;
    }

    Ok(())
}
