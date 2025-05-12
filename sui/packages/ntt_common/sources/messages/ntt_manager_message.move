module ntt_common::ntt_manager_message {
    use wormhole::bytes::{Self};
    use wormhole::cursor::{Self};
    use wormhole::bytes32::{Self, Bytes32};
    use wormhole::external_address::{Self, ExternalAddress};

    public struct NttManagerMessage<A> has store, copy, drop {
        // unique message identifier
        id: Bytes32,
        // original message sender address.
        sender: ExternalAddress,
        // thing inside
        payload: A,
    }

    const E_PAYLOAD_TOO_LONG: u64 = 0;

    public fun new<A>(
        id: Bytes32,
        sender: ExternalAddress,
        payload: A
    ): NttManagerMessage<A> {
        NttManagerMessage {
            id,
            sender,
            payload
        }
    }

    public fun get_id<A>(
        message: &NttManagerMessage<A>
    ): Bytes32 {
        message.id
    }

    public fun borrow_payload<A>(
        message: &NttManagerMessage<A>
    ): &A {
        &message.payload
    }

    public fun destruct<A>(
        message: NttManagerMessage<A>
    ):(
        Bytes32,
        ExternalAddress,
        A
    ) {
        let NttManagerMessage {
            id,
            sender,
            payload
        } = message;
        (id, sender, payload)
    }

    public fun to_bytes(
        message: NttManagerMessage<vector<u8>>
    ): vector<u8> {
        let NttManagerMessage {id, sender, payload} = message;
        assert!(vector::length(&payload) < (((1<<16)-1) as u64), E_PAYLOAD_TOO_LONG);
        let payload_length = (vector::length(&payload) as u16);

        let mut buf: vector<u8> = vector::empty<u8>();

        vector::append(&mut buf, id.to_bytes());
        vector::append(&mut buf, sender.to_bytes());
        bytes::push_u16_be(&mut buf, payload_length);
        vector::append(&mut buf, payload);

        buf
    }

    public fun take_bytes(cur: &mut cursor::Cursor<u8>): NttManagerMessage<vector<u8>> {
        let id = bytes32::take_bytes(cur);
        let sender = external_address::take_bytes(cur);
        let payload_length = bytes::take_u16_be(cur);
        let payload = bytes::take_bytes(cur, (payload_length as u64));

        NttManagerMessage {
            id,
            sender,
            payload
        }
    }

    public macro fun map<$A, $B>(
        $message: NttManagerMessage<$A>,
        $f: |$A| -> $B
    ): NttManagerMessage<$B> {
        let (id, sender, payload) = destruct($message);
        new(id, sender, $f(payload))
    }

    public fun parse(
        buf: vector<u8>
    ): NttManagerMessage<vector<u8>> {
        ntt_common::parse::parse!(buf, |x| take_bytes(x))
    }
}
