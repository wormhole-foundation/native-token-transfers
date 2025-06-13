module ntt_common::native_token_transfer {
    use wormhole::bytes;
    use wormhole::cursor::Cursor;
    use ntt_common::bytes4::{Self};
    use ntt_common::trimmed_amount::{Self, TrimmedAmount};
    use wormhole::external_address::{Self, ExternalAddress};

    /// Prefix for all NativeTokenTransfer payloads
    ///      This is 0x99'N''T''T'
    const NTT_PREFIX: vector<u8> = x"994E5454";

    #[error]
    const EIncorrectPrefix: vector<u8>
        = b"incorrect prefix";

    public struct NativeTokenTransfer has copy, store, drop {
        amount: TrimmedAmount,
        source_token: ExternalAddress,
        to: ExternalAddress,
        to_chain: u16,
        payload: Option<vector<u8>>,
    }

    public fun new(
        amount: TrimmedAmount,
        source_token: ExternalAddress,
        to: ExternalAddress,
        to_chain: u16,
        payload: Option<vector<u8>>,
    ): NativeTokenTransfer {
        NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain,
            payload
        }
    }

    public fun get_to_chain(
        message: &NativeTokenTransfer
    ): u16 {
        message.to_chain
    }

    public fun borrow_payload(
        message: &NativeTokenTransfer
    ): &Option<vector<u8>> {
        &message.payload
    }

    public fun destruct(
        message: NativeTokenTransfer
    ): (
        TrimmedAmount,
        ExternalAddress,
        ExternalAddress,
        u16,
        Option<vector<u8>>
    ) {
        let NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain,
            payload
        } = message;
        (amount, source_token, to, to_chain, payload)
    }

    public fun to_bytes(
        message: NativeTokenTransfer
    ): vector<u8> {
        let NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain,
            payload
        } = message;

        let mut buf = vector::empty<u8>();

        buf.append(NTT_PREFIX);
        buf.append(amount.to_bytes());
        buf.append(source_token.to_bytes());
        buf.append(to.to_bytes());
        bytes::push_u16_be(&mut buf, to_chain);
        if (payload.is_some()) {
            let payload = payload.destroy_some();
            bytes::push_u16_be(&mut buf, payload.length() as u16);
            buf.append(payload);
        };

        buf
    }

    public fun take_bytes(cur: &mut Cursor<u8>): NativeTokenTransfer {
        let ntt_prefix = bytes4::take(cur);
        assert!(ntt_prefix.to_bytes() == NTT_PREFIX, EIncorrectPrefix);
        let decimals = bytes::take_u8(cur);
        let amount = bytes::take_u64_be(cur);
        let amount = trimmed_amount::new(amount, decimals);
        let source_token = external_address::take_bytes(cur);
        let to = external_address::take_bytes(cur);
        let to_chain = bytes::take_u16_be(cur);

        let payload = if (!cur.is_empty()) {
            let len = bytes::take_u16_be(cur);
            let payload = bytes::take_bytes(cur, len as u64);
            option::some(payload)
        } else {
            option::none()
        };

        NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain,
            payload
        }
    }

    public fun parse(buf: vector<u8>): NativeTokenTransfer {
        ntt_common::parse::parse!(buf, |x| take_bytes(x))
    }
}
