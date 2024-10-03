use core::fmt;
use std::{io, marker::PhantomData};

#[cfg(feature = "anchor")]
use anchor_lang::prelude::*;

use wormhole_io::{Readable, TypePrefixedPayload, Writeable};

use crate::{ntt_manager::NttManagerMessage, utils::maybe_space::MaybeSpace};

pub trait Transceiver {
    const PREFIX: [u8; 4];
}

#[derive(Debug, PartialEq, Eq, Clone)]
#[cfg_attr(
    feature = "anchor",
    derive(AnchorSerialize, AnchorDeserialize, InitSpace)
)]
pub struct TransceiverMessageData<A: MaybeSpace> {
    pub source_ntt_manager: [u8; 32],
    pub recipient_ntt_manager: [u8; 32],
    pub ntt_manager_payload: NttManagerMessage<A>,
}

/// This struct is for zero-copy deserialization of
/// `ValidatedTransceiverMessage::message()` in the redeem ix
pub struct TransceiverMessageDataBytes<'a, A: MaybeSpace> {
    _phantom: PhantomData<A>,
    span: &'a [u8],
}

impl<A: MaybeSpace> AsRef<[u8]> for TransceiverMessageDataBytes<'_, A> {
    fn as_ref(&self) -> &[u8] {
        self.span
    }
}

impl<'a, A: MaybeSpace> TransceiverMessageDataBytes<'a, A> {
    pub fn source_ntt_manager(&self) -> [u8; 32] {
        self.span[..32].try_into().unwrap()
    }

    pub fn recipient_ntt_manager(&self) -> [u8; 32] {
        self.span[32..64].try_into().unwrap()
    }

    pub fn ntt_manager_payload(&self) -> NttManagerMessage<A>
    where
        A: AnchorDeserialize,
    {
        NttManagerMessage::deserialize(&mut &self.span[64..]).unwrap()
    }

    pub fn parse(span: &'a [u8]) -> TransceiverMessageDataBytes<'a, A> {
        TransceiverMessageDataBytes {
            _phantom: PhantomData,
            span,
        }
    }
}

#[derive(Eq, PartialEq, Clone, Debug)]
pub struct TransceiverMessage<E: Transceiver, A: MaybeSpace> {
    _phantom: PhantomData<E>,
    // TODO: check peer registration at the ntt_manager level
    pub message_data: TransceiverMessageData<A>,
    pub transceiver_payload: Vec<u8>,
}

impl<E: Transceiver, A: MaybeSpace> std::ops::Deref for TransceiverMessage<E, A> {
    type Target = TransceiverMessageData<A>;

    fn deref(&self) -> &Self::Target {
        &self.message_data
    }
}

impl<E: Transceiver, A: MaybeSpace> std::ops::DerefMut for TransceiverMessage<E, A> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.message_data
    }
}

#[cfg(feature = "anchor")]
impl<E: Transceiver, A: TypePrefixedPayload> AnchorDeserialize for TransceiverMessage<E, A>
where
    A: MaybeSpace,
{
    fn deserialize_reader<R: io::Read>(reader: &mut R) -> io::Result<Self> {
        Readable::read(reader)
    }
}

#[cfg(feature = "anchor")]
impl<E: Transceiver, A: TypePrefixedPayload> AnchorSerialize for TransceiverMessage<E, A>
where
    A: MaybeSpace,
{
    fn serialize<W: io::Write>(&self, writer: &mut W) -> io::Result<()> {
        Writeable::write(self, writer)
    }
}

impl<E: Transceiver, A> TransceiverMessage<E, A>
where
    A: MaybeSpace,
{
    pub fn new(
        source_ntt_manager: [u8; 32],
        recipient_ntt_manager: [u8; 32],
        ntt_manager_payload: NttManagerMessage<A>,
        transceiver_payload: Vec<u8>,
    ) -> Self {
        Self {
            _phantom: PhantomData,
            message_data: TransceiverMessageData {
                source_ntt_manager,
                recipient_ntt_manager,
                ntt_manager_payload,
            },
            transceiver_payload,
        }
    }
}

impl<A: TypePrefixedPayload, E: Transceiver + Clone + fmt::Debug> TypePrefixedPayload
    for TransceiverMessage<E, A>
where
    A: MaybeSpace + Clone,
{
    const TYPE: Option<u8> = None;
}

impl<E: Transceiver, A: TypePrefixedPayload> Readable for TransceiverMessage<E, A>
where
    A: MaybeSpace,
{
    const SIZE: Option<usize> = None;

    fn read<R>(reader: &mut R) -> io::Result<Self>
    where
        Self: Sized,
        R: io::Read,
    {
        let prefix: [u8; 4] = Readable::read(reader)?;
        if prefix != E::PREFIX {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid prefix for TransceiverMessage",
            ));
        }

        let source_ntt_manager = Readable::read(reader)?;
        let recipient_ntt_manager = Readable::read(reader)?;
        // TODO: we need a way to easily check that decoding the payload
        // consumes the expected amount of bytes
        let _ntt_manager_payload_len: u16 = Readable::read(reader)?;
        let ntt_manager_payload = NttManagerMessage::read(reader)?;
        let transceiver_payload_len: u16 = Readable::read(reader)?;
        let mut transceiver_payload = vec![0; transceiver_payload_len as usize];
        reader.read_exact(&mut transceiver_payload)?;

        Ok(TransceiverMessage::new(
            source_ntt_manager,
            recipient_ntt_manager,
            ntt_manager_payload,
            transceiver_payload,
        ))
    }
}

