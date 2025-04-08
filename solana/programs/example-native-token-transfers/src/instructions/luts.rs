//! This instructions manages a canonical address lookup table (or LUT) for the
//! NTT program.
//! LUTs in general can be created permissionlessly, so support from the
//! program's side is not strictly necessary. When submitting a transaction, the
//! client could just manage its own ad-hoc lookup table.
//! Nevertheless, we provide this instruction to make it easier for the client
//! to query the lookup table from a deterministic address, and for integrators
//! to be able to fetch the accounts from the LUT in a standardised way.
//!
//! This way, the client sdk can abstract away the lookup table logic in a
//! maintanable way.
//!
//! The [`initialize_lut`] instruction can be called multiple times, each time
//! it will create a new lookup table, with the accounts defined in the
//! [`Entries`] struct.
//! An alternative would be to keep extending the existing lookup table, but
//! ensuring the instruction is idempotent (which requires ensuring no duplicate
//! entries) has O(n^2) complexity (since LUTs are append only, we can't keep it
//! sorted), and in the worst case would require ~16k checks. So we keep things
//! simple, and just create a new LUT each time. This operation won't be called
//! often, so the extra allocation is justifiable.
//!
//! Because of all the above, this instruction can be called permissionlessly.

use anchor_lang::prelude::*;
use solana_address_lookup_table_program;
use solana_program::program::{invoke, invoke_signed};

use crate::{config::Config, queue::outbox::OutboxRateLimit, wormhole_accounts::*};

#[account]
#[derive(InitSpace)]
pub struct LUT {
    pub bump: u8,
    pub address: Pubkey,
}

#[derive(Accounts)]
#[instruction(recent_slot: u64)]
pub struct InitializeLUT<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"lut_authority"],
        bump
    )]
    /// CHECK: The seeds constraint enforces that this is the correct account.
    pub authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [authority.key().as_ref(), &recent_slot.to_le_bytes()],
        seeds::program = solana_address_lookup_table_program::id(),
        bump
    )]
    /// CHECK: The seeds constraint enforces that this is the correct account.
    pub lut_address: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + LUT::INIT_SPACE,
        seeds = [b"lut"],
        bump
    )]
    pub lut: Account<'info, LUT>,

    /// CHECK: address lookup table program (checked by instruction)
    #[account(executable)]
    pub lut_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// These are the entries that will populate the LUT.
    pub entries: Entries<'info>,
}

#[derive(Accounts)]
pub struct Entries<'info> {
    pub config: Account<'info, Config>,

    #[account(
        constraint = custody.key() == config.custody,
    )]
    /// CHECK: The constraint enforces that this is the correct account.
    pub custody: UncheckedAccount<'info>,

    #[account(
        constraint = token_program.key() == config.token_program,
    )]
    /// CHECK: The constraint enforces that this is the correct account.
    pub token_program: UncheckedAccount<'info>,

    #[account(
        constraint = mint.key() == config.mint,
    )]
    /// CHECK: The constraint enforces that this is the correct account.
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [crate::TOKEN_AUTHORITY_SEED],
        bump,
    )]
    /// CHECK: The seeds constraint enforces that this is the correct account.
    pub token_authority: UncheckedAccount<'info>,

    pub outbox_rate_limit: Account<'info, OutboxRateLimit>,

    // NOTE: this includes the system program so we don't need to add it in the outer context
    pub wormhole: WormholeAccounts<'info>,
}

pub fn initialize_lut(ctx: Context<InitializeLUT>, recent_slot: u64) -> Result<()> {
    let (ix, lut_address) = solana_address_lookup_table_program::instruction::create_lookup_table(
        ctx.accounts.authority.key(),
        ctx.accounts.payer.key(),
        recent_slot,
    );

    // just a sanity check, should never be hit, so we don't provide a custom
    // error message
    assert_eq!(lut_address, ctx.accounts.lut_address.key());

    // the LUT might already exist, in which case the new one will simply
    // override it. Since we don't delete the old LUTs, this is safe -- clients
    // holding references to old LUTs will still be able to use them.
    ctx.accounts.lut.set_inner(LUT {
        bump: ctx.bumps.lut,
        address: lut_address,
    });

    // NOTE: LUTs can be permissionlessly created (i.e. the authority does
    // not need to sign the transaction). This means that the LUT might
    // already exist (if someone frontran us). However, it's not a problem:
    // AddressLookupTable::create_lookup_table checks if the LUT already
    // exists and does nothing if it does.
    //
    // LUTs can only be created permissionlessly, but only the authority is
    // authorised to actually populate the fields, so we don't have to worry
    // about the frontrunner populating it with junk. The only risk of that would
    // be the LUT being filled to capacity (256 addresses), with no
    // possibility for us to add our own accounts -- no other security impact.
    invoke(
        &ix,
        &[
            ctx.accounts.lut_address.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    let entries_infos = ctx.accounts.entries.to_account_infos();
    let mut entries = Vec::with_capacity(1 + entries_infos.len());
    entries.push(crate::ID);
    entries.extend(entries_infos.into_iter().map(|x| x.key));

    let ix = solana_address_lookup_table_program::instruction::extend_lookup_table(
        ctx.accounts.lut_address.key(),
        ctx.accounts.authority.key(),
        Some(ctx.accounts.payer.key()),
        entries,
    );

    invoke_signed(
        &ix,
        &[
            ctx.accounts.lut_address.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[b"lut_authority", &[ctx.bumps.authority]]],
    )?;

    Ok(())
}
