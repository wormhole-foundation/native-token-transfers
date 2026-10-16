use std::fmt::Debug;

use anchor_lang::prelude::*;
use ntt_messages::{
    chain_id::ChainId,
    transceiver::{Transceiver, TransceiverMessage, TransceiverMessageData},
    utils::maybe_space::MaybeSpace,
};
use wormhole_io::TypePrefixedPayload;

#[derive(AnchorDeserialize, AnchorSerialize, Default, PartialEq)]
pub struct VaaBodyData {
    pub span: Vec<u8>,
}

impl<'a> AsVaaBodyBytes<'a> for VaaBodyData {
    fn as_vaa_body_bytes(&'a self) -> VaaBodyBytes<'a> {
        VaaBodyBytes { span: &self.span }
    }
}

#[account]
pub struct VaaBody {
    pub span: Vec<u8>,
}

impl VaaBody {
    pub const SEED_PREFIX: &'static [u8] = b"vaa_body";
}

impl<'a> AsVaaBodyBytes<'a> for VaaBody {
    fn as_vaa_body_bytes(&'a self) -> VaaBodyBytes<'a> {
        VaaBodyBytes { span: &self.span }
    }
}

pub struct VaaBodyBytes<'a> {
    pub span: &'a [u8],
}

impl<'a> VaaBodyBytes<'a> {
    pub fn emitter_chain(&self) -> u16 {
        u16::from_be_bytes(self.span[8..10].try_into().unwrap())
    }

    pub fn emitter_address(&self) -> &[u8; 32] {
        self.span[10..42].try_into().unwrap()
    }

    /// The `recipient_ntt_manager` of the wrapped `TransceiverMessage`.
    /// Layout within the VAA body: the Wormhole payload starts at byte 51, then
    /// the `TransceiverMessage` is `prefix[4] ‖ source_ntt_manager[32] ‖
    /// recipient_ntt_manager[32] ‖ payload_len[2] ‖ ntt_manager_payload…`, so
    /// `recipient_ntt_manager` lives at `51 + 4 + 32 = 87..119` (immediately
    /// before [`id`], which the existing `121..153` slice confirms).
    pub fn recipient_ntt_manager(&self) -> &[u8; 32] {
        self.span[87..119].try_into().unwrap()
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
            TransceiverMessage::read_slice(self.message_data())?;
        Ok(transceiver_message.message_data)
    }
}

pub trait AsVaaBodyBytes<'a> {
    fn as_vaa_body_bytes(&'a self) -> VaaBodyBytes<'a>;
}