impl<E: Transceiver, A: TypePrefixedPayload> Writeable for TransceiverMessage<E, A>
where
    A: MaybeSpace,
{
    fn written_size(&self) -> usize {
        4 // prefix
        + self.source_ntt_manager.len()
        + u16::SIZE.unwrap() // length prefix
        + self.ntt_manager_payload.written_size()
    }

    fn write<W>(&self, writer: &mut W) -> io::Result<()>
    where
        W: io::Write,
    {
        let TransceiverMessage {
            _phantom,
            message_data:
                TransceiverMessageData {
                    source_ntt_manager,
                    recipient_ntt_manager,
                    ntt_manager_payload,
                },
            transceiver_payload,
        } = self;

        E::PREFIX.write(writer)?;
        source_ntt_manager.write(writer)?;
        recipient_ntt_manager.write(writer)?;
        let len: u16 = u16::try_from(ntt_manager_payload.written_size()).expect("u16 overflow");
        len.write(writer)?;
        // TODO: review this in wormhole-io. The written_size logic is error prone. Instead,
        // a better API would be
        // foo.write_with_prefix_be::<u16>(writer)
        // which writes the length as a big endian u16.
        ntt_manager_payload.write(writer)?;
        let len: u16 = u16::try_from(transceiver_payload.len()).expect("u16 overflow");
        len.write(writer)?;
        writer.write_all(transceiver_payload)?;
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use crate::{
        chain_id::ChainId, ntt::EmptyPayload, ntt::NativeTokenTransfer,
        transceivers::wormhole::WormholeTransceiver, trimmed_amount::TrimmedAmount,
    };

    use super::*;
    //
    #[test]
    fn test_deserialize_transceiver_message() {
        let data = hex::decode(
            include_str!("../../../../evm/test/payloads/transceiver_message_1.txt").trim_end(),
        )
        .unwrap();
        let mut vec = &data[..];
        let message: TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<EmptyPayload>> =
            TypePrefixedPayload::read_payload(&mut vec).unwrap();

        let expected = TransceiverMessage {
            _phantom: PhantomData::<WormholeTransceiver>,
            message_data: TransceiverMessageData {
                source_ntt_manager: [
                    0x04, 0x29, 0x42, 0xFA, 0xFA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
                recipient_ntt_manager: [
                    0x04, 0x29, 0x42, 0xFA, 0xBA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
                ntt_manager_payload: NttManagerMessage {
                    id: [
                        0x12, 0x84, 0x34, 0xBA, 0xFE, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0xCE, 0, 0xAA, 0, 0, 0, 0, 0,
                    ],
                    sender: [
                        0x46, 0x67, 0x92, 0x13, 0x41, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    ],
                    payload: NativeTokenTransfer {
                        amount: TrimmedAmount {
                            amount: 1234567,
                            decimals: 7,
                        },
                        source_token: [
                            0xBE, 0xEF, 0xFA, 0xCE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ],
                        to_chain: ChainId { id: 17 },
                        to: [
                            0xFE, 0xEB, 0xCA, 0xFE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ],
                        additional_payload: EmptyPayload {},
                    },
                },
            },
            transceiver_payload: vec![],
        };
        assert_eq!(message, expected);
        assert_eq!(vec.len(), 0);

        let encoded = TypePrefixedPayload::to_vec_payload(&expected);
        assert_eq!(encoded, data);
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    #[cfg_attr(
        feature = "anchor",
        derive(AnchorSerialize, AnchorDeserialize, InitSpace)
    )]
    pub struct EmptyMockPayload {}

    impl EmptyMockPayload {
        const PREFIX: [u8; 0] = [];
    }

    impl TypePrefixedPayload for EmptyMockPayload {
        const TYPE: Option<u8> = None;
    }

    impl Readable for EmptyMockPayload {
        // This will cause the size to be written, since it is not explicitly 0
        const SIZE: Option<usize> = None;

        fn read<R>(_reader: &mut R) -> io::Result<Self>
        where
            Self: Sized,
            R: io::Read,
        {
            Ok(Self {})
        }
    }

    impl Writeable for EmptyMockPayload {
        fn written_size(&self) -> usize {
            Self::PREFIX.len()
        }

        fn write<W>(&self, _writer: &mut W) -> io::Result<()>
        where
            W: io::Write,
        {
            Ok(())
        }
    }

    #[test]
    fn test_deserialize_transceiver_message_with_empty_payload() {
        let data = hex::decode(
            include_str!(
                "../../../../evm/test/payloads/transceiver_message_with_empty_payload.txt"
            )
            .trim_end(),
        )
        .unwrap();
        let mut vec = &data[..];
        let message: TransceiverMessage<
            WormholeTransceiver,
            NativeTokenTransfer<EmptyMockPayload>,
        > = TypePrefixedPayload::read_payload(&mut vec).unwrap();

        let expected = TransceiverMessage {
            _phantom: PhantomData::<WormholeTransceiver>,
            message_data: TransceiverMessageData {
                source_ntt_manager: [
                    0x04, 0x29, 0x42, 0xFA, 0xFA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
                recipient_ntt_manager: [
                    0x04, 0x29, 0x42, 0xFA, 0xBA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
                ntt_manager_payload: NttManagerMessage {
                    id: [
                        0x12, 0x84, 0x34, 0xBA, 0xFE, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0xCE, 0, 0xAA, 0, 0, 0, 0, 0,
                    ],
                    sender: [
                        0x46, 0x67, 0x92, 0x13, 0x41, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    ],
                    payload: NativeTokenTransfer {
                        amount: TrimmedAmount {
                            amount: 1234567,
                            decimals: 7,
                        },
                        source_token: [
                            0xBE, 0xEF, 0xFA, 0xCE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ],
                        to_chain: ChainId { id: 17 },
                        to: [
                            0xFE, 0xEB, 0xCA, 0xFE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ],
                        additional_payload: EmptyMockPayload {},
                    },
                },
            },
            transceiver_payload: vec![],
        };
        assert_eq!(message, expected);
        assert_eq!(vec.len(), 0);

        let encoded = TypePrefixedPayload::to_vec_payload(&expected);
        assert_eq!(encoded, data);
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    #[cfg_attr(
        feature = "anchor",
        derive(AnchorSerialize, AnchorDeserialize, InitSpace)
    )]
    pub struct MockPayload {
        hash: [u8; 32],
    }

    impl MockPayload {
        const PREFIX: [u8; 0] = [];
    }

    impl TypePrefixedPayload for MockPayload {
        const TYPE: Option<u8> = None;
    }

    impl Readable for MockPayload {
        const SIZE: Option<usize> = None;

        fn read<R>(reader: &mut R) -> io::Result<Self>
        where
            Self: Sized,
            R: io::Read,
        {
            let hash: [u8; 32] = Readable::read(reader)?;
            Ok(Self { hash })
        }
    }

    impl Writeable for MockPayload {
        fn written_size(&self) -> usize {
            Self::PREFIX.len() + <[u8; 32]>::SIZE.unwrap() // hash
        }

        fn write<W>(&self, writer: &mut W) -> io::Result<()>
        where
            W: io::Write,
        {
            let MockPayload { hash } = self;

            Self::PREFIX.write(writer)?;
            hash.write(writer)?;
            Ok(())
        }
    }

    #[test]
    fn test_deserialize_transceiver_message_with_32byte_payload() {
        let data = hex::decode(
            include_str!(
                "../../../../evm/test/payloads/transceiver_message_with_32byte_payload.txt"
            )
            .trim_end(),
        )
        .unwrap();
        let mut vec = &data[..];
        let message: TransceiverMessage<WormholeTransceiver, NativeTokenTransfer<MockPayload>> =
            TypePrefixedPayload::read_payload(&mut vec).unwrap();

        let expected = TransceiverMessage {
            _phantom: PhantomData::<WormholeTransceiver>,
            message_data: TransceiverMessageData {
                source_ntt_manager: [
                    0x04, 0x29, 0x42, 0xFA, 0xFA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
                recipient_ntt_manager: [
                    0x04, 0x29, 0x42, 0xFA, 0xBA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
                ntt_manager_payload: NttManagerMessage {
                    id: [
                        0x12, 0x84, 0x34, 0xBA, 0xFE, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0xCE, 0, 0xAA, 0, 0, 0, 0, 0,
                    ],
                    sender: [
                        0x46, 0x67, 0x92, 0x13, 0x41, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    ],
                    payload: NativeTokenTransfer {
                        amount: TrimmedAmount {
                            amount: 1234567,
                            decimals: 7,
                        },
                        source_token: [
                            0xBE, 0xEF, 0xFA, 0xCE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ],
                        to_chain: ChainId { id: 17 },
                        to: [
                            0xFE, 0xEB, 0xCA, 0xFE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ],
                        additional_payload: MockPayload {
                            hash: [
                                0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xDE, 0xAD, 0xBE, 0xEF,
                            ],
                        },
                    },
                },
            },
            transceiver_payload: vec![],
        };
        assert_eq!(message, expected);
        assert_eq!(vec.len(), 0);

        let encoded = TypePrefixedPayload::to_vec_payload(&expected);
        assert_eq!(encoded, data);
    }
}
