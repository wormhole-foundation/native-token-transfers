use crate::{
    config::*, error::NTTError, queue::outbox::OutboxItem,
    registered_transceiver::RegisteredTransceiver,
};
use anchor_lang::prelude::*;

pub const OUTBOX_ITEM_SIGNER_SEED: &[u8] = b"outbox_item_signer";

#[derive(Accounts)]
pub struct MarkOutboxItemAsReleased<'info> {
    #[account(
        seeds = [OUTBOX_ITEM_SIGNER_SEED],
        seeds::program = transceiver.transceiver_address,
        bump
    )]
    pub signer: Signer<'info>,

    pub config: NotPausedConfig<'info>,

    #[account(
        mut,
        constraint = !outbox_item.released.get(transceiver.id)? @ NTTError::MessageAlreadySent,
    )]
    pub outbox_item: Account<'info, OutboxItem>,

    #[account(
        constraint = config.enabled_transceivers.get(transceiver.id)? @ NTTError::DisabledTransceiver
    )]
    pub transceiver: Account<'info, RegisteredTransceiver>,
}

pub fn mark_outbox_item_as_released(ctx: Context<MarkOutboxItemAsReleased>) -> Result<bool> {
    let accs = ctx.accounts;
    let released = accs.outbox_item.try_release(accs.transceiver.id)?;
    Ok(released)
}
