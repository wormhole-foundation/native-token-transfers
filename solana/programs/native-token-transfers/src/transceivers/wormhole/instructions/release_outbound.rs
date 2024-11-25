use anchor_lang::prelude::*;

use ntt_messages::{
    ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage, transceiver::TransceiverMessage,
    transceivers::wormhole::WormholeTransceiver,
};

use crate::{
    config::*, error::NTTError, queue::outbox::OutboxItem, registered_transceiver::*,
    transceivers::wormhole::accounts::*, transfer::Payload,
};

#[derive(Accounts)]
pub struct ReleaseOutbound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: NotPausedConfig<'info>,

    #[account(
        mut,
        constraint = !outbox_item.released.get(transceiver.id)? @ NTTError::MessageAlreadySent,
    )]
    pub outbox_item: Account<'info, OutboxItem>,

    #[account(
        constraint = transceiver.transceiver_address == crate::ID,
        constraint = config.enabled_transceivers.get(transceiver.id)? @ NTTError::DisabledTransceiver
    )]
    pub transceiver: Account<'info, RegisteredTransceiver>,

    #[account(
        mut,
        seeds = [b"message", outbox_item.key().as_ref()],
        bump,
    )]
    /// CHECK: initialized and written to by wormhole core bridge
    pub wormhole_message: UncheckedAccount<'info>,

    #[account(
        seeds = [b"emitter"],
        bump
    )]
    // TODO: do we want to put anything in here?
    /// CHECK: wormhole uses this as the emitter address
    pub emitter: UncheckedAccount<'info>,

    pub wormhole: WormholeAccounts<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ReleaseOutboundArgs {
    pub revert_on_delay: bool,
}

pub fn release_outbound(ctx: Context<ReleaseOutbound>, args: ReleaseOutboundArgs) -> Result<()> {
    let accs = ctx.accounts;
    let released = accs.outbox_item.try_release(accs.transceiver.id)?;

    if !released {
        if args.revert_on_delay {
            return Err(NTTError::CantReleaseYet.into());
        } else {
            return Ok(());
        }
    }

    assert!(accs.outbox_item.released.get(accs.transceiver.id)?);
    let message: TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<Payload>> =
        TransceiverMessage::new(
            // TODO: should we just put the ntt id here statically?
            accs.outbox_item.to_account_info().owner.to_bytes(),
            accs.outbox_item.recipient_ntt_manager,
            NttManagerMessage {
                id: accs.outbox_item.key().to_bytes(),
                sender: accs.outbox_item.sender.to_bytes(),
                payload: NativeTokenTransfer {
                    amount: accs.outbox_item.amount,
                    source_token: accs.config.mint.to_bytes(),
                    to: accs.outbox_item.recipient_address,
                    to_chain: accs.outbox_item.recipient_chain,
                    additional_payload: Payload {},
                },
            },
            vec![],
        );

    post_message(
        &accs.wormhole,
        accs.payer.to_account_info(),
        accs.wormhole_message.to_account_info(),
        accs.emitter.to_account_info(),
        ctx.bumps.emitter,
        &message,
        &[&[
            b"message",
            accs.outbox_item.key().as_ref(),
            &[ctx.bumps.wormhole_message],
        ]],
    )?;

    Ok(())
}
