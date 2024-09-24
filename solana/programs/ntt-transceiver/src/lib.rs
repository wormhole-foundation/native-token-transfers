use anchor_lang::prelude::*;
pub mod messages;
pub mod peer;
pub mod wormhole;

use wormhole::instructions::*;

declare_id!("Ee6jpX9oq2EsGuqGb6iZZxvtcpmMGZk8SAUbnQy4jcHR");

#[program]
pub mod ntt_transceiver {

    use super::*;

    pub fn set_wormhole_peer(
        ctx: Context<SetTransceiverPeer>,
        args: SetTransceiverPeerArgs,
    ) -> Result<()> {
        set_transceiver_peer(ctx, args)
    }

    pub fn receive_wormhole_message(ctx: Context<ReceiveMessage>) -> Result<()> {
        wormhole::instructions::receive_message(ctx)
    }

    pub fn release_wormhole_outbound(
        ctx: Context<ReleaseOutbound>,
        args: ReleaseOutboundArgs,
    ) -> Result<()> {
        wormhole::instructions::release_outbound(ctx, args)
    }

    pub fn broadcast_wormhole_id(ctx: Context<BroadcastId>) -> Result<()> {
        wormhole::instructions::broadcast_id(ctx)
    }

    pub fn broadcast_wormhole_peer(
        ctx: Context<BroadcastPeer>,
        args: BroadcastPeerArgs,
    ) -> Result<()> {
        wormhole::instructions::broadcast_peer(ctx, args)
    }
}

#[derive(Accounts)]
pub struct Initialize {}
