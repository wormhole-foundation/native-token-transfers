use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole;
use wormhole_io::TypePrefixedPayload;
use wormhole_post_message_shim_interface::{program::WormholePostMessageShim, Finality};

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

    pub post_message_shim: Program<'info, WormholePostMessageShim>,

    /// CHECK: Shim event authority
    pub wormhole_post_message_shim_ea: UncheckedAccount<'info>,

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
                emitter,
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
