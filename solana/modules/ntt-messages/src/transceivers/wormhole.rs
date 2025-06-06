#[cfg(feature = "anchor")]
use std::io;

use wormhole_io::{Readable, TypePrefixedPayload, Writeable};

#[cfg(feature = "anchor")]
use anchor_lang::prelude::*;

use crate::{chain_id::ChainId, mode::Mode, transceiver::Transceiver};

#[derive(PartialEq, Eq, Clone, Debug)]
pub struct WormholeTransceiver {}

impl Transceiver for WormholeTransceiver {
    const PREFIX: [u8; 4] = [0x99, 0x45, 0xFF, 0x10];
}

impl WormholeTransceiver {
    pub const INFO_PREFIX: [u8; 4] = [0x9c, 0x23, 0xbd, 0x3b];

    pub const PEER_INFO_PREFIX: [u8; 4] = [0x18, 0xfc, 0x67, 0xc2];
}

// * Transceiver info

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WormholeTransceiverInfo {
    pub manager_address: [u8; 32],
    pub manager_mode: Mode,
    pub token_address: [u8; 32],
    pub token_decimals: u8,
}

#[cfg(feature = "anchor")]
impl AnchorDeserialize for WormholeTransceiverInfo {
    fn deserialize_reader<R: io::Read>(reader: &mut R) -> io::Result<Self> {
        Readable::read(reader)
    }
}

#[cfg(feature = "anchor")]
impl AnchorSerialize for WormholeTransceiverInfo {
    fn serialize<W: io::Write>(&self, writer: &mut W) -> io::Result<()> {
        Writeable::write(self, writer)
    }
}

impl Readable for WormholeTransceiverInfo {
    const SIZE: Option<usize> = Some(32 + 1 + 32 + 1);

    fn read<R>(reader: &mut R) -> std::io::Result<Self>
    where
        Self: Sized,
        R: std::io::Read,
    {
        let prefix = <[u8; 4]>::read(reader)?;
        if prefix != WormholeTransceiver::INFO_PREFIX {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid prefix",
            ));
        }

        let manager_address = <[u8; 32]>::read(reader)?;
        let manager_mode = Mode::read(reader)?;
        let token_address = <[u8; 32]>::read(reader)?;
        let token_decimals = u8::read(reader)?;

        Ok(WormholeTransceiverInfo {
            manager_address,
            manager_mode,
            token_address,
            token_decimals,
        })
    }
}

impl Writeable for WormholeTransceiverInfo {
    fn written_size(&self) -> usize {
        WormholeTransceiver::INFO_PREFIX.len() + WormholeTransceiverInfo::SIZE.unwrap()
    }

    fn write<W>(&self, writer: &mut W) -> std::io::Result<()>
    where
        W: std::io::Write,
    {
        WormholeTransceiver::INFO_PREFIX.write(writer)?;
        self.manager_address.write(writer)?;
        self.manager_mode.write(writer)?;
        self.token_address.write(writer)?;
        self.token_decimals.write(writer)
    }
}

impl TypePrefixedPayload for WormholeTransceiverInfo {
    const TYPE: Option<u8> = None;
}

// * Transceiver registration

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WormholeTransceiverRegistration {
    pub chain_id: ChainId,
    pub transceiver_address: [u8; 32],
}

#[cfg(feature = "anchor")]
impl AnchorDeserialize for WormholeTransceiverRegistration {
    fn deserialize_reader<R: io::Read>(reader: &mut R) -> io::Result<Self> {
        Readable::read(reader)
    }
}

#[cfg(feature = "anchor")]
impl AnchorSerialize for WormholeTransceiverRegistration {
    fn serialize<W: io::Write>(&self, writer: &mut W) -> io::Result<()> {
        Writeable::write(self, writer)
    }
}

impl Readable for WormholeTransceiverRegistration {
    const SIZE: Option<usize> = Some(2 + 32);

    fn read<R>(reader: &mut R) -> std::io::Result<Self>
    where
        Self: Sized,
        R: std::io::Read,
    {
        let prefix = <[u8; 4]>::read(reader)?;
        if prefix != WormholeTransceiver::PEER_INFO_PREFIX {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid prefix",
            ));
        }

        let chain_id = ChainId::read(reader)?;
        let transceiver_address = <[u8; 32]>::read(reader)?;

        Ok(WormholeTransceiverRegistration {
            chain_id,
            transceiver_address,
        })
    }
}

impl Writeable for WormholeTransceiverRegistration {
    fn written_size(&self) -> usize {
        WormholeTransceiver::PEER_INFO_PREFIX.len() + WormholeTransceiverRegistration::SIZE.unwrap()
    }

    fn write<W>(&self, writer: &mut W) -> std::io::Result<()>
    where
        W: std::io::Write,
    {
        WormholeTransceiver::PEER_INFO_PREFIX.write(writer)?;
        self.chain_id.write(writer)?;
        self.transceiver_address.write(writer)
    }
}

impl TypePrefixedPayload for WormholeTransceiverRegistration {
    const TYPE: Option<u8> = None;
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_deserialize_transceiver_info() {
        let data = hex::decode(
            include_str!("../../../../../evm/test/payloads/transceiver_info_1.txt").trim_end(),
        )
        .unwrap();
        let mut vec = &data[..];
        let message: WormholeTransceiverInfo = TypePrefixedPayload::read_payload(&mut vec).unwrap();

        let expected = WormholeTransceiverInfo {
            manager_address: [
                0xBA, 0xBA, 0xBA, 0xBA, 0xBA, 0xBA, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00,
            ],
            manager_mode: Mode::Locking,
            token_address: [
                0xDE, 0xDE, 0xDE, 0xDE, 0xDE, 0xDE, 0xDE, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00,
            ],
            token_decimals: 16,
        };
        assert_eq!(message, expected);
        assert_eq!(vec.len(), 0);

        let encoded = TypePrefixedPayload::to_vec_payload(&expected);
        assert_eq!(encoded, data);
    }

    #[test]
    fn test_deserialize_transceiver_registration() {
        let data = hex::decode(
            include_str!("../../../../../evm/test/payloads/transceiver_registration_1.txt")
                .trim_end(),
        )
        .unwrap();
        let mut vec = &data[..];
        let message: WormholeTransceiverRegistration =
            TypePrefixedPayload::read_payload(&mut vec).unwrap();

        let expected = WormholeTransceiverRegistration {
            chain_id: ChainId { id: 23 },
            transceiver_address: [
                0xBA, 0xBA, 0xBA, 0xFE, 0xFE, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00,
            ],
        };
        assert_eq!(message, expected);
        assert_eq!(vec.len(), 0);

        let encoded = TypePrefixedPayload::to_vec_payload(&expected);
        assert_eq!(encoded, data);
    }
}
