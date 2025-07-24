use std::{fmt::Debug, ops::Deref};

use anchor_lang::prelude::*;
use ntt_messages::{
    chain_id::ChainId,
    transceiver::{Transceiver, TransceiverMessage, TransceiverMessageData},
    utils::maybe_space::MaybeSpace,
};
use wormhole_io::TypePrefixedPayload;

#[derive(AnchorDeserialize, AnchorSerialize, Debug, Default, PartialEq)]
pub struct VaaBody {
    pub span: Vec<u8>,
}

impl Deref for VaaBody {
    type Target = Vec<u8>;

    fn deref(&self) -> &Self::Target {
        &self.span
    }
}

impl VaaBody {
    pub fn emitter_chain(&self) -> u16 {
        u16::from_be_bytes(self.span[8..10].try_into().unwrap())
    }

    pub fn emitter_address(&self) -> &[u8; 32] {
        self.span[10..42].try_into().unwrap()
    }

    pub fn id(&self) -> &[u8; 32] {
        self.span[121..153].try_into().unwrap()
    }

    pub fn to_chain(&self) -> ChainId {
        ChainId {
            id: u16::from_be_bytes(self.span[264..266].try_into().unwrap()),
        }
    }

    fn message_data(&self) -> &[u8] {
        &self.span[51..]
    }

    pub fn transceiver_message_data<
        E: Transceiver + Debug + Clone,
        A: TypePrefixedPayload + MaybeSpace,
    >(
        &self,
    ) -> Result<TransceiverMessageData<A>> {
        let transceiver_message: TransceiverMessage<E, A> =
            TransceiverMessage::read_slice(&self.message_data())?;
        Ok(transceiver_message.message_data)
    }
}
