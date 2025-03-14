module ntt::mode {
    use wormhole::cursor;

    #[error]
    const EInvalidMode: vector<u8> =
        b"Invalid mode byte in serialized state.";

    public enum Mode has copy, store, drop {
        Locking,
        Burning
    }

    public fun locking(): Mode {
        Mode::Locking
    }

    public fun burning(): Mode {
        Mode::Burning
    }

    public fun is_locking(mode: &Mode): bool {
        match (mode) {
            Mode::Locking => true,
            _ => false
        }
    }

    public fun is_burning(mode: &Mode): bool {
        match (mode) {
            Mode::Burning => true,
            _ => false
        }
    }

    public fun serialize(mode: Mode): vector<u8> {
        match (mode) {
            Mode::Locking => vector[0],
            Mode::Burning => vector[1]
        }
    }

    public fun take_bytes(cur: &mut cursor::Cursor<u8>): Mode {
        let byte = cur.poke();
        match (byte) {
            0 => Mode::Locking,
            1 => Mode::Burning,
            _ => abort(EInvalidMode)
        }
    }

    public fun parse(buf: vector<u8>): Mode {
        let mut cur = cursor::new(buf);
        let mode = take_bytes(&mut cur);
        cur.destroy_empty();
        mode
    }
}
