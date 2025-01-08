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
        // TODO: custom payload
    }

    public fun new(
        amount: TrimmedAmount,
        source_token: ExternalAddress,
        to: ExternalAddress,
        to_chain: u16
    ): NativeTokenTransfer {
        NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain
        }
    }

    public fun get_to_chain(
        message: &NativeTokenTransfer
    ): u16 {
        message.to_chain
    }

    public fun destruct(
        message: NativeTokenTransfer
    ): (
        TrimmedAmount,
        ExternalAddress,
        ExternalAddress,
        u16,
    ) {
        let NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain
        } = message;
        (amount, source_token, to, to_chain)
    }

    public fun to_bytes(
        message: NativeTokenTransfer
    ): vector<u8> {
        let NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain
        } = message;

        let mut buf = vector::empty<u8>();

        buf.append(NTT_PREFIX);
        buf.append(amount.to_bytes());
        buf.append(source_token.to_bytes());
        buf.append(to.to_bytes());
        bytes::push_u16_be(&mut buf, to_chain);

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

        NativeTokenTransfer {
            amount,
            source_token,
            to,
            to_chain
        }
    }

    public fun parse(buf: vector<u8>): NativeTokenTransfer {
        ntt_common::parse::parse!(buf, |x| take_bytes(x))
    }
}
