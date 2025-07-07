#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("wgvEiKVzX9yyEoh41jZAdC6JqGUTS4CFXbFGBV5TKdZ");

pub mod error;
pub mod instructions;

use instructions::*;

#[program]
pub mod wormhole_governance {
    use super::*;

    pub fn governance<'info>(ctx: Context<'_, '_, '_, 'info, Governance<'info>>) -> Result<()> {
        instructions::governance(ctx)
    }
}
