use anchor_lang::prelude::*;
use ntt_messages::chain_id::ChainId;

use crate::{config::Config, transceivers::accounts::peer::TransceiverPeer};

#[derive(Accounts)]
#[instruction(args: SetTransceiverPeerArgs)]
pub struct SetTransceiverPeer<'info> {
    #[account(
        has_one = owner,
    )]
    pub config: Account<'info, Config>,

    pub owner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        space = 8 + TransceiverPeer::INIT_SPACE,
        payer = payer,
        seeds = [TransceiverPeer::SEED_PREFIX, args.chain_id.id.to_be_bytes().as_ref()],
        bump
    )]
    pub peer: Account<'info, TransceiverPeer>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct SetTransceiverPeerArgs {
    pub chain_id: ChainId,
    pub address: [u8; 32],
}

pub fn set_transceiver_peer(
    ctx: Context<SetTransceiverPeer>,
    args: SetTransceiverPeerArgs,
) -> Result<()> {
    ctx.accounts.peer.set_inner(TransceiverPeer {
        bump: ctx.bumps.peer,
        address: args.address,
    });

    Ok(())
}
