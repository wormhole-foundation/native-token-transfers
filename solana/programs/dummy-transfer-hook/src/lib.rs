#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use spl_tlv_account_resolution::state::ExtraAccountMetaList;

declare_id!("BgabMDLaxsyB7eGMBt9L22MSk9KMrL4zY2iNe14kyFP5");

/// Index of the sender token account in the accounts passed to the transfer hook
pub const SENDER_TOKEN_ACCOUNT_INDEX: u8 = 0;
/// Index of the mint account in the accounts passed to the transfer hook
pub const MINT_ACCOUNT_INDEX: u8 = 1;
/// Index of the destination token account in the accounts passed to the transfer hook
pub const DESTINATION_TOKEN_ACCOUNT_INDEX: u8 = 2;
/// Index of the authority account in the accounts passed to the transfer hook
pub const AUTHORITY_ACCOUNT_INDEX: u8 = 3;

/// Number of extra accounts in the ExtraAccountMetaList account
pub const EXTRA_ACCOUNTS_LEN: u8 = 2;

#[program]
pub mod dummy_transfer_hook {
    use spl_tlv_account_resolution::{
        account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
    };
    use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

    use super::*;

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let account_metas = vec![
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal {
                        bytes: "dummy_account".as_bytes().to_vec(),
                    },
                    // owner field of the sender token account
                    Seed::AccountData {
                        account_index: SENDER_TOKEN_ACCOUNT_INDEX,
                        data_index: 32,
                        length: 32,
                    },
                ],
                false, // is_signer
                false, // is_writable
            )?,
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal {
                    bytes: "counter".as_bytes().to_vec(),
                }],
                false, // is_signer
                true,  // is_writable
            )?,
        ];

        assert_eq!(EXTRA_ACCOUNTS_LEN as usize, account_metas.len());

        // initialize ExtraAccountMetaList account with extra accounts
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;

        Ok(())
    }

    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        ctx.accounts.counter.count += 1;
        Ok(())
    }

    // NOTE: the CPI call makes that the token2022 program makes (naturally) does not
    // follow the anchor calling convention, so we need to implement a fallback
    // instruction to handle the custom instruction
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;

        // match instruction discriminator to transfer hook interface execute instruction
        // token2022 program CPIs this instruction on token transfer
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();

                // invoke custom transfer hook instruction on our program
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub count: u64,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList Account, must use these seeds
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNTS_LEN as usize)?,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    #[account(
        init,
        payer = payer,
        space = 8 + Counter::INIT_SPACE,
        seeds = [b"counter"],
        bump
    )]
    pub counter: Account<'info, Counter>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
/// NOTE: this is just a dummy transfer hook to test that the accounts are
/// passed in correctly. Do NOT use this as a starting point in a real
/// application, as it's not secure.
pub struct TransferHook<'info> {
    #[account(
        token::mint = mint,
    )]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
    )]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source token account authority, can be SystemAccount or PDA owned by another program
    pub authority: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList Account,
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(
        seeds = [b"dummy_account", source_token.owner.as_ref()],
        bump
    )]
    /// CHECK: dummy account. It just tests that the off-chain code correctly
    /// computes and the on-chain code correctly passes on the PDA.
    pub dummy_account: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"counter"],
        bump
    )]
    pub counter: Account<'info, Counter>,
}
