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
use wormhole_verify_vaa_shim_interface::program::WormholeVerifyVaaShim;

use crate::{messages::ValidatedTransceiverMessage, peer::TransceiverPeer};

#[derive(Accounts)]
#[instruction(args: ReceiveMessageArgs)]
pub struct ReceiveMessage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        constraint = args.vaa.message().ntt_manager_payload.payload.to_chain == config.chain_id @ NTTError::InvalidChainId,
    )]
    pub config: NotPausedConfig<'info>,

    #[account(
        seeds = [TransceiverPeer::SEED_PREFIX, args.vaa.emitter_chain().to_be_bytes().as_ref()],
        constraint = peer.address == *args.vaa.emitter_address() @ NTTError::InvalidTransceiverPeer,
        bump = peer.bump,
    )]
    pub peer: Account<'info, TransceiverPeer>,

    #[account(
        init,
        payer = payer,
        space = 8 + ValidatedTransceiverMessage::<TransceiverMessageData<NativeTokenTransfer<Payload>>>::INIT_SPACE,
        seeds = [
            ValidatedTransceiverMessage::<TransceiverMessageData<NativeTokenTransfer<Payload>>>::SEED_PREFIX,
            args.vaa.emitter_chain().to_be_bytes().as_ref(),
            args.vaa.message().ntt_manager_payload.id.as_ref(),
        ],
        bump,
    )]
    // NOTE: in order to handle multiple transceivers, we can just augment the
    // inbox item transfer struct with a bitmap storing which transceivers have
    // attested to the transfer. Then we only release it if there's quorum.
    // We would need to maybe_init this account in that case.
    pub transceiver_message:
        Account<'info, ValidatedTransceiverMessage<NativeTokenTransfer<Payload>>>,

    /// CHECK: Guardian set used for signature verification by shim.
    /// Derivation is checked by the shim.
    pub guardian_set: UncheckedAccount<'info>,

    /// CHECK: Stored guardian signatures to be verified by shim.
    /// Ownership ownership and discriminator is checked by the shim.
    pub guardian_signatures: UncheckedAccount<'info>,

    pub verify_vaa_shim: Program<'info, WormholeVerifyVaaShim>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ReceiveMessageArgs {
    pub vaa: PostedVaa<TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<Payload>>>,
    pub guardian_set_bump: u8,
}

pub fn receive_message(ctx: Context<ReceiveMessage>, args: ReceiveMessageArgs) -> Result<()> {
    // Verify the hash against the signatures
    let vec_body = &args.vaa.try_to_vec()?[..];
    let message_hash = &solana_program::keccak::hashv(&[vec_body]).to_bytes();
    let digest = solana_program::keccak::hash(message_hash.as_slice()).to_bytes();
    wormhole_verify_vaa_shim_interface::cpi::verify_hash(
        CpiContext::new(
            ctx.accounts.verify_vaa_shim.to_account_info(),
            wormhole_verify_vaa_shim_interface::cpi::accounts::VerifyHash {
                guardian_set: ctx.accounts.guardian_set.to_account_info(),
                guardian_signatures: ctx.accounts.guardian_signatures.to_account_info(),
            },
        ),
        args.guardian_set_bump,
        digest,
    )?;

    let message = args.vaa.message().message_data.clone();
    let chain_id = args.vaa.emitter_chain();
    ctx.accounts
        .transceiver_message
        .set_inner(ValidatedTransceiverMessage {
            from_chain: ChainId { id: chain_id },
            message,
        });

    Ok(())
}
