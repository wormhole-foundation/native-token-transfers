module ntt_common::transceiver_message_data {
    use wormhole::bytes;
    use wormhole::cursor::Cursor;
    use wormhole::external_address::{Self, ExternalAddress};
    use ntt_common::ntt_manager_message::{Self, NttManagerMessage};

    #[error]
    const EIncorrectPayloadLength: vector<u8>
        = b"incorrect payload length";

    public struct TransceiverMessageData<A> has drop, copy {
        source_ntt_manager_address: ExternalAddress,
        recipient_ntt_manager_address: ExternalAddress,
        ntt_manager_payload: NttManagerMessage<A>,
    }

    public fun new<A>(
        source_ntt_manager_address: ExternalAddress,
        recipient_ntt_manager_address: ExternalAddress,
        ntt_manager_payload: NttManagerMessage<A>
    ): TransceiverMessageData<A> {
        TransceiverMessageData {
            source_ntt_manager_address,
            recipient_ntt_manager_address,
            ntt_manager_payload
        }
    }

    public fun destruct<A>(
        message_data: TransceiverMessageData<A>
    ): (
        ExternalAddress,
        ExternalAddress,
        NttManagerMessage<A>
    ) {
        let TransceiverMessageData {
            source_ntt_manager_address,
            recipient_ntt_manager_address,
            ntt_manager_payload
        } = message_data;

        (source_ntt_manager_address, recipient_ntt_manager_address, ntt_manager_payload)
    }

    public macro fun map<$A, $B>(
        $message_data: TransceiverMessageData<$A>,
        $f: |$A| -> $B
    ): TransceiverMessageData<$B> {
        let (
            source_ntt_manager_address,
            recipient_ntt_manager_address,
            ntt_manager_payload
        ) = destruct($message_data);
        new(
            source_ntt_manager_address,
            recipient_ntt_manager_address,
            ntt_manager_message::map!(ntt_manager_payload, $f)
        )
    }

    public fun to_bytes(
        message_data: TransceiverMessageData<vector<u8>>
    ): vector<u8> {
        let TransceiverMessageData {
            source_ntt_manager_address,
            recipient_ntt_manager_address,
            ntt_manager_payload
        } = message_data;

        let mut buf: vector<u8> = vector::empty<u8>();

        buf.append(source_ntt_manager_address.to_bytes());
        buf.append(recipient_ntt_manager_address.to_bytes());
        bytes::push_u16_be(&mut buf, ntt_manager_payload.to_bytes().length() as u16);
        buf.append(ntt_manager_payload.to_bytes());

        buf
    }

    public fun take_bytes(cur: &mut Cursor<u8>): TransceiverMessageData<vector<u8>> {
        let source_ntt_manager_address = external_address::take_bytes(cur);
        let recipient_ntt_manager_address = external_address::take_bytes(cur);
        let ntt_manager_payload_len = bytes::take_u16_be(cur);
        let remaining = cur.data().length();
        let ntt_manager_payload = ntt_manager_message::take_bytes(cur);
        let bytes_read = remaining - cur.data().length();
        assert!(bytes_read as u16 == ntt_manager_payload_len, EIncorrectPayloadLength);

        TransceiverMessageData {
            source_ntt_manager_address,
            recipient_ntt_manager_address,
            ntt_manager_payload
        }
    }

    public fun parse(data: vector<u8>): TransceiverMessageData<vector<u8>> {
        ntt_common::parse::parse!(data, |x| take_bytes(x))
    }
}

module ntt_common::transceiver_message {
    use wormhole::bytes::{Self};
    use wormhole::cursor::Cursor;
    use ntt_common::bytes4::{Self, Bytes4};
    use ntt_common::transceiver_message_data::{Self, TransceiverMessageData};

    #[error]
    const EIncorrectPrefix: vector<u8>
        = b"incorrect prefix";

    public struct PrefixOf<phantom E> has drop, copy {
        prefix: Bytes4
    }

    public fun prefix<E>(_: &E, prefix: Bytes4): PrefixOf<E> {
        PrefixOf { prefix }
    }

    public struct TransceiverMessage<phantom E, A> has drop, copy {
        message_data: TransceiverMessageData<A>,
        transceiver_payload: vector<u8>
    }

    public fun new<E, A>(
        message_data: TransceiverMessageData<A>,
        transceiver_payload: vector<u8>
    ): TransceiverMessage<E, A> {
        TransceiverMessage {
            message_data,
            transceiver_payload
        }
    }

