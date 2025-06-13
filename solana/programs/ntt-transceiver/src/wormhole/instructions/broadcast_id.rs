use crate::wormhole::accounts::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use example_native_token_transfers::{
    config::*,
    wormhole_accounts::{anchor_reexports::*, *},
};
use ntt_messages::transceivers::wormhole::WormholeTransceiverInfo;

#[derive(Accounts)]
pub struct BroadcastId<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(
        address = config.mint,
    )]
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    /// CHECK: initialized and written to by wormhole core bridge
    #[account(mut)]
    pub wormhole_message: Signer<'info>,

    pub wormhole: WormholeAccounts<'info>,
}

pub fn broadcast_id(ctx: Context<BroadcastId>) -> Result<()> {
    let accs = ctx.accounts;
    let message = WormholeTransceiverInfo {
        manager_address: accs.config.to_account_info().owner.to_bytes(),
        manager_mode: accs.config.mode,
        token_address: accs.mint.to_account_info().key.to_bytes(),
        token_decimals: accs.mint.decimals,
    };

    // TODO: should we send this as an unreliable message into a PDA?
    post_message(
        &accs.wormhole,
        accs.payer.to_account_info(),
        accs.wormhole_message.to_account_info(),
        ctx.bumps.wormhole.emitter,
        &message,
        &[],
    )?;

    Ok(())
}
