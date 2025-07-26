use anchor_lang::prelude::*;

use crate::vaa_body::VaaBody;

#[derive(Accounts)]
#[instruction(args: PostUnverifiedMessageAccountArgs)]
pub struct PostUnverifiedMessageAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + 4 + args.message_size as usize,
        seeds = [
            VaaBody::SEED_PREFIX,
            &payer.key.to_bytes()
        ],
        bump,
    )]
    pub message: Account<'info, VaaBody>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PostUnverifiedMessageAccountArgs {
    pub offset: u32,
    pub chunk: Vec<u8>,
    pub message_size: u32,
}

pub fn post_unverified_message_account(
    ctx: Context<PostUnverifiedMessageAccount>,
    args: PostUnverifiedMessageAccountArgs,
) -> Result<()> {
    if args.chunk.is_empty() {
        return Err(ProgramError::InvalidArgument.into());
    }

    let offset = args.offset as usize;
    let end = offset + args.chunk.len();
    if end > args.message_size as usize {
        return Err(ProgramError::AccountDataTooSmall.into());
    }

    let vaa_body = &mut ctx.accounts.message;
    if vaa_body.span.len() < end {
        vaa_body.span.resize(end, 0);
    }

    vaa_body.span[offset..end].copy_from_slice(&args.chunk);

    Ok(())
}

#[derive(Accounts)]
pub struct CloseUnverifiedMessageAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            VaaBody::SEED_PREFIX,
            &payer.key.to_bytes()
        ],
        bump,
        close = payer
    )]
    pub message: Account<'info, VaaBody>,

    pub system_program: Program<'info, System>,
}

pub fn close_unverified_message_account(
    _ctx: Context<CloseUnverifiedMessageAccount>,
) -> Result<()> {
    Ok(())
}
