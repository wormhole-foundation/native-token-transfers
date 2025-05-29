// TODO: review this is correct (should be same as bytes32)
module ntt_common::bytes4 {
    use wormhole::bytes::{Self};
    use wormhole::cursor::{Cursor};

    // Invalid vector<u8> length to create `Bytes4`.
    const E_INVALID_BYTES4: u64 = 0;
    // Found non-zero bytes when attempting to trim `vector<u8>`.
    const E_CANNOT_TRIM_NONZERO: u64 = 1;

    const LEN: u64 = 4;

    /// Container for `vector<u8>`, which has length == 4.
    public struct Bytes4 has copy, drop, store {
        data: vector<u8>
    }

    public fun length(): u64 {
        LEN
    }

    /// Create new `Bytes4`, which checks the length of input `data`.
    public fun new(data: vector<u8>): Bytes4 {
        assert!(is_valid(&data), E_INVALID_BYTES4);
        Bytes4 { data }
    }

    /// Create new `Bytes4` of all zeros.
    public fun default(): Bytes4 {
        let mut data = vector::empty();
        let mut i = 0;
        while (i < LEN) {
            vector::push_back(&mut data, 0);
            i = i + 1;
        };
        new(data)
    }

    /// Retrieve underlying `data`.
    public fun data(self: &Bytes4): vector<u8> {
        self.data
    }

    /// Either trim or pad (depending on length of the input `vector<u8>`) to 4
    /// bytes.
    public fun from_bytes(mut buf: vector<u8>): Bytes4 {
        let len = vector::length(&buf);
        if (len > LEN) {
            trim_nonzero_left(&mut buf);
            new(buf)
        } else {
            new(pad_right(&buf, false))
        }
    }

    /// Destroy `Bytes4` for its underlying data.
    public fun to_bytes(value: Bytes4): vector<u8> {
        let Bytes4 { data } = value;
        data
    }

    /// Drain 4 elements of `Cursor<u8>` to create `Bytes20`.
    public fun take(cur: &mut Cursor<u8>): Bytes4 {
        new(bytes::take_bytes(cur, LEN))
    }

    /// Validate that any of the bytes in underlying data is non-zero.
    public fun is_nonzero(self: &Bytes4): bool {
        let mut i = 0;
        while (i < LEN) {
            if (*vector::borrow(&self.data, i) > 0) {
                return true
            };
            i = i + 1;
        };

        false
    }

    /// Check that the input data is correct length.
    fun is_valid(data: &vector<u8>): bool {
        vector::length(data) == LEN
    }

    /// For vector size less than 4, add zeros to the right.
    fun pad_right(data: &vector<u8>, data_reversed: bool): vector<u8> {
        let mut out = vector::empty();
        let len = vector::length(data);

        if (data_reversed) {
            let mut i = 0;
            while (i < len) {
                vector::push_back(
                    &mut out,
                    *vector::borrow(data, len - i - 1)
                );
                i = i + 1;
            };
        } else {
            vector::append(&mut out, *data);
        };

        let mut i = len;
        while (i < LEN) {
            vector::push_back(&mut out, 0);
            i = i + 1;
        };

        out
    }

    /// Trim bytes from the left if they are zero. If any of these bytes
    /// are non-zero, abort.
    fun trim_nonzero_left(data: &mut vector<u8>) {
        vector::reverse(data);
        let (mut i, n) = (0, vector::length(data) - LEN);
        while (i < n) {
            assert!(vector::pop_back(data) == 0, E_CANNOT_TRIM_NONZERO);
            i = i + 1;
        };
        vector::reverse(data);
    }
}
