use anchor_lang::prelude::*;
pub mod messages;
pub mod peer;
pub mod wormhole;

use wormhole::instructions::*;

declare_id!("Ee6jpX9oq2EsGuqGb6iZZxvtcpmMGZk8SAUbnQy4jcHR");

pub const TRANSCEIVER_TYPE: &str = "wormhole";

#[program]
pub mod ntt_transceiver {

    use super::*;

    pub fn transceiver_type(_ctx: Context<TransceiverType>) -> Result<String> {
        Ok(TRANSCEIVER_TYPE.to_string())
    }

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
pub struct TransceiverType {}
