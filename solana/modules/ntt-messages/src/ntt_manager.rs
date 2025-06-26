use std::io;

#[cfg(feature = "anchor")]
use anchor_lang::prelude::*;
use anchor_lang::solana_program;

use wormhole_io::{Readable, TypePrefixedPayload, Writeable};

use crate::utils::maybe_space::MaybeSpace;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "anchor",
    derive(AnchorSerialize, AnchorDeserialize, InitSpace)
)]
pub struct NttManagerMessage<A: MaybeSpace> {
    pub id: [u8; 32],
    pub sender: [u8; 32],
    pub payload: A,
}

#[cfg(feature = "hash")]
impl<A: MaybeSpace> NttManagerMessage<A>
where
    NttManagerMessage<A>: TypePrefixedPayload,
{
    pub fn keccak256(&self, chain_id: crate::chain_id::ChainId) -> solana_program::keccak::Hash {
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(&chain_id.id.to_be_bytes());
        bytes.extend_from_slice(&TypePrefixedPayload::to_vec_payload(self));
        solana_program::keccak::hash(&bytes)
    }
}

impl<A: TypePrefixedPayload + MaybeSpace> TypePrefixedPayload for NttManagerMessage<A> {
    const TYPE: Option<u8> = None;
}

impl<A: TypePrefixedPayload + MaybeSpace> Readable for NttManagerMessage<A> {
    const SIZE: Option<usize> = None;

    fn read<R>(reader: &mut R) -> io::Result<Self>
    where
        Self: Sized,
        R: io::Read,
    {
        let id = Readable::read(reader)?;
        let sender = Readable::read(reader)?;
        // TODO: ditto todo in transceiver.rs
        let _payload_len: u16 = Readable::read(reader)?;
        let payload = A::read_payload(reader)?;

        Ok(Self {
            id,
            sender,
            payload,
        })
    }
}

impl<A: TypePrefixedPayload + MaybeSpace> Writeable for NttManagerMessage<A> {
    fn written_size(&self) -> usize {
        self.id.len()
            + self.sender.len()
            + u16::SIZE.unwrap() // payload length
            + self.payload.written_size()
    }

    fn write<W>(&self, writer: &mut W) -> io::Result<()>
    where
        W: io::Write,
    {
        let NttManagerMessage {
            id,
            sender,
            payload,
        } = self;

        id.write(writer)?;
        writer.write_all(sender)?;
        let len: u16 = u16::try_from(payload.written_size()).expect("u16 overflow");
        len.write(writer)?;
        // TODO: ditto todo in transceiver.rs
        A::write_payload(payload, writer)
    }
}