    public macro fun map<$T, $A, $B>(
        $message_data: TransceiverMessage<$T, $A>,
        $f: |$A| -> $B
    ): TransceiverMessage<$T, $B> {
        let (
            message_data,
            transceiver_payload
        ) = destruct($message_data);
        new(
            transceiver_message_data::map!(message_data, $f),
            transceiver_payload
        )
    }

    public fun destruct<E, A>(
        message: TransceiverMessage<E, A>
    ): (
        TransceiverMessageData<A>,
        vector<u8>
    ) {
        let TransceiverMessage {
            message_data,
            transceiver_payload
        } = message;

        (message_data, transceiver_payload)
    }

    public fun to_bytes<E>(
        message: TransceiverMessage<E, vector<u8>>,
        prefix: PrefixOf<E>,
    ): vector<u8> {
        let TransceiverMessage {
            message_data,
            transceiver_payload
        } = message;

        let mut buf: vector<u8> = vector::empty<u8>();

        buf.append(prefix.prefix.to_bytes());
        buf.append(message_data.to_bytes());
        bytes::push_u16_be(&mut buf, transceiver_payload.length() as u16);
        buf.append(transceiver_payload);

        buf
    }

    public fun take_bytes<E>(
        prefix: PrefixOf<E>,
        cur: &mut Cursor<u8>
    ): TransceiverMessage<E, vector<u8>> {
        let prefix_bytes = bytes4::take(cur);
        assert!(prefix_bytes == prefix.prefix, EIncorrectPrefix);
        let message_data = transceiver_message_data::take_bytes(cur);
        let transceiver_payload_len = bytes::take_u16_be(cur);
        let transceiver_payload = bytes::take_bytes(cur, transceiver_payload_len as u64);

        TransceiverMessage {
            message_data,
            transceiver_payload
        }
    }

    public fun parse<E>(prefix: PrefixOf<E>, data: vector<u8>): TransceiverMessage<E, vector<u8>> {
        ntt_common::parse::parse!(data, |x| take_bytes(prefix, x))
    }
}

#[test_only]
module ntt_common::transceiver_message_tests {
    use wormhole::bytes32;
    use wormhole::external_address;
    use ntt_common::transceiver_message;
    use ntt_common::transceiver_message_data;
    use ntt_common::ntt_manager_message;
    use ntt_common::native_token_transfer::{Self, NativeTokenTransfer};
    use ntt_common::bytes4;
    use ntt_common::trimmed_amount;

    public struct WhTransceiver has drop {}

    #[test]
    public fun test_deserialize_transceiver_message() {
        let data = x"9945ff10042942fafabe0000000000000000000000000000000000000000000000000000042942fababe00000000000000000000000000000000000000000000000000000091128434bafe23430000000000000000000000000000000000ce00aa00000000004667921341234300000000000000000000000000000000000000000000000000004f994e545407000000000012d687beefface00000000000000000000000000000000000000000000000000000000feebcafe0000000000000000000000000000000000000000000000000000000000110000";

        let wh_prefix = transceiver_message::prefix(&WhTransceiver{}, bytes4::from_bytes(x"9945FF10"));

        let message = ntt_common::parse::parse!(data, |x| transceiver_message::take_bytes(wh_prefix, x));
        let message = ntt_common::transceiver_message::map!(message, |x| native_token_transfer::parse(x));

        let expected = transceiver_message::new<WhTransceiver, NativeTokenTransfer>(
            transceiver_message_data::new(
                external_address::new(bytes32::from_bytes(vector[
                    0x04u8, 0x29, 0x42, 0xFA, 0xFA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ])),
                external_address::new(bytes32::from_bytes(vector[
                    0x04, 0x29, 0x42, 0xFA, 0xBA, 0xBE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ])),
                ntt_manager_message::new(
                    bytes32::from_bytes(vector[
                        0x12, 0x84, 0x34, 0xBA, 0xFE, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0xCE, 0, 0xAA, 0, 0, 0, 0, 0,
                    ]),
                    external_address::new(bytes32::from_bytes(vector[
                        0x46, 0x67, 0x92, 0x13, 0x41, 0x23, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    ])),
                    native_token_transfer::new(
                        trimmed_amount::new(
                            1234567,
                            7
                        ),
                        external_address::new(bytes32::from_bytes(vector[
                            0xBE, 0xEF, 0xFA, 0xCE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ])),
                        external_address::new(bytes32::from_bytes(vector[
                            0xFE, 0xEB, 0xCA, 0xFE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        ])),
                        2,
                        option::none()
                    )
                )
            ),
            b""
        );

        assert!(message == expected);

        // roundtrip
        assert!(transceiver_message::map!(expected, |x| native_token_transfer::to_bytes(x)).to_bytes(wh_prefix) == data);
    }
}
