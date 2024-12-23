use anchor_lang::{prelude::*, solana_program::program_pack::Pack, Ids, Owners};
use anchor_spl::token_interface::TokenInterface;
use std::ops::Deref;

/// Anchor does not have a SPL Multisig wrapper as a part of the token interface:
/// https://docs.rs/anchor-spl/0.29.0/src/anchor_spl/token_interface.rs.html
/// Thus, we have to write our own wrapper to use with `InterfaceAccount`

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SplMultisig(spl_token_2022::state::Multisig);

impl AccountDeserialize for SplMultisig {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        Ok(SplMultisig(spl_token_2022::state::Multisig::unpack(buf)?))
    }
}

impl AccountSerialize for SplMultisig {}

impl Owners for SplMultisig {
    fn owners() -> &'static [Pubkey] {
        TokenInterface::ids()
    }
}

impl Deref for SplMultisig {
    type Target = spl_token_2022::state::Multisig;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for SplMultisig {}
