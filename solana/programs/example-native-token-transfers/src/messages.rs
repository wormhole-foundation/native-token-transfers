use anchor_lang::{prelude::*, system_program, Discriminator};
use ntt_messages::{
    chain_id::ChainId,
    transceiver::{TransceiverMessageData, TransceiverMessageDataBytes},
};
use std::{collections::HashMap, marker::PhantomData};

#[account]
#[derive(InitSpace)]
pub struct ValidatedTransceiverMessage<A: AnchorDeserialize + AnchorSerialize + Space + Clone> {
    pub from_chain: ChainId,
    pub message: TransceiverMessageData<A>,
}

impl<A: AnchorDeserialize + AnchorSerialize + Space + Clone> ValidatedTransceiverMessage<A> {
    pub const SEED_PREFIX: &'static [u8] = b"transceiver_message";

    pub fn discriminator_check(data: &[u8]) -> Result<()> {
        if data.len() < Self::DISCRIMINATOR.len() {
            return Err(ErrorCode::AccountDiscriminatorNotFound.into());
        }
        let given_disc = &data[..8];
        if Self::DISCRIMINATOR != given_disc {
            return Err(ErrorCode::AccountDiscriminatorMismatch.into());
        }
        Ok(())
    }

    pub fn try_from(info: &UncheckedAccount, expected_owner: &Pubkey) -> Result<Self> {
        if info.owner == &system_program::ID && info.lamports() == 0 {
            return Err(ErrorCode::AccountNotInitialized.into());
        }
        if *info.owner != *expected_owner {
            return Err(Error::from(ErrorCode::AccountOwnedByWrongProgram)
                .with_pubkeys((*info.owner, *expected_owner)));
        }
        let mut data: &[u8] = &info.try_borrow_data()?;
        ValidatedTransceiverMessage::try_deserialize(&mut data)
    }

    pub fn from_chain(info: &UncheckedAccount) -> Result<ChainId> {
        let data: &[u8] = &info.try_borrow_data().unwrap();
        Self::discriminator_check(data)?;
        Ok(ChainId {
            // This is LE bytes because we deserialize using Borsh.
            // Not to be confused with the wire format (which is BE bytes)
            id: u16::from_le_bytes(data[8..10].try_into().unwrap()),
        })
    }

    pub fn message(data: &[u8]) -> Result<TransceiverMessageDataBytes<A>> {
        Self::discriminator_check(data)?;
        Ok(TransceiverMessageDataBytes::parse(&data[10..]))
    }
}

// This is a hack to get around the fact that the IDL generator doesn't support
// PhantomData. The generator uses the following functions, so we just mix them onto PhantomData.
//
// These types are technically more general than the actual ones, but we can't
// import the actual types from anchor-syn because that crate has a bug where it
// doesn't build against the solana bpf target (due to a missing function).
// Luckily, we don't need to reference those types, as we just want to omit PhantomData from the IDL anyway.
pub trait Hack {
    fn __anchor_private_full_path() -> String;
    fn __anchor_private_insert_idl_defined<A>(_a: &mut HashMap<String, A>);
    fn __anchor_private_gen_idl_type<A>() -> Option<A>;
}

impl<D> Hack for PhantomData<D> {
    fn __anchor_private_full_path() -> String {
        String::new()
    }
    fn __anchor_private_insert_idl_defined<A>(_a: &mut HashMap<String, A>) {}
    fn __anchor_private_gen_idl_type<A>() -> Option<A> {
        None
    }
}

impl Hack for ProgramData {
    fn __anchor_private_full_path() -> String {
        String::new()
    }
    fn __anchor_private_insert_idl_defined<A>(_a: &mut HashMap<String, A>) {}
    fn __anchor_private_gen_idl_type<A>() -> Option<A> {
        None
    }
}
