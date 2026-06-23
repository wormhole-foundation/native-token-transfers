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

#[derive(Accounts)]
pub struct ReleaseOutbound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub config: NotPausedConfig<'info>,

    #[account(
        mut,
        // sanity check: the outbox item must belong to this instance. This is
        // already enforced by the `mark_outbox_item_as_released` CPI below, but
        // mirror the standalone transceiver and check it here as a second layer.
        constraint = outbox_item.manager == config.key() @ NTTError::InvalidOutboxItem,
        constraint = !outbox_item.released.get(transceiver.id)? @ NTTError::MessageAlreadySent,
    )]
    pub outbox_item: Account<'info, OutboxItem>,

    #[account(
        // sanity check: derive the RegisteredTransceiver PDA as a second layer.
        // It's a manager-owned account (hence `seeds::program` points at the
        // manager, unlike the standalone transceiver which lives in the manager
        // program), and is already validated by the CPI below.
        seeds = [RegisteredTransceiver::SEED_PREFIX, config.key().as_ref(), transceiver.transceiver_address.as_ref()],
        bump,
        seeds::program = example_native_token_transfers::ID,
        constraint = transceiver.transceiver_address == crate::ID,
        constraint = config.enabled_transceivers.get(transceiver.id)? @ NTTError::DisabledTransceiver
    )]
    pub transceiver: Account<'info, RegisteredTransceiver>,

    #[account(mut, seeds = [&emitter.key.to_bytes()], bump, seeds::program = wormhole_svm_definitions::solana::POST_MESSAGE_SHIM_PROGRAM_ID)]
    /// CHECK: initialized and written to by wormhole core bridge (empty, with the shim)
    pub wormhole_message: UncheckedAccount<'info>,

    #[account(
        seeds = [b"emitter", config.key().as_ref()],
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
        seeds = [OUTBOX_ITEM_SIGNER_SEED, config.key().as_ref()],
        bump
    )]
    /// CHECK: this PDA is used to sign the CPI into NTT manager program
    pub outbox_item_signer: UncheckedAccount<'info>,
}

impl<'info> ReleaseOutbound<'info> {
    pub fn mark_outbox_item_as_released(&self, bump_seed: u8) -> Result<bool> {
        let config_key = self.config.key();
        let result = example_native_token_transfers::cpi::mark_outbox_item_as_released(
            CpiContext::new_with_signer(
                self.manager.to_account_info(),
                example_native_token_transfers::cpi::accounts::MarkOutboxItemAsReleased {
                    signer: self.outbox_item_signer.to_account_info(),
                    config: example_native_token_transfers::cpi::accounts::NotPausedConfig {
                        config: self.config.config.to_account_info(),
                    },
                    outbox_item: self.outbox_item.to_account_info(),
                    transceiver: self.transceiver.to_account_info(),
                },
                // signer seeds
                &[&[OUTBOX_ITEM_SIGNER_SEED, config_key.as_ref(), &[bump_seed]]],
            ),
        )?;
        Ok(result.get())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ReleaseOutboundArgs {
    pub revert_on_delay: bool,
}

pub fn release_outbound(ctx: Context<ReleaseOutbound>, args: ReleaseOutboundArgs) -> Result<()> {
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

    // v4: source manager identity is the instance's `config` pubkey, not the
    // program ID. Matches the `recipient_ntt_manager` check in `redeem` and the
    // `manager_address` field in `broadcast_id`.
    let message: TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<Payload>> =
        TransceiverMessage::new(
            accs.config.key().to_bytes(),
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
        accs.config.key(),
        &message,
    )?;

    Ok(())
}
