use anchor_lang::prelude::*;

use example_native_token_transfers::{
    config::{anchor_reexports::*, *},
    error::NTTError,
    transfer::Payload,
};
use ntt_messages::{
    chain_id::ChainId, ntt::NativeTokenTransfer, transceiver::TransceiverMessageData,
    transceivers::wormhole::WormholeTransceiver,
};
use wormhole_verify_vaa_shim_interface::program::WormholeVerifyVaaShim;

use crate::{messages::ValidatedTransceiverMessage, peer::TransceiverPeer, vaa_body::VaaBody};

#[derive(Accounts)]
#[instruction(_guardian_set_bump: u8, vaa_body: VaaBody)]
pub struct ReceiveMessage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        constraint = vaa_body.to_chain() == config.chain_id @ NTTError::InvalidChainId,
    )]
    pub config: NotPausedConfig<'info>,

    #[account(
        seeds = [TransceiverPeer::SEED_PREFIX, vaa_body.emitter_chain().to_be_bytes().as_ref()],
        constraint = peer.address == *vaa_body.emitter_address() @ NTTError::InvalidTransceiverPeer,
        bump = peer.bump,
    )]
    pub peer: Account<'info, TransceiverPeer>,

    #[account(
        init,
        payer = payer,
        space = 8 + ValidatedTransceiverMessage::<TransceiverMessageData<NativeTokenTransfer<Payload>>>::INIT_SPACE,
        seeds = [
            ValidatedTransceiverMessage::<TransceiverMessageData<NativeTokenTransfer<Payload>>>::SEED_PREFIX,
            vaa_body.emitter_chain().to_be_bytes().as_ref(),
            vaa_body.id(),
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

pub fn receive_message_instruction_data(
    ctx: Context<ReceiveMessage>,
    guardian_set_bump: u8,
    vaa_body: VaaBody,
) -> Result<()> {
    // verify the hash against the signatures
    let message_hash = &solana_program::keccak::hashv(&[&vaa_body]).to_bytes();
    let digest = solana_program::keccak::hash(message_hash.as_slice()).to_bytes();
    wormhole_verify_vaa_shim_interface::cpi::verify_hash(
        CpiContext::new(
            ctx.accounts.verify_vaa_shim.to_account_info(),
            wormhole_verify_vaa_shim_interface::cpi::accounts::VerifyHash {
                guardian_set: ctx.accounts.guardian_set.to_account_info(),
                guardian_signatures: ctx.accounts.guardian_signatures.to_account_info(),
            },
        ),
        guardian_set_bump,
        digest,
    )?;

    // update transceiver_message
    let message = vaa_body
        .transceiver_message_data::<WormholeTransceiver, NativeTokenTransfer<Payload>>()?
        .clone();
    ctx.accounts
        .transceiver_message
        .set_inner(ValidatedTransceiverMessage {
            from_chain: ChainId {
                id: vaa_body.emitter_chain(),
            },
            message,
        });

    Ok(())
}
