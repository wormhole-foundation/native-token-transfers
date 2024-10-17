use crate::wormhole::accounts::*;
use anchor_lang::prelude::*;
use example_native_token_transfers::{
    config::{anchor_reexports::*, *},
    error::NTTError,
    instructions::OUTBOX_ITEM_SIGNER_SEED,
    program::ExampleNativeTokenTransfers,
    queue::outbox::OutboxItem,
    registered_transceiver::RegisteredTransceiver,
    transfer::Payload,
};
use ntt_messages::{
    ntt::NativeTokenTransfer, ntt_manager::NttManagerMessage, transceiver::TransceiverMessage,
    transceivers::wormhole::WormholeTransceiver,
};
use solana_program::{
    hash,
    instruction::Instruction,
    program::{get_return_data, invoke_signed},
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

    // NOTE: we put `manager` and `outbox_item_signer` at the end so that the generated
    // IDL does not clash with the baked-in transceiver IDL in the manager
    pub manager: Program<'info, ExampleNativeTokenTransfers>,

    #[account(
        seeds = [OUTBOX_ITEM_SIGNER_SEED],
        bump
    )]
    /// CHECK: this PDA is used to sign the CPI into NTT manager program
    pub outbox_item_signer: UncheckedAccount<'info>,
}

impl<'info> ReleaseOutbound<'info> {
    pub fn mark_outbox_item_as_released(&self, bump_seed: u8) -> Result<bool> {
        // calculate signhash of mark_outbox_item_as_released function
        let ix_data = {
            let preimage = format!("{}:{}", "global", "mark_outbox_item_as_released");
            let mut sighash = [0u8; 8];
            sighash.copy_from_slice(&hash::hash(preimage.as_bytes()).to_bytes()[..8]);
            sighash
        };
        // deref config account info from NotPausedConfig
        assert!(self.config.to_account_infos().len() == 1);
        let config_info = &self.config.to_account_infos()[0];
        // construct CPI call
        let account_metas = vec![
            AccountMeta::new_readonly(self.outbox_item_signer.key(), true),
            AccountMeta::new_readonly(config_info.key(), false),
            AccountMeta::new(self.outbox_item.key(), false),
            AccountMeta::new_readonly(self.transceiver.key(), false),
        ];
        let instruction = Instruction::new_with_borsh(self.manager.key(), &ix_data, account_metas);
        let account_infos = vec![
            self.outbox_item_signer.to_account_info(),
            config_info.clone(),
            self.outbox_item.to_account_info(),
            self.transceiver.to_account_info(),
        ];
        invoke_signed(
            &instruction,
            &account_infos,
            &[&[OUTBOX_ITEM_SIGNER_SEED, &[bump_seed]]],
        )?;
        // get return value
        let (_key, data) = get_return_data().unwrap();
        Ok(data.len() == 1 && data[0] == 1)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ReleaseOutboundArgs {
    pub revert_on_delay: bool,
}

pub fn release_outbound<'info>(
    ctx: Context<'_, '_, '_, 'info, ReleaseOutbound>,
    args: ReleaseOutboundArgs,
) -> Result<()> {
    let accs = ctx.accounts;
    let released = accs.mark_outbox_item_as_released(ctx.bumps.outbox_item_signer)?;

    if !released {
        if args.revert_on_delay {
            return Err(NTTError::CantReleaseYet.into());
        } else {
            return Ok(());
        }
    }

    accs.outbox_item.reload()?;
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
