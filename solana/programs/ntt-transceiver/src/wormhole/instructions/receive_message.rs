use crate::{messages::ValidatedTransceiverMessage, peer::TransceiverPeer};
use anchor_lang::prelude::*;
use example_native_token_transfers::{
    config::{anchor_reexports::*, *},
    error::NTTError,
    transfer::Payload,
};
use ntt_messages::{
    chain_id::ChainId,
    ntt::NativeTokenTransfer,
    transceiver::{TransceiverMessage, TransceiverMessageData},
    transceivers::wormhole::WormholeTransceiver,
};
use wormhole_anchor_sdk::wormhole::PostedVaa;

#[derive(Accounts)]
pub struct ReceiveMessage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: NotPausedConfig<'info>,

    #[account(
        seeds = [TransceiverPeer::SEED_PREFIX, vaa.emitter_chain().to_be_bytes().as_ref()],
        constraint = peer.address == *vaa.emitter_address() @ NTTError::InvalidTransceiverPeer,
        bump = peer.bump,
    )]
    pub peer: Account<'info, TransceiverPeer>,

    // TODO: Consider using VaaAccount from wormhole-solana-vaa crate. Using a zero-copy reader
    // will allow this instruction to be generic (instead of strictly specifying NativeTokenTransfer
    // as the message type).
    #[account(
        // check that the messages is targeted to this chain
        constraint = vaa.message().ntt_manager_payload.payload.to_chain == config.chain_id @ NTTError::InvalidChainId,
        // NOTE: we don't replay protect VAAs. Instead, we replay protect
        // executing the messages themselves with the [`released`] flag.
    )]
    pub vaa: Account<
        'info,
        PostedVaa<TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<Payload>>>,
    >,

    #[account(
        init,
        payer = payer,
        space = 8 + ValidatedTransceiverMessage::<TransceiverMessageData<NativeTokenTransfer<Payload>>>::INIT_SPACE,
        seeds = [
            ValidatedTransceiverMessage::<TransceiverMessageData<NativeTokenTransfer<Payload>>>::SEED_PREFIX,
            vaa.emitter_chain().to_be_bytes().as_ref(),
            vaa.message().ntt_manager_payload.id.as_ref(),
        ],
        bump,
    )]
    // NOTE: in order to handle multiple transceivers, we can just augment the
    // inbox item transfer struct with a bitmap storing which transceivers have
    // attested to the transfer. Then we only release it if there's quorum.
    // We would need to maybe_init this account in that case.
    pub transceiver_message:
        Account<'info, ValidatedTransceiverMessage<NativeTokenTransfer<Payload>>>,

    pub system_program: Program<'info, System>,
}

pub fn receive_message(ctx: Context<ReceiveMessage>) -> Result<()> {
    let message = ctx.accounts.vaa.message().message_data.clone();
    let chain_id = ctx.accounts.vaa.emitter_chain();
    ctx.accounts
        .transceiver_message
        .set_inner(ValidatedTransceiverMessage {
            from_chain: ChainId { id: chain_id },
            message,
        });

    Ok(())
}
