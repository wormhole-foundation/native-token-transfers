use anchor_lang::prelude::*;
pub mod messages;
pub mod peer;
pub mod vaa_body;
pub mod wormhole;

use vaa_body::VaaBodyData;
use wormhole::instructions::*;

#[macro_use]
extern crate cfg_if;

declare_id!("Ee6jpX9oq2EsGuqGb6iZZxvtcpmMGZk8SAUbnQy4jcHR");

cfg_if! {
    if #[cfg(feature = "wormhole-transceiver")] {
        pub const TRANSCEIVER_TYPE: &str = "wormhole";
    } else if #[cfg(feature = "transceiver-type-from-env")] {
        pub const TRANSCEIVER_TYPE: &str = env!("TRANSCEIVER_TYPE");
    } else {
        compile_error!("No transceiver type specified");
    }
}

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

    pub fn receive_wormhole_message_instruction_data(
        ctx: Context<ReceiveMessageInstructionData>,
        guardian_set_bump: u8,
        vaa_body: VaaBodyData,
    ) -> Result<()> {
        wormhole::instructions::receive_message_instruction_data(ctx, guardian_set_bump, vaa_body)
    }

    pub fn post_unverified_wormhole_message_account(
        ctx: Context<PostUnverifiedMessageAccount>,
        args: PostUnverifiedMessageAccountArgs,
    ) -> Result<()> {
        wormhole::instructions::post_unverified_message_account(ctx, args)
    }

    pub fn close_unverified_wormhole_message_account(
        ctx: Context<CloseUnverifiedMessageAccount>,
    ) -> Result<()> {
        wormhole::instructions::close_unverified_message_account(ctx)
    }

    pub fn receive_wormhole_message_account(
        ctx: Context<ReceiveMessageAccount>,
        guardian_set_bump: u8,
    ) -> Result<()> {
        wormhole::instructions::receive_message_account(ctx, guardian_set_bump)
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
